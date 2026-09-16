'use strict';
/*
 * Phase 1.1 — SocketBus: a room's sockets fanned into the one transport
 * MP.Session expects.
 *
 * The claim under test is the TOPOLOGY, not the bytes (test/server/listener.test.js
 * already proved frames survive a real socket): the bus must behave as the STAR
 * that test/webrtc.test.js pins for the browser's PeerBus — the host reaches
 * every client, a client reaches only the host, and clients never hear each
 * other. The last part is the authority model, not an optimisation: relaying a
 * client's bytes to its peers would let a client speak with the host's voice.
 *
 * The final test therefore drives REAL MP.Sessions over the bus, so the
 * assertion is "the session contract holds", not "the code calls its own
 * helpers".
 */

var test = require('node:test');
var assert = require('node:assert');

var MP = require('../../mp.js');
var General = require('../../game.js');
var socketBus = require('../../server/socket-bus.js');

// ===== harness

// Stands in for listener.js's socket wrapper: same { id, send, onReceive,
// onClose, close } surface, plus test hooks (`sent`, `deliver`).
function mockConn(id) {
  var rx = null, closeCb = null;
  var c = {
    id: id,
    sent: [],            // frames the bus wrote to this socket
    closed: false,
    onSend: null,        // test hook: called with every frame written here
    send: function (bytes) {
      if (c.closed) return Promise.resolve(false);
      c.sent.push(bytes);
      if (c.onSend) c.onSend(bytes);
      return Promise.resolve(true);
    },
    onReceive: function (fn) { rx = fn; },
    onClose: function (fn) { closeCb = fn; },
    close: function () {
      if (c.closed) return;
      c.closed = true;
      if (closeCb) closeCb(c, 1000);
    },
    // Simulate a frame arriving from the peer at the other end of this socket.
    deliver: function (bytes) { if (rx) rx(bytes); },
  };
  return c;
}

function frameFrom(sender, type, payload) {
  return MP.frame(type == null ? MP.T.PING : type, sender, 0, payload || new Uint8Array(0));
}

var noTimers = { setTimeout: function () { return 0; }, clearTimeout: function () {} };

function nextCat(node, id) {
  var sc = node.scores[id] || {};
  for (var i = 0; i < General.CATEGORIES.length; i++) if (sc[i] == null) return i;
  return -1;
}

// ===== fan-out (host → every client)

test('send() fans one frame out to every connection in the room', function () {
  var bus = socketBus.create({});
  var a = mockConn('a'), b = mockConn('b'), c = mockConn('c');
  [a, b, c].forEach(function (x) { bus.add(x); });

  var pkt = frameFrom(MP.HOST_ID);
  return bus.send(pkt).then(function (n) {
    assert.strictEqual(n, 3, 'all three sockets were written');
    [a, b, c].forEach(function (x) {
      assert.strictEqual(x.sent.length, 1, x.id + ' got the frame');
      assert.strictEqual(x.sent[0], pkt, 'the same bytes, not a per-socket copy');
    });
  });
});

test('send() on an empty bus resolves 0 rather than throwing', function () {
  var bus = socketBus.create({});
  return bus.send(frameFrom(MP.HOST_ID)).then(function (n) { assert.strictEqual(n, 0); });
});

// ===== fan-in (client → host only)

test('a frame from any connection reaches the session, and no other connection', function () {
  var bus = socketBus.create({});
  var a = mockConn('a'), b = mockConn('b');
  bus.add(a); bus.add(b);
  var got = [];
  bus.onReceive(function (bytes) { got.push(bytes); });

  var pkt = frameFrom(3);
  a.deliver(pkt);

  assert.deepStrictEqual(got, [pkt], 'the session received it verbatim');
  assert.strictEqual(b.sent.length, 0, 'the peer heard nothing — clients do not hear each other');
  assert.strictEqual(a.sent.length, 0, 'not echoed back to the sender either');
});

test('a corrupt frame is dropped at the bus and never reaches the session', function () {
  var bus = socketBus.create({});
  var a = mockConn('a');
  bus.add(a);
  var got = 0;
  bus.onReceive(function () { got++; });

  var pkt = frameFrom(3);
  var bad = pkt.slice(); bad[bad.length - 1] ^= 0xff;   // break the CRC
  a.deliver(bad);
  assert.strictEqual(got, 0, 'CRC mismatch = "not received", by design');

  a.deliver(pkt);
  assert.strictEqual(got, 1, 'a good frame still gets through');
});

test('an inbound frame tags its socket with the seat it speaks for', function () {
  var bus = socketBus.create({});
  var a = mockConn('a');
  bus.add(a);
  bus.onReceive(function () {});

  a.deliver(frameFrom(15));                       // UNASSIGNED: not seated yet
  assert.strictEqual(a.pid, undefined, 'a pre-join client claims no seat');

  a.deliver(frameFrom(4));
  assert.strictEqual(a.pid, 4, 'the seat behind this socket is now known');

  a.deliver(frameFrom(MP.HOST_ID));               // the host is us, never a client
  assert.strictEqual(a.pid, 4, 'a host-sender frame does not re-tag the socket');
});

// ===== membership

test('add() is idempotent and counts peers; remove() detaches silently', function () {
  var peers = [], lost = [];
  var bus = socketBus.create({ onPeers: function (n) { peers.push(n); }, onLost: function (c) { lost.push(c.id); } });
  var a = mockConn('a');

  assert.strictEqual(bus.add(a), true);
  assert.strictEqual(bus.add(a), false, 'the same socket cannot join twice');
  assert.strictEqual(bus.size(), 1);
  assert.strictEqual(bus.has(a), true);

  assert.strictEqual(bus.remove(a), true);
  assert.strictEqual(bus.remove(a), false);
  assert.strictEqual(bus.has(a), false);
  assert.deepStrictEqual(peers, [1, 0]);
  assert.deepStrictEqual(lost, [], 'our own removal is not a player dropping');
});

test('a socket closing drops it from the bus and reports the lost seat once', function () {
  var lost = [];
  var bus = socketBus.create({ onLost: function (c) { lost.push({ id: c.id, pid: c.pid }); } });
  var a = mockConn('a'), b = mockConn('b');
  bus.add(a); bus.add(b);
  bus.onReceive(function () {});
  a.deliver(frameFrom(2));                        // a now holds seat 2

  a.close();
  a.close();                                      // a second close must not double-report

  assert.deepStrictEqual(lost, [{ id: 'a', pid: 2 }], 'the layer above learns WHICH seat vanished');
  assert.strictEqual(bus.size(), 1);
  assert.deepStrictEqual(bus.peers(), [b]);
});

test('a frame still in flight from a departed socket does not reach the session', function () {
  var bus = socketBus.create({});
  var a = mockConn('a');
  bus.add(a);
  var got = 0;
  bus.onReceive(function () { got++; });

  bus.remove(a);
  a.deliver(frameFrom(2));
  assert.strictEqual(got, 0, 'a ghost of a player that is already gone');
});

test('a departed socket is no longer written to', function () {
  var bus = socketBus.create({});
  var a = mockConn('a'), b = mockConn('b');
  bus.add(a); bus.add(b);
  a.close();
  return bus.send(frameFrom(MP.HOST_ID)).then(function (n) {
    assert.strictEqual(n, 1);
    assert.strictEqual(a.sent.length, 0);
    assert.strictEqual(b.sent.length, 1);
  });
});

// ===== the invariant: one bad connection must never take the process down

test('send() never rejects, whatever a socket does', function () {
  var bus = socketBus.create({});
  var thrower = mockConn('thrower');
  thrower.send = function () { throw new Error('socket died mid-write'); };
  var rejecter = mockConn('rejecter');
  rejecter.send = function () { return Promise.reject(new Error('nope')); };
  var refuser = mockConn('refuser');
  refuser.send = function () { return Promise.resolve(false); };   // listener.js's "could not write"
  var good = mockConn('good');
  [thrower, rejecter, refuser, good].forEach(function (c) { bus.add(c); });

  return bus.send(frameFrom(MP.HOST_ID)).then(function (n) {
    assert.strictEqual(n, 1, 'only the healthy socket counts as delivered');
    assert.strictEqual(good.sent.length, 1, 'one bad peer does not stop the rest of the room');
  });
});

test('a socket that closes during the fan-out does not corrupt the iteration', function () {
  var bus = socketBus.create({});
  var a = mockConn('a'), b = mockConn('b'), c = mockConn('c');
  [a, b, c].forEach(function (x) { bus.add(x); });
  a.onSend = function () { b.close(); };           // writing to `a` kills `b` mid-loop

  return bus.send(frameFrom(MP.HOST_ID)).then(function () {
    assert.strictEqual(c.sent.length, 1, 'the socket after the closed one still got the frame');
    assert.strictEqual(bus.size(), 2);
  });
});

// ===== teardown

test('stop() closes every socket, reports no losses, and refuses new ones', function () {
  var lost = [], peers = [];
  var bus = socketBus.create({ onLost: function (c) { lost.push(c.id); }, onPeers: function (n) { peers.push(n); } });
  var a = mockConn('a'), b = mockConn('b');
  bus.add(a); bus.add(b);
  bus.onReceive(function () { throw new Error('nothing should arrive after stop()'); });

  bus.stop(4000, 'room closed');

  assert.ok(a.closed && b.closed, 'both sockets were closed');
  assert.deepStrictEqual(lost, [], 'tearing the room down is not a player dropping');
  assert.deepStrictEqual(peers, [1, 2, 0]);
  assert.strictEqual(bus.size(), 0);
  assert.strictEqual(bus.add(mockConn('late')), false, 'a stopped bus takes no new sockets');
  a.deliver(frameFrom(2));                         // must not reach the onReceive above
});

// ===== the real thing: MP.Session over the bus

/*
 * Host session on the bus, two client sessions on mock sockets. Frames are
 * queued and drained (rather than delivered re-entrantly) for the same reason
 * test/webrtc.test.js queues them: a real socket never calls back into the
 * sender's stack.
 */
function starHarness() {
  var q = [];
  var bus = socketBus.create({});
  var nodes = [];

  function client(me) {
    var conn = mockConn('c' + (nodes.length + 1));
    var node = { conn: conn, rx: null, heard: [] };
    conn.onSend = function (bytes) { q.push({ to: node, bytes: bytes }); };          // host → this client
    var tp = {
      send: function (bytes) { q.push({ to: 'host', from: node, bytes: bytes }); return Promise.resolve(); },
      onReceive: function (cb) { node.rx = cb; },
    };
    node.session = new MP.Session({
      transport: tp, isHost: false, me: me, minPlayers: 2, maxPlayers: 6,
      rounds: General.CATEGORIES.length,
      setTimeout: noTimers.setTimeout, clearTimeout: noTimers.clearTimeout, callbacks: {},
    });
    bus.add(conn);
    nodes.push(node);
    return node;
  }

  function drain() {
    var guard = 0;
    while (q.length && guard++ < 100000) {
      var m = q.shift();
      if (m.to === 'host') { m.from.conn.deliver(m.bytes); continue; }
      var f = MP.unframe(m.bytes);
      m.to.heard.push(f ? f.sender : null);
      if (m.to.rx) m.to.rx(m.bytes);
    }
  }

  return { bus: bus, client: client, drain: drain, nodes: nodes };
}

test('star over SocketBus: a host Session enrolls two clients and every frame a client hears came from the host', function () {
  var h = starHarness();
  var host = new MP.Session({
    transport: h.bus, isHost: true, me: { name: 'Иван', color: '#ee0055', gender: 'm' },
    minPlayers: 2, maxPlayers: 6, rounds: General.CATEGORIES.length,
    setTimeout: noTimers.setTimeout, clearTimeout: noTimers.clearTimeout, callbacks: {},
  });
  var a = h.client({ name: 'Боби', color: '#00aa55', gender: 'm' });
  var b = h.client({ name: 'Мими', color: '#5566ff', gender: 'f' });

  host.openLobby();
  a.session.requestJoin(); b.session.requestJoin();
  h.drain();

  assert.strictEqual(host.roster.length, 3, 'the host enrolled both clients over the bus');
  assert.ok(a.session.myId > 0 && b.session.myId > 0 && a.session.myId !== b.session.myId, 'distinct seats');
  // Neither client ever heard the other, yet both know the full roster — the
  // host re-emitted it. That IS the star.
  assert.deepStrictEqual(a.session.roster.map(function (p) { return p.name; }), ['Иван', 'Боби', 'Мими']);
  assert.deepStrictEqual(b.session.roster.map(function (p) { return p.name; }), ['Иван', 'Боби', 'Мими']);
  h.nodes.forEach(function (n) {
    assert.ok(n.heard.length > 0, 'the client heard something at all');
    n.heard.forEach(function (sender) {
      assert.strictEqual(sender, MP.HOST_ID, 'every frame a client hears is spoken by the host');
    });
  });

  // The seat tag only appears once a SEATED client speaks: a JOIN_REQ carries
  // the UNASSIGNED sender nibble, because the client has no id to name yet. That
  // is the right shape — an untagged socket holds no seat to release — but it
  // means the tag is a hint, not a registry. (Phase 2.2's reconnect path binds
  // seats by `eph` at JOIN_ACK time, which is authoritative.)
  assert.deepStrictEqual(h.nodes.map(function (n) { return n.conn.pid; }), [undefined, undefined]);
  a.session.setReady(true); b.session.setReady(true);
  h.drain();
  assert.deepStrictEqual(h.nodes.map(function (n) { return n.conn.pid; }),
    [a.session.myId, b.session.myId], 'the sockets now carry the seats they speak for');
});

test('star over SocketBus: a client move reaches the other client only via the host', function () {
  var h = starHarness();
  var host = new MP.Session({
    transport: h.bus, isHost: true, me: { name: 'H', color: '#ee0055', gender: 'm' },
    minPlayers: 2, maxPlayers: 6, rounds: General.CATEGORIES.length,
    setTimeout: noTimers.setTimeout, clearTimeout: noTimers.clearTimeout, callbacks: {},
  });
  var a = h.client({ name: 'A', color: '#00aa55', gender: 'm' });
  var b = h.client({ name: 'B', color: '#5566ff', gender: 'f' });

  host.openLobby(); a.session.requestJoin(); b.session.requestJoin(); h.drain();
  assert.ok(host.startGame()); h.drain();
  assert.strictEqual(a.session.state, 'IN_GAME');
  assert.strictEqual(b.session.state, 'IN_GAME');

  var all = [{ session: host }, a, b], moved = false;
  for (var g = 0; g < 5000 && host.state === 'IN_GAME' && !moved; g++) {
    var actId = host.activeId;
    var active = all.filter(function (n) { return n.session.myId === actId; })[0].session;
    var cat = nextCat(active, actId);
    assert.ok(cat >= 0, 'the active player has an open category');
    if (active === host) { active.submitMove({ category: cat, score: 1, rolls: [[1, 2, 3, 4, 5]], keeps: [] }); h.drain(); continue; }

    var vBefore = host.version;
    active.submitMove({ category: cat, score: 42, rolls: [[1, 2, 3, 4, 5]], keeps: [] });
    h.drain();
    var other = active === a.session ? b.session : a.session;
    assert.strictEqual(host.scores[actId][cat], 42, 'the host applied the client move');
    assert.strictEqual(other.scores[actId][cat], 42, 'the other client got it from the host rebroadcast');
    assert.strictEqual(host.version, vBefore + 1, 'exactly one version bump');
    moved = true;
  }
  assert.ok(moved, 'a client took at least one turn');
});
