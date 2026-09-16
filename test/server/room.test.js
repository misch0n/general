'use strict';
/*
 * Phase 1.2 — the server hosting a real MP.Session, against a REAL server on a
 * real ephemeral port with real `ws` clients.
 *
 * The headline claim is the lobby handshake: a client that knows nothing but
 * the protocol sends a JOIN_REQ and is answered with JOIN_ACK + ROSTER by a
 * session running on the server. Everything after it in the plan — rooms,
 * reconnects, the authoritative dice — is built on that being true over a
 * socket rather than over a mock.
 *
 * The second claim is the one thing a SERVER-hosted session must do that a
 * browser-hosted one must not: hold no seat. The server referees; if it took
 * seat 0 the way the browser's host does, that seat would join the turn order
 * and be granted a turn nobody was ever going to play.
 */

var test = require('node:test');
var assert = require('node:assert');
var WebSocket = require('ws');

var MP = require('../../mp.js');
var index = require('../../server/index.js');
var listener = require('../../server/listener.js');
var room = require('../../server/room.js');

// ===== harness

function withServer(env, opts, run) {
  var app = index.boot(Object.assign({
    env: Object.assign({ PORT: '0', HOST: '127.0.0.1', LOG_LEVEL: 'silent' }, env || {}),
    write: function () {},
    exit: function () {},
  }, opts || {}));

  return app.listener.start().then(function (addr) {
    var s = { app: app, room: app.room, wsUrl: 'ws://127.0.0.1:' + addr.port + listener.WS_PATH,
      base: 'http://127.0.0.1:' + addr.port };
    var out;
    function teardown() { app.room.close('test over'); return app.listener.stop(); }
    try { out = Promise.resolve(run(s)); }
    catch (e) { return teardown().then(function () { throw e; }); }
    return out.finally(teardown);
  });
}

/*
 * A protocol-level client: a raw socket plus the two things every test needs —
 * a log of every frame the server spoke to it, and a way to wait for one kind.
 * Deliberately NOT an MP.Session: a test that drives both ends with the same
 * object can only prove the object agrees with itself.
 */
function client(url, eph) {
  var c = { heard: [], eph: eph, id: null, seq: 0, ws: null, waiters: [] };

  c.connect = function () {
    return new Promise(function (resolve, reject) {
      var ws = new WebSocket(url);
      c.ws = ws;
      ws.binaryType = 'arraybuffer';
      ws.once('error', reject);
      ws.once('open', function () { resolve(c); });
      ws.on('message', function (data) {
        var f = MP.unframe(new Uint8Array(data.buffer || data));
        if (!f) return;
        c.heard.push(f);
        c.waiters = c.waiters.filter(function (w) {
          if (f.type !== w.type) return true;
          clearTimeout(w.timer); w.resolve(f); return false;
        });
      });
    });
  };

  c.send = function (type, payload, sender) {
    var from = sender === undefined ? (c.id == null ? MP.UNASSIGNED : c.id) : sender;
    c.ws.send(Buffer.from(MP.frame(type, from, c.seq++ & 0xff, payload || new Uint8Array(0))), { binary: true });
  };

  // Resolve on the next frame of this type — and only this type, because the
  // room beacons on its own schedule and a test that took "the next message"
  // would flake the moment a beacon landed between two expected frames.
  c.expect = function (type, what) {
    var already = c.heard.filter(function (f) { return f.type === type; })[0];
    if (already) return Promise.resolve(already);
    return new Promise(function (resolve, reject) {
      var w = { type: type, resolve: resolve };
      w.timer = setTimeout(function () {
        c.waiters = c.waiters.filter(function (x) { return x !== w; });
        reject(new Error('timed out waiting for ' + (what || type)));
      }, 3000);
      c.waiters.push(w);
    });
  };

  c.closed = function () { return new Promise(function (resolve) { c.ws.once('close', function (code) { resolve(code); }); }); };

  // Join, and adopt the seat the server hands back — from then on this client's
  // frames carry that seat in the sender nibble, which is what lets the bus tag
  // the socket with it.
  c.join = function (meta) {
    c.send(MP.T.JOIN_REQ, MP.packJoinReq(c.eph, meta || { name: 'Боец', color: '#00aa55', gender: 'm' }, false));
    return c.expect(MP.T.JOIN_ACK, 'JOIN_ACK').then(function (f) {
      c.id = MP.unpackJoinAck(f.payload).id;
      return c;
    });
  };

  return c;
}

function connected(url, eph) { return client(url, eph).connect(); }

function get(url) {
  return fetch(url).then(function (res) { return res.json(); });
}

// ===== the lobby handshake (the Definition of Done)

test('a real client joins the server-hosted session: JOIN_REQ → JOIN_ACK + ROSTER', function () {
  return withServer(null, null, function (s) {
    return connected(s.wsUrl, 4242).then(function (c) {
      c.send(MP.T.JOIN_REQ, MP.packJoinReq(4242, { name: 'Боби', color: '#00aa55', gender: 'm' }, false));

      return c.expect(MP.T.JOIN_ACK, 'JOIN_ACK').then(function (ack) {
        var ja = MP.unpackJoinAck(ack.payload);
        assert.strictEqual(ja.eph, 4242, 'the ACK names the eph that asked');
        assert.ok(ja.id > 0, 'the server seated the client');
        assert.strictEqual(ack.sender, MP.HOST_ID, 'the session spoke, not another client');

        return c.expect(MP.T.ROSTER, 'ROSTER').then(function (r) {
          var roster = MP.unpackRoster(r.payload);
          assert.deepStrictEqual(roster.map(function (p) { return p.name; }), ['Боби']);
          assert.strictEqual(roster[0].id, ja.id);
          assert.strictEqual(s.room.session.roster.length, 1, 'the server-side session agrees');
          c.ws.close();
        });
      });
    });
  });
});

test('two clients converge on the same roster, and hear only the server', function () {
  return withServer(null, null, function (s) {
    var a, b;
    return connected(s.wsUrl, 11).then(function (c) { a = c; return a.join({ name: 'Ана', color: '#00aa55', gender: 'f' }); })
      .then(function () { return connected(s.wsUrl, 22); })
      .then(function (c) { b = c; return b.join({ name: 'Боби', color: '#5566ff', gender: 'm' }); })
      .then(function () {
        // A's ROSTER is re-sent on every join, so its LAST one has both names.
        function lastRoster(c) {
          var rs = c.heard.filter(function (f) { return f.type === MP.T.ROSTER; });
          return MP.unpackRoster(rs[rs.length - 1].payload).map(function (p) { return p.name; });
        }
        assert.deepStrictEqual(lastRoster(a), ['Ана', 'Боби']);
        assert.deepStrictEqual(lastRoster(b), ['Ана', 'Боби']);
        assert.notStrictEqual(a.id, b.id, 'distinct seats');
        // The star, over a real socket: neither client ever heard the other's
        // bytes. Every frame either of them got was spoken by the session.
        [a, b].forEach(function (c) {
          assert.ok(c.heard.length > 0);
          c.heard.forEach(function (f) { assert.strictEqual(f.sender, MP.HOST_ID); });
        });
        a.ws.close(); b.ws.close();
      });
  });
});

// ===== the server referees, it does not play

test('the server holds no seat: the first joiner is seat 1 and the turn order excludes the host', function () {
  return withServer(null, null, function (s) {
    assert.strictEqual(s.room.session.roster.length, 0, 'an empty room has an empty roster — no referee at the table');
    assert.strictEqual(s.room.session.myId, MP.HOST_ID, 'the session still SPEAKS as the host');

    var a, b;
    return connected(s.wsUrl, 11).then(function (c) { a = c; return a.join({ name: 'Ана', color: '#00aa55', gender: 'f' }); })
      .then(function () { return connected(s.wsUrl, 22); })
      .then(function (c) { b = c; return b.join({ name: 'Боби', color: '#5566ff', gender: 'm' }); })
      .then(function () {
        assert.deepStrictEqual([a.id, b.id], [1, 2], 'seats start at 1; seat 0 is nobody');

        assert.ok(s.room.session.startGame());
        assert.deepStrictEqual(s.room.session.order, [1, 2], 'the referee is not in the rotation');
        return b.expect(MP.T.GRANT, 'GRANT').then(function (g) {
          assert.strictEqual(MP.unpackGrant(g.payload).activeId, 1,
            'the first turn went to a player, not to the empty chair the host would have been');
          a.ws.close(); b.ws.close();
        });
      });
  });
});

// ===== a socket going away

test('a seated socket that vanishes marks its seat dropped', function () {
  return withServer(null, null, function (s) {
    var a, b;
    return connected(s.wsUrl, 11).then(function (c) { a = c; return a.join({ name: 'Ана', color: '#00aa55', gender: 'f' }); })
      .then(function () { return connected(s.wsUrl, 22); })
      .then(function (c) { b = c; return b.join({ name: 'Боби', color: '#5566ff', gender: 'm' }); })
      .then(function () {
        // The bus tags a socket with the seat it speaks for, and a JOIN_REQ is
        // sent UNASSIGNED — so the tag only appears once a SEATED client
        // speaks. RESYNC_REQ is the cheapest thing a client may say at any time.
        a.send(MP.T.RESYNC_REQ);
        return a.expect(MP.T.STATE, 'STATE (the resync that proves the seat was heard)');
      })
      .then(function () {
        b.heard.length = 0;                       // forget the joining ROSTERs: we want the one the drop causes
        var announced = b.expect(MP.T.ROSTER, 'the ROSTER announcing the drop');
        a.ws.close();
        return announced;
      })
      .then(function (r) {
        var gone = MP.unpackRoster(r.payload).filter(function (p) { return p.id === a.id; })[0];
        assert.ok(gone, 'the seat is kept, so the player can come back to it');
        assert.strictEqual(s.room.session.roster.filter(function (p) { return p.id === a.id; })[0].dropped, true);
        b.ws.close();
      });
  });
});

test('an unseated socket that vanishes drops nobody', function () {
  return withServer(null, null, function (s) {
    var a;
    return connected(s.wsUrl, 11).then(function (c) { a = c; return a.join({ name: 'Ана', color: '#00aa55', gender: 'f' }); })
      .then(function () {
        // A client that has been seated but has not SPOKEN as its seat is still
        // untagged on the bus, so its socket vanishing cannot name a seat to
        // drop. Phase 2.2 fixes that by binding seats by `eph` at JOIN_ACK
        // time; until then the seat simply lingers, which is the safe way to
        // be wrong — we never drop a seat on the word of a nibble a client chose.
        a.ws.close();
        return new Promise(function (r) { a.ws.once('close', r); });
      })
      .then(function () {
        var seat = s.room.session.roster.filter(function (p) { return p.id === a.id; })[0];
        assert.ok(seat, 'the seat is still there');
        assert.notStrictEqual(seat.dropped, true, 'nothing was dropped on an untagged socket');
      });
  });
});

// ===== closing the room

test('close() says goodbye before it closes the sockets', function () {
  return withServer(null, null, function (s) {
    var a;
    return connected(s.wsUrl, 11).then(function (c) { a = c; return a.join(); })
      .then(function () {
        var bye = a.expect(MP.T.BYE, 'BYE');
        var shut = a.closed();
        s.room.close('room closed');
        return bye.then(function () { return shut; });
      })
      .then(function (code) {
        assert.strictEqual(code, 1001, 'the socket closed with "going away", not a reset');
        assert.strictEqual(s.room.closed, true);
        assert.strictEqual(s.room.session.state, 'DEAD', 'dispose() ran — nothing is left ticking');
      });
  });
});

test('close() is idempotent and a closed room takes no more sockets', function () {
  return withServer(null, null, function (s) {
    assert.strictEqual(s.room.close('first'), true);
    assert.strictEqual(s.room.close('again'), false);
    assert.strictEqual(s.room.join({ id: 'late', onReceive: function () {}, onClose: function () {}, isOpen: function () { return true; }, send: function () {}, close: function () {} }), false);
  });
});

test('a socket arriving at a closed room is closed, not left hanging', function () {
  return withServer(null, null, function (s) {
    s.room.close('room closed');
    return connected(s.wsUrl, 11).then(function (c) {
      return c.closed().then(function (code) {
        assert.strictEqual(code, 1013, 'told to try again later, rather than silently ignored');
      });
    });
  });
});

// ===== shutdown, and the ops surface

test('shutdown drains the room before the port, so players are told', function () {
  var exited = [];
  return withServer(null, { exit: function (c) { exited.push(c); } }, function (s) {
    var a;
    return connected(s.wsUrl, 11).then(function (c) { a = c; return a.join(); })
      .then(function () {
        var bye = a.expect(MP.T.BYE, 'BYE during shutdown');
        return s.app.life.shutdown('test', 0).then(function () { return bye; });
      })
      .then(function () {
        assert.deepStrictEqual(exited, [0], 'drained cleanly');
        assert.strictEqual(s.app.listener.draining, true, 'the listener stopped accepting first');
      });
  });
});

test('the room reports itself through /healthz', function () {
  return withServer(null, null, function (s) {
    return connected(s.wsUrl, 11).then(function (c) { return c.join({ name: 'Ана', color: '#00aa55', gender: 'f' }); })
      .then(function () { return get(s.base + '/healthz'); })
      .then(function (body) {
        assert.strictEqual(body.rooms, 1);
        assert.strictEqual(body.room.state, 'LOBBY');
        assert.strictEqual(body.room.players, 1);
        assert.strictEqual(body.room.sockets, 1);
      });
  });
});

test('a room never seats a player at UNASSIGNED, however high the cap is set', function () {
  // MAX_PLAYERS_PER_ROOM may legally go up to 15, because the wire format's
  // sender nibble holds 0..15 — but that budget COUNTS THE HOST, and this host
  // takes no seat. Unclamped, a full room would seat someone at 15, which IS
  // `UNASSIGNED`: their frames would be indistinguishable from "not seated yet",
  // and the bus would never tag their socket, so their disconnect would drop
  // nobody.
  return withServer({ MAX_PLAYERS_PER_ROOM: '15' }, null, function (s) {
    assert.strictEqual(s.app.cfg.maxPlayersPerRoom, 15, 'the config still allows it');
    assert.strictEqual(s.room.session.maxPlayers, MP.UNASSIGNED - 1, 'the room does not');

    // Fill it, and check no seat collides with the sender nibble's reserved value.
    var seats = [];
    function joinOne(i) {
      if (i >= s.room.session.maxPlayers) return Promise.resolve();
      return connected(s.wsUrl, 100 + i)
        .then(function (c) { return c.join({ name: 'Боец ' + i, color: '#00aa55', gender: 'm' }); })
        .then(function (c) { seats.push(c.id); return joinOne(i + 1); });
    }
    return joinOne(0).then(function () {
      assert.strictEqual(seats.length, MP.UNASSIGNED - 1);
      assert.strictEqual(Math.max.apply(null, seats), MP.UNASSIGNED - 1, 'the last seat stops one short of UNASSIGNED');
      seats.forEach(function (id) {
        assert.notStrictEqual(id, MP.UNASSIGNED);
        assert.notStrictEqual(id, MP.HOST_ID);
      });
    });
  });
});

// ===== the Node-specific hazard

test("a room's timers are not a reason for the process to stay alive", function () {
  // mp.js re-arms the lobby beacon for as long as the room is open. In a browser
  // tab that is free; in Node an un-unref'd timer keeps the event loop running,
  // so a clean SIGTERM would hang until the shutdown deadline forced exit(1) —
  // which an orchestrator reads as a crashed process.
  var t = room.unrefTimeout(function () {}, 60000);
  assert.strictEqual(typeof t.hasRef, 'function');
  assert.strictEqual(t.hasRef(), false, 'the beacon must not hold the event loop open');
  clearTimeout(t);
});
