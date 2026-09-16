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

// Unframe, and answer a PING with a PONG carrying the same payload. This lived
// in listener.js until Phase 1.2 gave the server a real room to hand sockets
// to; it belongs to the tests now, because what it proves is about the SOCKET —
// that mp.js's frames, designed for a WebRTC data channel, cross a WebSocket
// unharmed in both directions — and the listener has no business owning a
// stand-in for game logic once the game logic exists.
function echoPingPong(conn) {
  var seq = 0;
  conn.onReceive(function (bytes) {
    var f = MP.unframe(bytes);
    // unframe() returns null on a CRC mismatch — "not received" by design.
    if (!f || f.type !== MP.T.PING) return;
    conn.send(MP.frame(MP.T.PONG, MP.HOST_ID, seq++ & 0xff, f.payload));
  });
}

// Port 0 = "any free port", so the suite never collides with a dev server or
// with itself when tests run in parallel.
function withServer(env, opts, run) {
  var app = index.boot(Object.assign({
    env: Object.assign({ PORT: '0', HOST: '127.0.0.1', LOG_LEVEL: 'silent' }, env || {}),
    write: function () {},
    exit: function () {},
    // These tests are about the listener, not the game, so by default they take
    // the connection instead of boot()'s room — the echo above answers frames
    // without a session's state machine deciding what is worth answering. The
    // room's own end-to-end path is test/server/room.test.js.
    onConnection: function (conn) { echoPingPong(conn); },
  }, opts || {}));

  return app.listener.start().then(function (addr) {
    var base = 'http://127.0.0.1:' + addr.port;
    var wsUrl = 'ws://127.0.0.1:' + addr.port + listener.WS_PATH;
    var out;
    // A SYNCHRONOUS throw in `run` must still tear the listener down — with a
    // bare .finally() on the result it would escape before the chain exists,
    // leaving a listening handle that keeps the test process alive after an
    // already-failing assertion.
    // boot() opens a room whether or not this test uses it, and its session
    // holds timers — unref'd, so they cannot hang the suite, but a room left
    // open is still a live object per test.
    function teardown() { app.room.close('test over'); return app.listener.stop(); }
    try { out = Promise.resolve(run({ app: app, base: base, wsUrl: wsUrl, port: addr.port })); }
    catch (e) { return teardown().then(function () { throw e; }); }
    return out.finally(teardown);
  });
}

// Poll a condition instead of sleeping a fixed amount: a loaded CI runner is
// exactly where a hard-coded delay turns into a flake.
function until(predicate, what) {
  var deadline = Date.now() + 3000;
  return new Promise(function (resolve, reject) {
    (function tick() {
      if (predicate()) return resolve();
      if (Date.now() > deadline) return reject(new Error('timed out waiting for ' + what));
      setTimeout(tick, 10);
    })();
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

// The ws client's error for ANY non-101 response is literally
// "Unexpected server response: <code>", so the status code must be anchored —
// a bare /404|Unexpected server response/ matches every refusal alike and the
// door checks could be swapped without a single test noticing.
function refusedWith(code) {
  return new RegExp('Unexpected server response: ' + code);
}

test('upgrades on an unknown path are refused', function () {
  return withServer(null, null, function (s) {
    return connect('ws://127.0.0.1:' + s.port + '/nope').then(
      function () { throw new Error('a bogus path was upgraded'); },
      function (e) { assert.match(String(e.message), refusedWith(404)); }
    );
  });
});

test('an allowlisted Origin is accepted and others are refused', function () {
  return withServer({ ALLOWED_ORIGINS: 'https://game.example' }, null, function (s) {
    return connect(s.wsUrl, { origin: 'https://game.example' }).then(function (ws) {
      ws.close();
      return connect(s.wsUrl, { origin: 'https://evil.example' }).then(
        function () { throw new Error('a disallowed origin got through'); },
        function (e) { assert.match(String(e.message), refusedWith(403)); }
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
      function (e) { assert.match(String(e.message), refusedWith(503)); }
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
      return until(function () { return s.app.listener.connectionCount === 0; }, 'the connection to be released');
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
      // the two the grouping layer above needs on top of the bare contract
      assert.strictEqual(typeof seen.onClose, 'function');
      assert.strictEqual(typeof seen.isOpen, 'function');
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

test('onClose tells the layer above that a socket vanished', function () {
  // SocketBus has no access to the raw `ws`, but from Phase 1 a socket holds a
  // SEAT — and a seat nobody releases stalls the room for everyone else.
  var gone = null;
  return withServer(null, {
    onConnection: function (conn) { conn.onClose(function (c, code) { gone = { id: c.id, code: code }; }); },
  }, function (s) {
    return connect(s.wsUrl).then(function (ws) {
      ws.close(4001, 'bye');
      return until(function () { return gone !== null; }, 'the close handler to fire').then(function () {
        assert.strictEqual(gone.code, 4001, 'the close code is passed through');
        assert.ok(gone.id, 'the connection is identified');
      });
    });
  });
});

test('a throwing close handler does not take the server down', function () {
  var threw = false;
  return withServer(null, {
    onConnection: function (conn) {
      conn.onReceive(function (bytes) { conn.send(bytes); });
      conn.onClose(function () { threw = true; throw new Error('bus blew up on close'); });
    },
  }, function (s) {
    return connect(s.wsUrl).then(function (ws) {
      ws.close();
      return until(function () { return threw; }, 'the throwing close handler to run')
        // The real proof is that the LISTENER still works afterwards — a new
        // client can connect and round-trip a frame. (Both /healthz and the
        // connection count are settled by the handler BEFORE the throwing one,
        // so on their own they would pass without exercising this at all.)
        .then(function () { return connect(s.wsUrl); })
        .then(function (ws2) {
          ws2.send(Buffer.from(MP.frame(MP.T.PING, MP.HOST_ID, 0, new Uint8Array([7]))), { binary: true });
          return nextMessage(ws2).then(function (bytes) {
            assert.deepStrictEqual(Array.from(MP.unframe(bytes).payload), [7], 'the listener still serves new players');
            ws2.close();
          });
        });
    });
  });
});

test('isOpen() tells the layer above whether a socket can still carry bytes', function () {
  // SocketBus refuses a dead socket with this: 'close' is one-shot, so a conn
  // adopted after it died would register a handler that can never fire.
  var conn = null;
  return withServer(null, { onConnection: function (c) { conn = c; } }, function (s) {
    return connect(s.wsUrl).then(function (ws) {
      assert.strictEqual(conn.isOpen(), true);
      ws.close();
      return until(function () { return !conn.isOpen(); }, 'the socket to report itself closed');
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

// ===== "one bad connection must never take the process down"
// Each of these reproduces a way the listener could kill the whole server —
// i.e. every room on the box — from a single misbehaving client or a single
// throwing handler. They are regressions, not hypotheticals: all four were
// real, and the first three exited the process before the fix.

test('send() resolves instead of rejecting when the peer is gone', function () {
  // THE CONTRACT: send() must never reject. MP.Session calls it without a
  // .catch(), so a rejection is an unhandled rejection, which Node's default
  // --unhandled-rejections=throw turns into a process exit — one rude client
  // killing every other game on the box.
  //
  // Honest scope: this asserts the CONTRACT (the returned promise settles by
  // resolving, reporting failure as `false`), not a reproduction of the race
  // that first exposed it. The reproduction — a client that RSTs mid-write —
  // depends on the write erroring while readyState is still OPEN, which does
  // not happen reliably on loopback; a test built on it passes against the
  // broken code too, which is worse than no test. The process-level guard
  // below covers the abusive-client path for real.
  var conn = null;
  return withServer(null, { onConnection: function (c) { conn = c; } }, function (s) {
    return connect(s.wsUrl).then(function (ws) {
      assert.ok(conn, 'onConnection did not run');
      ws._socket.destroy();                                  // RST, no close handshake
      return until(function () { return s.app.listener.connectionCount === 0; }, 'the reset socket to be reaped')
        .then(function () {
          // Would REJECT (→ unhandled rejection → exit) if send() threw on a
          // dead socket. Must resolve, and say the write did not land.
          return conn.send(MP.frame(MP.T.PONG, MP.HOST_ID, 0, new Uint8Array([1])));
        })
        .then(function (ok) { assert.strictEqual(ok, false, 'send() should report a failed write, not throw'); });
    });
  });
});

test('an abusive client raises no unhandled rejection in the server', function () {
  // Process-level guard on the same invariant: whatever a client does to its
  // socket, nothing inside the listener may leave a promise rejected with no
  // handler. Any such rejection is a latent process kill.
  var seen = [];
  function onUnhandled(reason) { seen.push(reason); }
  process.on('unhandledRejection', onUnhandled);

  return withServer(null, null, function (s) {
    return connect(s.wsUrl).then(function (ws) {
      ws.send(Buffer.from(MP.frame(MP.T.PING, MP.HOST_ID, 0, new Uint8Array([1]))), { binary: true });
      return nextMessage(ws).then(function () {
        // Queue work the server must answer, then rip the socket away mid-flight.
        for (var i = 0; i < 40; i++) {
          ws.send(Buffer.from(MP.frame(MP.T.PING, MP.HOST_ID, i & 0xff, Buffer.alloc(1024))), { binary: true });
        }
        ws._socket.destroy();
        return until(function () { return s.app.listener.connectionCount === 0; }, 'the reset socket to be reaped');
      }).then(function () {
        return get(s.base + '/healthz').then(function (r) {
          assert.strictEqual(r.status, 200, 'the server died with the client');
          assert.deepStrictEqual(seen.map(String), [], 'unhandled rejection(s) escaped the listener');
        });
      });
    });
  }).finally(function () { process.removeListener('unhandledRejection', onUnhandled); });
});

test('a throwing onConnection closes that socket, not the server', function () {
  // The accept path needs the same guard the receive path has; Phase 1 plugs
  // SocketBus in exactly here, so a bug in it must cost one connection.
  return withServer(null, {
    onConnection: function () { throw new Error('SocketBus blew up'); },
  }, function (s) {
    return connect(s.wsUrl).then(function (ws) {
      return closedWith(ws).then(function (code) {
        assert.strictEqual(code, 1011);
        return get(s.base + '/healthz').then(function (r) { assert.strictEqual(r.status, 200); });
      });
    });
  });
});

test('a throwing stats() degrades the health check instead of killing the server', function () {
  // stats() is Phase 2's room registry — code that can legitimately be broken
  // exactly when health is being probed. The endpoint whose job is to REPORT
  // trouble must not become the trouble.
  return withServer(null, { stats: function () { throw new Error('room registry not ready'); } }, function (s) {
    return get(s.base + '/healthz').then(function (r) {
      assert.strictEqual(r.status, 200, 'liveness: the process IS up');
      assert.strictEqual(r.body.status, 'degraded');
      assert.strictEqual(r.body.statsError, true);
      // and readiness must pull it out of rotation
      return get(s.base + '/readyz');
    }).then(function (r) {
      assert.strictEqual(r.status, 503);
    });
  });
});

test('an unstringifiable health payload 500s instead of throwing', function () {
  var circular = {}; circular.self = circular;
  return withServer(null, { stats: function () { return { loop: circular }; } }, function (s) {
    return get(s.base + '/healthz').then(function (r) {
      assert.strictEqual(r.status, 500);
      assert.strictEqual(r.body.serializeError, true);
    });
  });
});

test('an unresponsive client cannot hold the drain past its grace budget', function () {
  // ws waits up to 30s for a peer to answer a close frame — far longer than
  // SHUTDOWN_GRACE_MS. If the port's closure waits on that, one frozen client
  // turns a clean SIGTERM into exit(1), which an orchestrator reads as a crash.
  var app = index.boot({
    env: {
      PORT: '0', HOST: '127.0.0.1', LOG_LEVEL: 'silent',
      SHUTDOWN_GRACE_MS: '3000',
      HEARTBEAT_MS: '0',            // don't let the heartbeat reap it for us
    },
    write: function () {}, exit: function () {},
  });
  return app.listener.start().then(function (addr) {
    return connect('ws://127.0.0.1:' + addr.port + listener.WS_PATH).then(function (ws) {
      ws._socket.pause();                       // never answers the close frame
      var t0 = Date.now();
      return app.listener.stop().then(function () {
        var ms = Date.now() - t0;
        assert.ok(ms < 2500, 'drain took ' + ms + 'ms — a frozen peer held the port');
        assert.strictEqual(app.listener.address(), null, 'the port was never closed');
        ws.terminate();
      });
    });
  });
});

test('the heartbeat reaps a peer that vanished without a FIN', function () {
  // A closed laptop / NAT timeout / mobile handoff never fires 'close', so the
  // connection — and from Phase 1 its SEAT — would be held forever.
  return withServer({ HEARTBEAT_MS: '60' }, null, function (s) {
    return connect(s.wsUrl).then(function (ws) {
      assert.strictEqual(s.app.listener.connectionCount, 1);
      ws._socket.pause();                       // alive at TCP level, answers nothing
      return until(function () { return s.app.listener.connectionCount === 0; }, 'the dead peer to be reaped')
        .then(function () { ws.terminate(); });
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
