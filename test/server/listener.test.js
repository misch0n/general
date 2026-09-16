'use strict';
/*
 * Phase 0.3 — the HTTP + WebSocket listener, against a REAL server on a real
 * ephemeral port with a real `ws` client. Mocks would prove the code calls the
 * library; these prove the bytes survive the wire, which is the only claim
 * worth making about a transport.
 *
 * The headline test is the framed PING → PONG round-trip: mp.js's frames were
 * designed for a WebRTC data channel, and everything from Phase 1 onward
 * assumes they cross a WebSocket unharmed.
 */

var test = require('node:test');
var assert = require('node:assert');
var WebSocket = require('ws');

var MP = require('../../mp.js');
var index = require('../../server/index.js');
var listener = require('../../server/listener.js');

// ===== harness
// Port 0 = "any free port", so the suite never collides with a dev server or
// with itself when tests run in parallel.
function withServer(env, opts, run) {
  var app = index.boot(Object.assign({
    env: Object.assign({ PORT: '0', HOST: '127.0.0.1', LOG_LEVEL: 'silent' }, env || {}),
    write: function () {},
    exit: function () {},
  }, opts || {}));

  return app.listener.start().then(function (addr) {
    var base = 'http://127.0.0.1:' + addr.port;
    var wsUrl = 'ws://127.0.0.1:' + addr.port + listener.WS_PATH;
    return Promise.resolve(run({ app: app, base: base, wsUrl: wsUrl, port: addr.port }))
      .finally(function () { return app.listener.stop(); });
  });
}

function get(url) {
  return fetch(url).then(function (res) {
    return res.json().then(function (body) { return { status: res.status, body: body }; });
  });
}

// Open a client socket and resolve once it is open.
function connect(url, opts) {
  return new Promise(function (resolve, reject) {
    var ws = new WebSocket(url, opts);
    ws.binaryType = 'arraybuffer';
    ws.once('open', function () { resolve(ws); });
    ws.once('error', reject);
  });
}

// Next binary message as a Uint8Array.
function nextMessage(ws) {
  return new Promise(function (resolve, reject) {
    var timer = setTimeout(function () { reject(new Error('timed out waiting for a message')); }, 3000);
    ws.once('message', function (data) { clearTimeout(timer); resolve(new Uint8Array(data.buffer || data)); });
  });
}

function closedWith(ws) {
  return new Promise(function (resolve) { ws.once('close', function (code) { resolve(code); }); });
}

// ===== health endpoints

test('healthz reports ok; readyz agrees while serving', function () {
  return withServer(null, null, function (s) {
    return Promise.all([get(s.base + '/healthz'), get(s.base + '/readyz')]).then(function (r) {
      assert.strictEqual(r[0].status, 200);
      assert.strictEqual(r[0].body.status, 'ok');
      assert.strictEqual(r[0].body.connections, 0);
      assert.ok(r[0].body.uptimeMs >= 0);
      assert.strictEqual(r[1].status, 200);
    });
  });
});

test('readyz fails while draining so a load balancer stops sending players', function () {
  // The one place liveness and readiness must disagree: the process is still
  // up and answering (healthz 200) but must not receive new traffic (readyz
  // 503). That ordering is why beginDrain() is separate from stop() — flip
  // readiness first, close the port after, or the balancer never sees the 503.
  return withServer(null, null, function (s) {
    s.app.listener.beginDrain();
    return Promise.all([get(s.base + '/readyz'), get(s.base + '/healthz')]).then(function (r) {
      assert.strictEqual(r[0].status, 503);
      assert.strictEqual(r[0].body.status, 'draining');
      assert.strictEqual(r[1].status, 200, 'the process is still alive — liveness must not fail');
    });
  });
});

test('stats() from the caller reach healthz (Phase 2 reports rooms here)', function () {
  return withServer(null, { stats: function () { return { rooms: 3 }; } }, function (s) {
    return get(s.base + '/healthz').then(function (r) { assert.strictEqual(r.body.rooms, 3); });
  });
});

test('unknown HTTP paths 404 rather than hanging', function () {
  return withServer(null, null, function (s) {
    return get(s.base + '/').then(function (r) { assert.strictEqual(r.status, 404); });
  });
});

// ===== the framing round-trip (the point of Phase 0.3)

test('mp.js frames survive a real WebSocket: PING → PONG', function () {
  return withServer(null, null, function (s) {
    return connect(s.wsUrl).then(function (ws) {
      var payload = new Uint8Array([1, 2, 3, 250, 0]);
      ws.send(Buffer.from(MP.frame(MP.T.PING, MP.HOST_ID, 9, payload)), { binary: true });
      return nextMessage(ws).then(function (bytes) {
        var f = MP.unframe(bytes);
        assert.ok(f, 'the reply failed its CRC — framing did not survive the socket');
        assert.strictEqual(f.type, MP.T.PONG);
        assert.deepStrictEqual(Array.from(f.payload), Array.from(payload));
        ws.close();
      });
    });
  });
});

test('a corrupt frame is dropped, not answered, and does not kill the socket', function () {
  // unframe() returns null on a CRC mismatch — "not received" by design. The
  // server must treat that as silence, then keep serving the same connection.
  return withServer(null, null, function (s) {
    return connect(s.wsUrl).then(function (ws) {
      var bad = MP.frame(MP.T.PING, MP.HOST_ID, 1, new Uint8Array([9]));
      bad[bad.length - 1] ^= 0xff;                       // corrupt the CRC
      ws.send(Buffer.from(bad), { binary: true });

      var good = MP.frame(MP.T.PING, MP.HOST_ID, 2, new Uint8Array([7]));
      ws.send(Buffer.from(good), { binary: true });

      return nextMessage(ws).then(function (bytes) {
        var f = MP.unframe(bytes);
        assert.strictEqual(f.type, MP.T.PONG);
        assert.deepStrictEqual(Array.from(f.payload), [7], 'the corrupt frame was answered');
        ws.close();
      });
    });
  });
});

test('text frames are ignored — the protocol is binary end to end', function () {
  return withServer(null, null, function (s) {
    return connect(s.wsUrl).then(function (ws) {
      ws.send('hello?');
      ws.send(Buffer.from(MP.frame(MP.T.PING, MP.HOST_ID, 1, new Uint8Array([4]))), { binary: true });
      return nextMessage(ws).then(function (bytes) {
        assert.deepStrictEqual(Array.from(MP.unframe(bytes).payload), [4]);
        ws.close();
      });
    });
  });
});

// ===== door checks

test('an oversized frame is refused instead of buffered', function () {
  // Without a cap, one client can exhaust the server's memory (Phase 5.2/3.6
  // build on this; the cap is configured here).
  return withServer({ MAX_FRAME_BYTES: '1024' }, null, function (s) {
    return connect(s.wsUrl).then(function (ws) {
      var closing = closedWith(ws);
      ws.send(Buffer.alloc(4096), { binary: true });
      return closing.then(function (code) {
        assert.strictEqual(code, 1009, 'expected "message too big", got ' + code);
      });
    });
  });
});

test('upgrades on an unknown path are refused', function () {
  return withServer(null, null, function (s) {
    return connect('ws://127.0.0.1:' + s.port + '/nope').then(
      function () { throw new Error('a bogus path was upgraded'); },
      function (e) { assert.match(String(e.message), /404|Unexpected server response/); }
    );
  });
});

test('an allowlisted Origin is accepted and others are refused', function () {
  return withServer({ ALLOWED_ORIGINS: 'https://game.example' }, null, function (s) {
    return connect(s.wsUrl, { origin: 'https://game.example' }).then(function (ws) {
      ws.close();
      return connect(s.wsUrl, { origin: 'https://evil.example' }).then(
        function () { throw new Error('a disallowed origin got through'); },
        function (e) { assert.match(String(e.message), /403|Unexpected server response/); }
      );
    });
  });
});

test('a file:// client (Origin: null) can be allowlisted explicitly', function () {
  // The primary client of this game is a double-clicked index.html, which sends
  // `Origin: null`. An allowlist that cannot name it would lock out the whole
  // audience — so this is a correctness case, not a curiosity.
  assert.strictEqual(listener.originAllowed(['null'], undefined), true);
  assert.strictEqual(listener.originAllowed(['null'], 'null'), true);
  assert.strictEqual(listener.originAllowed(['https://a.example'], undefined), false);
  assert.strictEqual(listener.originAllowed([], 'https://anything.example'), true, 'empty allowlist = accept any');
});

test('upgrades are refused once the server is draining', function () {
  return withServer(null, null, function (s) {
    s.app.listener.beginDrain();
    return connect(s.wsUrl).then(
      function () { throw new Error('accepted a connection while draining'); },
      function (e) { assert.match(String(e.message), /503|Unexpected server response/); }
    );
  });
});

// ===== lifecycle

test('the listener drains its sockets through the shutdown hook', function () {
  // The listener registers its own hook, so shutting the app down must close
  // live sockets with a close frame (1001) — a client that is TOLD the server
  // is going away can say so on screen; a yanked TCP connection just freezes.
  var app = index.boot({
    env: { PORT: '0', HOST: '127.0.0.1', LOG_LEVEL: 'silent', SHUTDOWN_GRACE_MS: '2000' },
    write: function () {}, exit: function () {},
  });
  return app.listener.start().then(function (addr) {
    return connect('ws://127.0.0.1:' + addr.port + listener.WS_PATH).then(function (ws) {
      assert.strictEqual(app.listener.connectionCount, 1);
      var closing = closedWith(ws);
      return app.life.shutdown('test', 0).then(function () { return closing; }).then(function (code) {
        assert.strictEqual(code, 1001, 'expected "going away", got ' + code);
        assert.strictEqual(app.listener.connectionCount, 0);
      });
    });
  });
});

test('closed sockets are released, so abandoned clients are not a leak', function () {
  return withServer(null, null, function (s) {
    return connect(s.wsUrl).then(function (ws) {
      assert.strictEqual(s.app.listener.connectionCount, 1);
      ws.close();
      return new Promise(function (r) { setTimeout(r, 100); }).then(function () {
        assert.strictEqual(s.app.listener.connectionCount, 0);
      });
    });
  });
});

test('onConnection receives a transport-shaped object (what Phase 1 plugs into)', function () {
  // send/onReceive/close is exactly mp.js's `opts.transport` contract, which is
  // why Phase 1's SocketBus can be a thin grouping layer instead of a rewrite.
  var seen = null;
  return withServer(null, {
    onConnection: function (conn) {
      seen = conn;
      conn.onReceive(function (bytes) { conn.send(MP.frame(MP.T.META, MP.HOST_ID, 0, bytes.slice(3, bytes.length - 1))); });
    },
  }, function (s) {
    return connect(s.wsUrl).then(function (ws) {
      assert.ok(seen, 'onConnection was not called');
      assert.strictEqual(typeof seen.send, 'function');
      assert.strictEqual(typeof seen.onReceive, 'function');
      assert.strictEqual(typeof seen.close, 'function');
      ws.send(Buffer.from(MP.frame(MP.T.PING, MP.HOST_ID, 0, new Uint8Array([42]))), { binary: true });
      return nextMessage(ws).then(function (bytes) {
        var f = MP.unframe(bytes);
        assert.strictEqual(f.type, MP.T.META);
        assert.deepStrictEqual(Array.from(f.payload), [42]);
        ws.close();
      });
    });
  });
});

test('a throwing receive handler closes that connection, not the server', function () {
  return withServer(null, {
    onConnection: function (conn) { conn.onReceive(function () { throw new Error('boom'); }); },
  }, function (s) {
    return connect(s.wsUrl).then(function (ws) {
      var closing = closedWith(ws);
      ws.send(Buffer.from(MP.frame(MP.T.PING, MP.HOST_ID, 0, new Uint8Array([1]))), { binary: true });
      return closing.then(function (code) {
        assert.strictEqual(code, 1011);
        // the server is still up and serving other clients
        return get(s.base + '/healthz').then(function (r) { assert.strictEqual(r.status, 200); });
      });
    });
  });
});

test('two clients are served independently', function () {
  return withServer(null, null, function (s) {
    return Promise.all([connect(s.wsUrl), connect(s.wsUrl)]).then(function (ws) {
      assert.strictEqual(s.app.listener.connectionCount, 2);
      ws[0].send(Buffer.from(MP.frame(MP.T.PING, MP.HOST_ID, 0, new Uint8Array([11]))), { binary: true });
      ws[1].send(Buffer.from(MP.frame(MP.T.PING, MP.HOST_ID, 0, new Uint8Array([22]))), { binary: true });
      return Promise.all([nextMessage(ws[0]), nextMessage(ws[1])]).then(function (msgs) {
        assert.deepStrictEqual(Array.from(MP.unframe(msgs[0]).payload), [11]);
        assert.deepStrictEqual(Array.from(MP.unframe(msgs[1]).payload), [22]);
        ws[0].close(); ws[1].close();
      });
    });
  });
});
