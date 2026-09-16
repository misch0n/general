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
 *   - keep dead peers from accumulating (heartbeat) and register its own drain
 *     hook so shutdown closes sockets before the port.
 *
 * NO game logic lives here. The default handler (when the caller supplies no
 * onConnection) is a framed PING→PONG echo: enough to prove mp.js framing
 * survives a real WebSocket round-trip, which is the whole point of Phase 0.3.
 *
 * THE INVARIANT THIS FILE EXISTS TO KEEP: one bad connection must never take
 * the process down. A server refereeing many rooms cannot let a single rude or
 * broken client kill every other game on the box. Concretely that means every
 * boundary where foreign code or foreign bytes enter — the accept callback, the
 * receive callback, the health handler, and every socket write — is wrapped, and
 * `send()` never rejects (MP.Session calls it without a `.catch()`, so a
 * rejection would be an unhandled rejection, which Node turns into an exit).
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
  var closeCb = null;
  var closed = false;

  var conn = {
    id: opts.id,
    // Heartbeat bookkeeping (see the interval in create()). A peer that
    // vanishes without a FIN — closed laptop, NAT timeout, mobile handoff —
    // never fires 'close', so without this its seat would be held forever.
    alive: true,

    /*
     * NEVER REJECTS, by contract. MP.Session calls send() without a .catch(),
     * so a rejected promise becomes an unhandled rejection and — under Node's
     * default --unhandled-rejections=throw — exits the process. A client that
     * RSTs its socket mid-write would otherwise kill every other room on the
     * box. A peer we cannot write to is a peer that is going away, which the
     * 'close' handler already deals with; the write error is logged and
     * swallowed.
     *
     * The Buffer is a zero-copy VIEW over `bytes`, and ws may still hold it
     * queued after send() returns, so THE CALLER MUST TREAT `bytes` AS
     * READ-ONLY from here on. That becomes load-bearing in Phase 1, where one
     * frame is fanned out to every socket in a room.
     */
    send: function (bytes) {
      return new Promise(function (resolve) {
        if (closed || ws.readyState !== WebSocket.OPEN) { resolve(false); return; }
        var buf = ArrayBuffer.isView(bytes)
          ? Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
          : Buffer.from(bytes);
        try {
          ws.send(buf, { binary: true }, function (err) {
            if (err) log.debug('send failed', { conn: conn.id, err: err });
            resolve(!err);
          });
        } catch (e) {
          // ws throws synchronously if the socket died between the readyState
          // check and the write.
          log.debug('send threw', { conn: conn.id, err: e });
          resolve(false);
        }
      });
    },

    onReceive: function (fn) { cb = fn; },

    // Registration for the layer above (Phase 1's SocketBus), which has no
    // access to the raw `ws` yet must learn when a socket vanishes — from
    // Phase 1 that socket holds a SEAT, and a seat nobody releases stalls the
    // game for everyone else in the room.
    //
    // SINGLE SLOT, like onReceive: registering again REPLACES the previous
    // handler. That is what lets a room hand a connection over (the new owner
    // takes the slot), and it is why two layers must not both register — the
    // second silently evicts the first. One owner at a time, by contract.
    onClose: function (fn) { closeCb = fn; },

    // Whether this socket can still carry bytes. The layer above needs it
    // because 'close' is a ONE-SHOT event: a conn that died before it was
    // adopted would register a close handler that can never fire, and sit in
    // its new owner's list forever as a ghost member.
    isOpen: function () { return !closed && ws.readyState === WebSocket.OPEN; },

    close: function (code, reason) {
      if (closed) return;
      closed = true;
      try { ws.close(code || 1000, reason || ''); } catch (e) { /* already gone */ }
    },

    // Hard kill, for a peer that will not answer a close frame. Used by the
    // heartbeat and by the drain's force-timer.
    terminate: function () {
      closed = true;
      try { ws.terminate(); } catch (e) { /* already gone */ }
    },

    ping: function () { try { ws.ping(); } catch (e) { /* already gone */ } },
  };

  ws.on('pong', function () { conn.alive = true; });

  ws.on('message', function (data, isBinary) {
    // The protocol is binary end to end. A text frame is either a confused
    // client or a probe; either way it is not something to feed the codecs.
    if (!isBinary) { log.debug('dropped a text frame', { conn: conn.id }); return; }
    conn.alive = true;
    // A view into ws's POOLED buffer — valid only for this callback. MP.unframe
    // copies what it keeps (.slice), so this is safe as used; a handler that
    // QUEUES frames must copy first, or it pins a pool slab per message.
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
    // Our own bookkeeping first, so the handler above sees a consistent view —
    // and wrapped like everything else, because a throw here would escape ws's
    // 'close' emit uncaught (killing the process) AND skip the handler below,
    // so the room would never release the seat. Both failures this file exists
    // to prevent, from one throw.
    if (opts.onClose) {
      try { opts.onClose(conn, code); }
      catch (e) { log.error('internal close handler threw', { conn: conn.id, err: e }); }
    }
    if (closeCb) {
      try { closeCb(conn, code); }
      catch (e) { log.error('close handler threw', { conn: conn.id, err: e }); }
    }
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
  var beat = null;

  function health() {
    var body = { status: draining ? 'draining' : 'ok', uptimeMs: Date.now() - startedAt, connections: conns.size };
    // stats() is Phase 2's room registry — code that can legitimately be in a
    // bad state exactly when health is probed. The endpoint whose job is to
    // REPORT trouble must not become the trouble.
    try {
      var s = stats();
      Object.keys(s || {}).forEach(function (k) { body[k] = s[k]; });
    } catch (e) {
      log.error('stats() threw during a health check', { err: e });
      body.status = 'degraded';
      body.statsError = true;
    }
    return body;
  }

  function reply(res, code, body) {
    var json;
    try {
      json = JSON.stringify(body);
    } catch (e) {
      // An unstringifiable stats object must not take the process down either.
      log.error('health payload could not be serialized', { err: e });
      code = 500;
      json = '{"status":"degraded","serializeError":true}';
    }
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(json) });
    res.end(json);
  }

  var server = http.createServer(function (req, res) {
    var path = (req.url || '').split('?')[0];
    // Liveness: is the process alive at all? Readiness: should a load balancer
    // still send it traffic? They differ exactly once — while draining, where
    // /readyz must fail so new players land on a healthy instance.
    if (path === '/healthz') return reply(res, 200, health());
    if (path === '/readyz') {
      var body = health();
      return reply(res, (draining || body.status === 'degraded') ? 503 : 200, body);
    }
    reply(res, 404, { error: 'not found' });
  });

  // A permanent 'error' listener for the whole life of the server. Without one,
  // any post-listen net.Server error (an accept failure under fd exhaustion,
  // say) is an unhandled 'error' event, which throws. start()'s once('error')
  // covers only the bind race.
  server.on('error', function (e) { log.error('http server error', { err: e }); });

  // noServer + a manual upgrade handler so the door checks produce a real HTTP
  // response (403/404) instead of an unexplained socket reset.
  var wss = new WebSocket.WebSocketServer({ noServer: true, maxPayload: cfg.maxFrameBytes });

  // end(), not write()+destroy(): destroy() aborts pending writes, so a slow or
  // backpressured peer would see a reset instead of the status we are at pains
  // to send. end() sends FIN after the bytes have flushed.
  function refuse(socket, code, text) {
    try { socket.end('HTTP/1.1 ' + code + ' ' + text + '\r\nconnection: close\r\n\r\n'); }
    catch (e) { try { socket.destroy(); } catch (e2) {} }
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
      log: log,
      onClose: function (c) { conns.delete(c); },
    });
    conns.add(conn);
    log.debug('socket accepted', { conn: id, connections: conns.size });
    // Same invariant as the receive path: a throw from the handler above us
    // (Phase 1's SocketBus, Phase 2's room router) closes THIS connection, not
    // the process.
    try {
      if (onConnection) onConnection(conn, req);
      else echoPingPong(conn, log);
    } catch (e) {
      log.error('connection handler threw', { conn: id, err: e });
      conn.close(1011, 'accept error');
    }
  }

  // Ping every socket; terminate the ones that did not answer the last round.
  // Without this, half-open connections (vanished peer, no FIN) accumulate
  // forever: they inflate /healthz and, from Phase 1, hold a seat in a room.
  function startHeartbeat() {
    if (beat || !cfg.heartbeatMs) return;
    beat = setInterval(function () {
      conns.forEach(function (c) {
        if (!c.alive) {
          log.debug('terminating an unresponsive socket', { conn: c.id });
          c.terminate();
          return;
        }
        c.alive = false;
        c.ping();
      });
    }, cfg.heartbeatMs);
    // Never the reason the process stays alive.
    if (beat.unref) beat.unref();
  }

  function start() {
    return new Promise(function (resolve, reject) {
      function onErr(e) { reject(e); }
      server.once('error', onErr);
      server.listen(cfg.port, cfg.host, function () {
        server.removeListener('error', onErr);
        startHeartbeat();
        var a = server.address();
        log.info('listening', { host: a.address, port: a.port, ws: WS_PATH, heartbeatMs: cfg.heartbeatMs });
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

  /*
   * Close sockets first, then the port: a client that gets a close frame can
   * say so on screen, where a dropped TCP connection just freezes the board.
   *
   * Two deliberate details, both learned the hard way:
   *  - the two closes run in PARALLEL. Nesting server.close() inside
   *    wss.close()'s callback makes the port's closure hostage to the slowest
   *    client, because wss.close() waits for every socket to emit 'close'.
   *  - a peer that never answers the close frame is terminated after a short
   *    grace. ws waits up to 30s for that answer — far longer than the default
   *    SHUTDOWN_GRACE_MS — so one unresponsive client would otherwise burn the
   *    whole budget and turn a clean SIGTERM into exit(1), which an
   *    orchestrator reads as a crashed process.
   */
  function stop() {
    beginDrain();
    if (beat) { clearInterval(beat); beat = null; }

    var pending = Array.from(conns);
    pending.forEach(function (c) { c.close(1001, 'server shutting down'); });

    var forceMs = Math.max(100, Math.min(2000, Math.floor((cfg.shutdownGraceMs || 0) / 2)));
    var killer = setTimeout(function () {
      pending.forEach(function (c) { c.terminate(); });
    }, forceMs);
    if (killer.unref) killer.unref();

    function closed(closer) {
      return new Promise(function (resolve) { closer(function () { resolve(); }); });
    }

    return Promise.all([
      closed(function (cb) { wss.close(cb); }),
      closed(function (cb) { server.close(cb); }),
    ]).then(function () {
      clearTimeout(killer);
      conns.clear();
      log.info('listener closed');
    });
  }

  if (opts.life) opts.life.onShutdown('listener', stop);

  return {
    server: server, start: start, beginDrain: beginDrain, stop: stop, health: health,
    address: function () { return server.address(); },
    get connectionCount() { return conns.size; },
    get draining() { return draining; },
  };
}

module.exports = { create: create, originAllowed: originAllowed, WS_PATH: WS_PATH };
