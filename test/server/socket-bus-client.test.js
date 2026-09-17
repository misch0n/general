'use strict';
/*
 * Phase 1.3 — the BROWSER's SocketBus, exercised against a real server.
 *
 * `features/net/socket-bus.js` is a browser file, but it is DOM-free and UMD (like
 * mp.js) precisely so this test can exist: a transport validated only against a mock
 * socket proves that the mock agrees with the transport, not that the transport can
 * talk to our server. So the bus here is the real file, `ws` is injected where the
 * browser would hand it the global `WebSocket`, and the other end is a real
 * `server/index.js` on a real ephemeral port.
 *
 * Scope is the transport only — bytes in, bytes out, and the link lifecycle. Driving a
 * full MP.Session lobby through it is Phase 1.4.
 */

var test = require('node:test');
var assert = require('node:assert');
var WebSocket = require('ws');

var MP = require('../../mp.js');
var index = require('../../server/index.js');
var listener = require('../../server/listener.js');
var SocketBus = require('../../features/net/socket-bus.js');

// ===== harness

function withServer(run) {
  var app = index.boot({
    env: { PORT: '0', HOST: '127.0.0.1', LOG_LEVEL: 'silent' },
    write: function () {},
    exit: function () {},
  });
  return app.listener.start().then(function (addr) {
    var s = { app: app, room: app.room, port: addr.port, wsUrl: 'ws://127.0.0.1:' + addr.port + listener.WS_PATH };
    var out;
    function teardown() { app.room.close('test over'); return app.listener.stop(); }
    try { out = Promise.resolve(run(s)); }
    catch (e) { return teardown().then(function () { throw e; }); }
    return out.finally(teardown);
  });
}

// A bus pointed at `url`, with every callback and log line recorded so a test can assert
// on what the app would have been told. `WebSocket` is the injection the browser doesn't
// need. `t` (the test context) stops the bus no matter how the test ends: a bus left
// started after a failed assertion redials against the port withServer just released, so
// one real failure would otherwise spray noise over every test after it.
function busFor(t, url, opts) {
  var seen = { peers: [], lost: [], reup: 0, gaveUp: 0, frames: [], log: [] };
  var bus = new SocketBus(Object.assign({
    url: url,
    WebSocket: WebSocket,
    onPeers: function (n) { seen.peers.push(n); },
    onLost: function (info) { seen.lost.push(info); },
    onReup: function () { seen.reup++; },
    onGiveUp: function () { seen.gaveUp++; },
    onLog: function (ev, data) { seen.log.push(Object.assign({ ev: ev }, data)); },
  }, opts || {}));
  bus.onReceive(function (bytes) { var f = MP.unframe(bytes); if (f) seen.frames.push(f); });
  bus.seen = seen;
  if (t && t.after) t.after(function () { bus.stop(); });
  return bus;
}

// Wait for the next frame of exactly this type. Taking "the next frame" would flake the
// moment the room's lobby beacon landed between two expected ones.
function waitFor(bus, type, ms) {
  var deadline = Date.now() + (ms || 3000);
  return new Promise(function (resolve, reject) {
    (function poll() {
      var f = bus.seen.frames.filter(function (x) { return x.type === type; })[0];
      if (f) return resolve(f);
      if (Date.now() > deadline) return reject(new Error('timed out waiting for type ' + type));
      setTimeout(poll, 10);
    })();
  });
}

function until(pred, ms) {
  var deadline = Date.now() + (ms || 5000);
  return new Promise(function (resolve, reject) {
    (function poll() {
      if (pred()) return resolve();
      if (Date.now() > deadline) return reject(new Error('condition never became true'));
      setTimeout(poll, 10);
    })();
  });
}

// ===== url normalization
//
// The path matters more than it looks: server/listener.js upgrades /ws and 404s
// everything else, and a refused upgrade surfaces as a bare "connection closed" — a
// symptom that says nothing about the typo that caused it.

test('normalizeUrl accepts what a human would type, and always lands on a ws path', function (t) {
  var n = SocketBus.normalizeUrl;
  assert.strictEqual(n('ws://localhost:8787/ws'), 'ws://localhost:8787/ws');
  assert.strictEqual(n('localhost:8787'), 'ws://localhost:8787/ws', 'bare host gets a scheme and the default path');
  assert.strictEqual(n('ws://localhost:8787'), 'ws://localhost:8787/ws', 'empty path becomes /ws');
  assert.strictEqual(n('ws://localhost:8787/'), 'ws://localhost:8787/ws', 'a lone slash is an empty path');
  assert.strictEqual(n('http://play.example:80'), 'ws://play.example:80/ws', 'http → ws');
  assert.strictEqual(n('https://play.example'), 'wss://play.example/ws', 'https → wss (the deployed case)');
  assert.strictEqual(n('  wss://play.example/room  '), 'wss://play.example/room', 'an explicit path is left alone');
  assert.strictEqual(n('wss://play.example/ws?t=1'), 'wss://play.example/ws?t=1', 'query survives');
  assert.strictEqual(n('wss://play.example?t=1'), 'wss://play.example/ws?t=1', 'query survives a defaulted path');
  assert.throws(function () { n(''); }, /no server url/);
  assert.throws(function () { n(null); }, /no server url/);
});

test('a bus with no WebSocket implementation rejects instead of throwing at construction', function (t) {
  var bus = new SocketBus({ url: 'ws://127.0.0.1:1/ws' });
  // Node 22 has a global WebSocket, so the constructor's fallback finds one here; strip it
  // to stand in for a context that has none. The point is WHERE it fails: at start(), as a
  // connection problem, not at construction — where in the browser it would be a pageerror
  // on a page that is supposed to keep working offline.
  bus.WS = null;
  return bus.start().then(
    function () { throw new Error('should not have connected'); },
    function (e) { assert.match(e.message, /no-websocket/); }
  );
});

// ===== send is never a rejection
//
// MP.Session calls send() with no .catch(). A rejection would be an unhandled rejection,
// which in a browser is a pageerror and under Node is a process exit.

test('send() before start resolves 0 rather than rejecting', function (t) {
  var bus = new SocketBus({ url: 'ws://127.0.0.1:1/ws', WebSocket: WebSocket });
  return bus.send(MP.frame(MP.T.PING, MP.UNASSIGNED, 0, new Uint8Array(0))).then(function (n) {
    assert.strictEqual(n, 0, 'nothing was delivered, and nobody was told off for it');
  });
});

test('send() after stop() resolves 0 rather than rejecting', function (t) {
  return withServer(function (s) {
    var bus = busFor(t, s.wsUrl);
    return bus.start().then(function () {
      bus.stop();
      return bus.send(MP.frame(MP.T.PING, MP.UNASSIGNED, 0, new Uint8Array(0)));
    }).then(function (n) { assert.strictEqual(n, 0); });
  });
});

// ===== the Definition of Done: it connects to a real server and carries the protocol

// Note on what to probe with: PING→PONG is handled in `_rxClient` only (mp.js:688) — a
// HOST session never answers a ping, so the server is silent to one. The lobby BEACON it
// emits on its own schedule proves server→app, and JOIN_REQ→JOIN_ACK is the smallest
// thing that proves the whole loop.

test('the browser bus connects to a locally-run server and hears the room', function (t) {
  return withServer(function (s) {
    var bus = busFor(t, s.wsUrl);
    return bus.start().then(function () {
      assert.deepStrictEqual(bus.seen.peers, [1], 'the app is told it has a peer: the server');
      return waitFor(bus, MP.T.BEACON, 12000);           // the room beacons every 3.5s; a client can miss the first
    }).then(function (beacon) {
      assert.strictEqual(beacon.sender, MP.HOST_ID, 'the server-hosted session spoke, not a peer');
      bus.stop();
    });
  });
});

test('a JOIN_REQ sent through the bus is seated by the server-hosted session', function (t) {
  return withServer(function (s) {
    var bus = busFor(t, s.wsUrl);
    return bus.start().then(function () {
      return bus.send(MP.frame(MP.T.JOIN_REQ, MP.UNASSIGNED, 0,
        MP.packJoinReq(7788, { name: 'Боби', color: '#00aa55', gender: 'm' }, false)));
    }).then(function (n) {
      assert.strictEqual(n, 1, 'delivered to the one peer');
      return waitFor(bus, MP.T.JOIN_ACK);
    }).then(function (ack) {
      var ja = MP.unpackJoinAck(ack.payload);
      assert.strictEqual(ja.eph, 7788);
      assert.ok(ja.id > 0, 'the server referees but does not play — seats start at 1');
      assert.strictEqual(s.room.session.roster.length, 1, 'the server-side session agrees');
      bus.stop();
    });
  });
});

test('the bus hands the session raw frames, ArrayBuffer or Buffer alike', function (t) {
  return withServer(function (s) {
    // `ws` honours binaryType='arraybuffer', so the happy path only ever exercises the
    // ArrayBuffer branch. Flip it to nodebuffer for a second round to reach the other one
    // — the branch with the non-obvious part, since a Node Buffer is a VIEW into a shared
    // pool: reading it as `new Uint8Array(buf.buffer)` without the byteOffset/byteLength
    // would hand the session a neighbouring allocation's bytes.
    var bus = busFor(t, s.wsUrl);
    var raw = [], kinds = [];
    function askAgain() {
      return bus.send(MP.frame(MP.T.JOIN_REQ, MP.UNASSIGNED, 0,
        MP.packJoinReq(31, { name: 'Ана', color: '#5566ff', gender: 'f' }, false)));
    }
    return bus.start().then(function () {
      var inner = bus.sock;
      var onmsg = inner.onmessage;
      inner.onmessage = function (ev) { kinds.push(ev.data.constructor.name); onmsg(ev); };
      bus.onReceive(function (bytes) { raw.push(bytes); });
      return askAgain();
    }).then(function () {
      return until(function () { return raw.length > 0; });
    }).then(function () {
      bus.sock.binaryType = 'nodebuffer';
      return askAgain();
    }).then(function () {
      return until(function () { return kinds.indexOf('Buffer') >= 0; });
    }).then(function () {
      assert.ok(kinds.indexOf('ArrayBuffer') >= 0 && kinds.indexOf('Buffer') >= 0, 'both shapes were really seen: ' + kinds.join(','));
      raw.forEach(function (b, i) {
        assert.ok(b instanceof Uint8Array, 'frame ' + i + ' is a Uint8Array, whatever the socket produced');
        assert.ok(MP.unframe(b), 'frame ' + i + ' unframes — so the bytes are the right ones, not a pool neighbour');
      });
    });
  });
});

// ===== link lifecycle

test('a dial to a path the listener does not upgrade rejects start()', function (t) {
  return withServer(function (s) {
    // /nope is a 404 from the listener, not a refused port — the failure the app sees is
    // a bare close, which is exactly why normalizeUrl defaults the path instead of
    // leaving it to the operator.
    var bus = busFor(t, 'ws://127.0.0.1:' + s.port + '/nope', { redialMax: 0 });
    return bus.start().then(
      function () { throw new Error('should not have connected'); },
      function (e) {
        assert.ok(e instanceof Error, 'start() rejects with an Error: ' + e);
        assert.strictEqual(bus.sock, null, 'and no link was adopted');
        assert.deepStrictEqual(bus.seen.peers, [], 'the app was never told it had a peer');
      }
    );
  });
});

test('a server-side drop is reported once and then redialled, firing onReup', function (t) {
  return withServer(function (s) {
    var bus = busFor(t, s.wsUrl);
    return bus.start().then(function () {
      // Drop the socket from the SERVER side — the case the redial exists for (the room
      // and, from 2.2, the seat outlive the socket, so giving up would strand the player).
      s.room.bus.peers().forEach(function (conn) { conn.close(4000, 'test drop'); });
      return until(function () { return bus.seen.reup > 0; }, 8000);
    }).then(function () {
      assert.strictEqual(bus.seen.lost.length, 1, 'the drop was reported exactly once');
      assert.deepStrictEqual(bus.seen.peers, [1, 0, 1], 'peer count fell and came back');
      assert.strictEqual(bus.seen.reup, 1, 'the session is told to re-announce itself');
      assert.ok(bus.sock, 'the link is live again');
      bus.stop();
    });
  });
});

test('stop() is not a drop: no onLost, and no redial afterwards', function (t) {
  return withServer(function (s) {
    var bus = busFor(t, s.wsUrl);
    return bus.start().then(function () {
      bus.stop();
      // Long enough that the first redial (1s backoff) would have fired if one were armed.
      return new Promise(function (r) { setTimeout(r, 1300); });
    }).then(function () {
      assert.deepStrictEqual(bus.seen.lost, [], 'our own teardown is not a player dropping');
      assert.strictEqual(bus.sock, null, 'and nothing reconnected behind our back');
      assert.strictEqual(s.room.bus.size(), 0, 'the server saw the socket go');
    });
  });
});

test('stop() during a dial in flight leaves no link and no dangling start()', function (t) {
  return withServer(function (s) {
    var bus = busFor(t, s.wsUrl);
    // A connect always outlives the decision to abandon it. Both halves matter: the
    // socket must not open behind our back, and start()'s promise must settle NOW rather
    // than when the dial timeout fires — an uncaught rejection minutes later is a
    // pageerror on a page that is supposed to keep working offline.
    var started = bus.start();
    bus.stop();
    return started.then(
      function () { throw new Error('start() resolved after stop()'); },
      function (e) { assert.match(e.message, /stopped/);
        assert.strictEqual(e.aborted, true, 'flagged as our own doing, so Phase 7 does not show the player a link error'); }
    ).then(function () {
      return new Promise(function (r) { setTimeout(r, 300); });
    }).then(function () {
      assert.strictEqual(bus.sock, null, 'nothing was adopted after stop()');
      assert.deepStrictEqual(bus.seen.peers, [], 'and the app was never told it had a peer');
      assert.strictEqual(s.room.bus.size(), 0, 'the server holds no socket for it either');
    });
  });
});

test('start() on a live bus resolves instead of hanging', function (t) {
  return withServer(function (s) {
    var bus = busFor(t, s.wsUrl);
    return bus.start().then(function () {
      return bus.start();            // _dial is a no-op here — the promise must still settle
    }).then(function () {
      assert.deepStrictEqual(bus.seen.peers, [1], 'and it did not dial a second socket');
      bus.stop();
    });
  });
});

test('the redial budget is finite — a server that stays down stops being knocked on', function (t) {
  var bus;
  return withServer(function (s) {
    bus = busFor(t, s.wsUrl, { redialMax: 1 });
    return bus.start();
  }).then(function () {
    // withServer has torn the listener down by now, so every redial must fail.
    return until(function () { return bus.seen.lost.length > 0; });
  }).then(function () {
    return until(function () { return bus.seen.gaveUp > 0; }, 8000);
  }).then(function () {
    return new Promise(function (r) { setTimeout(r, 2500); });
  }).then(function () {
    assert.strictEqual(bus.sock, null);
    // Assert the observable thing — no dial after the give-up — rather than the private
    // counter: a loop that kept dialling despite a spent budget would satisfy the counter.
    var log = bus.seen.log, gave = log.map(function (e) { return e.ev; }).indexOf('redial-giveup');
    assert.ok(gave >= 0, 'it announced that it had given up');
    assert.strictEqual(log.slice(gave).filter(function (e) { return e.ev === 'dial'; }).length, 0,
      'and nothing dialled afterwards');
    assert.strictEqual(bus.seen.gaveUp, 1,
      'the app is told exactly once — the one exit from a reconnect state that onReup can never reach');
  });
});

test('a frame the socket did not deliver as bytes is dropped loudly, not silently', function (t) {
  return withServer(function (s) {
    // If `binaryType = 'arraybuffer'` ever fails to take (it is set inside a swallowing
    // try/catch), every frame arrives as a Blob and the bus goes deaf while still
    // reporting a peer and resolving send(). A log line is the only thing that would
    // tell anyone why. Simulated here by feeding the live handler a string.
    var bus = busFor(t, s.wsUrl);
    var delivered = 0;
    return bus.start().then(function () {
      bus.onReceive(function () { delivered++; });
      bus.sock.onmessage({ data: 'not our protocol' });
      assert.strictEqual(delivered, 0, 'the session is never handed a non-binary payload');
      var drops = bus.seen.log.filter(function (e) { return e.ev === 'rx-drop'; });
      assert.strictEqual(drops.length, 1, 'but the drop is on the record');
      assert.strictEqual(drops[0].kind, 'String', 'and it names what arrived instead');
    });
  });
});

test('an unsupported scheme is named, not quietly turned into nonsense', function () {
  // Without the check this becomes 'ws://ftp://h' and fails far from the typo.
  assert.throws(function () { SocketBus.normalizeUrl('ftp://h'); }, /unsupported scheme: ftp/);
  assert.throws(function () { SocketBus.normalizeUrl('file://x/y'); }, /unsupported scheme: file/);
});
