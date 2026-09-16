'use strict';
/*
 * HTTP + WebSocket listener — the transport substrate.
 *
 * Responsibilities, and nothing more:
 *   - serve /healthz (liveness) and /readyz (readiness) for the ops surface;
 *   - upgrade /ws to a WebSocket, applying the cheap door checks (path, Origin,
 *     frame size) before a connection ever reaches game code;
 *   - hand each accepted socket to `onConnection` as a `{ send, onReceive,
 *     close }` object — which is deliberately the SAME contract MP.Session's
 *     transport wants (mp.js `opts.transport`), so Phase 1's SocketBus is a
 *     thin grouping layer over these rather than a rewrite;
 *   - register its own drain hook so shutdown closes sockets before the port.
 *
 * NO game logic lives here. The default handler (when the caller supplies no
 * onConnection) is a framed PING→PONG echo: enough to prove mp.js framing
 * survives a real WebSocket round-trip, which is the whole point of Phase 0.3.
 *
 * WebSocket — not ES modules or fetch — is what makes this legal from a file://
 * page (root CLAUDE.md), so the browser keeps its zero-build workflow.
 */

var http = require('node:http');
var crypto = require('node:crypto');
var WebSocket = require('ws');

var MP = require('../mp.js');

var WS_PATH = '/ws';

// ===== door checks
// Origin is a hint, not a security boundary (any non-browser client can forge
// it) — real authority arrives in Phase 3, when the server owns the dice. This
// is here to keep a stray web page from opening rooms, cheaply.
//
// A page opened as file:// sends `Origin: null`, and that IS the primary client
// of this game, so an operator's allowlist must be able to name it: put `null`
// in ALLOWED_ORIGINS. Empty allowlist = accept anything (the default).
function originAllowed(allowed, origin) {
  if (!allowed || !allowed.length) return true;
  return allowed.indexOf(origin === undefined ? 'null' : String(origin)) >= 0;
}

// ===== connection wrapper
// Wraps a `ws` socket in the MP.Session transport contract. Kept minimal on
// purpose: send bytes, receive bytes, close. Everything above it (framing,
// session, rules) is shared code that already exists.
function wrapSocket(ws, opts) {
  var log = opts.log;
  var cb = null;
  var closed = false;

  var conn = {
    id: opts.id,
    origin: opts.origin,
    // Session calls send() and expects a promise-ish; ws is fire-and-forget, so
    // resolve on the write callback to surface backpressure errors honestly.
    send: function (bytes) {
      return new Promise(function (resolve, reject) {
        if (closed || ws.readyState !== WebSocket.OPEN) { resolve(); return; }
        ws.send(Buffer.from(bytes.buffer || bytes, bytes.byteOffset || 0, bytes.byteLength || bytes.length),
          { binary: true }, function (err) { err ? reject(err) : resolve(); });
      });
    },
    onReceive: function (fn) { cb = fn; },
    close: function (code, reason) {
      if (closed) return;
      closed = true;
      try { ws.close(code || 1000, reason || ''); } catch (e) { /* already gone */ }
    },
    get closed() { return closed; },
  };

  ws.on('message', function (data, isBinary) {
    // The protocol is binary end to end. A text frame is either a confused
    // client or a probe; either way it is not something to feed the codecs.
    if (!isBinary) { log.debug('dropped a text frame', { conn: conn.id }); return; }
    var bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (cb) {
      // A throw inside a game handler must close one connection, not the server.
      try { cb(bytes); }
      catch (e) { log.error('receive handler threw', { conn: conn.id, err: e }); conn.close(1011, 'handler error'); }
    }
  });

  ws.on('close', function (code) {
    closed = true;
    log.debug('socket closed', { conn: conn.id, code: code });
    if (opts.onClose) opts.onClose(conn, code);
  });

  // 'error' fires for protocol violations and resets. Without this listener ws
  // would re-emit it on the process and kill the server.
  ws.on('error', function (e) { log.warn('socket error', { conn: conn.id, err: e }); });

  return conn;
}

// The Phase 0.3 stand-in for game logic: unframe, and answer a PING with a
// PONG carrying the same payload. Proves the framing survives a real socket.
function echoPingPong(conn, log) {
  var seq = 0;
  conn.onReceive(function (bytes) {
    var f = MP.unframe(bytes);
    // unframe() returns null on a CRC mismatch — "not received" by design.
    if (!f) { log.debug('dropped a corrupt frame', { conn: conn.id, bytes: bytes.length }); return; }
    if (f.type !== MP.T.PING) { log.debug('ignored a frame (no session yet)', { conn: conn.id, type: f.type }); return; }
    conn.send(MP.frame(MP.T.PONG, MP.HOST_ID, seq++ & 0xff, f.payload));
  });
}

// ===== listener

/*
 * opts: { cfg, log, life, onConnection, stats }
 *   onConnection(conn) — Phase 1 plugs SocketBus in here; omitted = ping/pong echo.
 *   stats()            — extra fields for /healthz (Phase 2 reports room counts).
 */
function create(opts) {
  var cfg = opts.cfg;
  var log = opts.log;
  var stats = opts.stats || function () { return {}; };
  var onConnection = opts.onConnection;

  var startedAt = Date.now();
  var conns = new Set();
  var draining = false;

  function health() {
    var s = stats();
    var body = { status: draining ? 'draining' : 'ok', uptimeMs: Date.now() - startedAt, connections: conns.size };
    Object.keys(s).forEach(function (k) { body[k] = s[k]; });
    return body;
  }

  function reply(res, code, body) {
    var json = JSON.stringify(body);
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(json) });
    res.end(json);
  }

  var server = http.createServer(function (req, res) {
    var path = (req.url || '').split('?')[0];
    // Liveness: is the process alive at all? Readiness: should a load balancer
    // still send it traffic? They differ exactly once — while draining, where
    // /readyz must fail so new players land on a healthy instance.
    if (path === '/healthz') return reply(res, 200, health());
    if (path === '/readyz') return reply(res, draining ? 503 : 200, health());
    reply(res, 404, { error: 'not found' });
  });

  // noServer + a manual upgrade handler so the door checks produce a real HTTP
  // response (403/404) instead of an unexplained socket reset.
  var wss = new WebSocket.WebSocketServer({ noServer: true, maxPayload: cfg.maxFrameBytes });

  function refuse(socket, code, text) {
    try { socket.write('HTTP/1.1 ' + code + ' ' + text + '\r\nconnection: close\r\n\r\n'); } catch (e) {}
    try { socket.destroy(); } catch (e) {}
  }

  server.on('upgrade', function (req, socket, head) {
    var path = (req.url || '').split('?')[0];
    if (path !== WS_PATH) { log.debug('upgrade on an unknown path', { path: path }); return refuse(socket, 404, 'Not Found'); }
    var origin = req.headers.origin;
    if (!originAllowed(cfg.allowedOrigins, origin)) {
      log.warn('refused an upgrade from a disallowed origin', { origin: origin === undefined ? null : origin });
      return refuse(socket, 403, 'Forbidden');
    }
    if (draining) { log.debug('refused an upgrade while draining'); return refuse(socket, 503, 'Service Unavailable'); }
    wss.handleUpgrade(req, socket, head, function (ws) { accept(ws, req); });
  });

  function accept(ws, req) {
    var id = crypto.randomUUID().slice(0, 8);
    var conn = wrapSocket(ws, {
      id: id,
      origin: req.headers.origin === undefined ? null : req.headers.origin,
      log: log,
      onClose: function (c) { conns.delete(c); },
    });
    conns.add(conn);
    log.debug('socket accepted', { conn: id, connections: conns.size });
    if (onConnection) onConnection(conn, req);
    else echoPingPong(conn, log);
  }

  function start() {
    return new Promise(function (resolve, reject) {
      server.once('error', reject);
      server.listen(cfg.port, cfg.host, function () {
        server.removeListener('error', reject);
        var a = server.address();
        log.info('listening', { host: a.address, port: a.port, ws: WS_PATH });
        resolve(a);
      });
    });
  }

  // Flip readiness without touching the sockets. Separate from stop() because
  // the order matters to anything in front of the server: /readyz must fail
  // (and new upgrades be refused) BEFORE the port goes away, so a load balancer
  // deregisters this instance instead of routing players into a closing socket.
  // Phase 6.2 adds the deregistration pause between this and stop(); today the
  // gap is zero, but the seam is where it belongs.
  function beginDrain() {
    draining = true;
  }

  // Close sockets first, then the port: a client that gets a close frame can
  // say so on screen, where a dropped TCP connection just freezes the board.
  function stop() {
    beginDrain();
    conns.forEach(function (c) { c.close(1001, 'server shutting down'); });
    conns.clear();
    return new Promise(function (resolve) {
      wss.close(function () { server.close(function () { log.info('listener closed'); resolve(); }); });
    });
  }

  if (opts.life) opts.life.onShutdown('listener', stop);

  return {
    server: server, wss: wss, start: start, beginDrain: beginDrain, stop: stop, health: health,
    address: function () { return server.address(); },
    get connectionCount() { return conns.size; },
    get draining() { return draining; },
  };
}

module.exports = { create: create, originAllowed: originAllowed, echoPingPong: echoPingPong, WS_PATH: WS_PATH };
