'use strict';

var test = require('node:test');
var assert = require('node:assert');
var MP = require('../mp.js');

// ---- a mock broadcast bus: every node hears every send except its own (half-duplex),
// delivered when drain() runs. Optional drop set simulates loss. ----
function Bus() { this.nodes = []; this.q = []; this.drop = null; }
Bus.prototype.transport = function () {
  var bus = this, node = { cb: null };
  node.tp = {
    maxPayload: 64,
    send: function (bytes) { bus.q.push({ from: node, bytes: bytes }); return Promise.resolve(); },
    onReceive: function (cb) { node.cb = cb; },
  };
  this.nodes.push(node);
  return node.tp;
};
Bus.prototype.drain = function () {
  var guard = 0;
  while (this.q.length && guard++ < 100000) {
    var m = this.q.shift();
    for (var i = 0; i < this.nodes.length; i++) {
      var n = this.nodes[i];
      if (n === m.from || !n.cb) continue;
      if (this.drop && this.drop(m, n)) continue;
      n.cb(m.bytes);
    }
  }
};

var noTimers = { setTimeout: function () { return 0; }, clearTimeout: function () {} };

// ---- L1 framing + CRC ----
test('frame/unframe round-trips and rejects corruption', function () {
  var pay = new Uint8Array([10, 20, 30]);
  var f = MP.frame(MP.T.MOVE, 3, 42, pay);
  var u = MP.unframe(f);
  assert.strictEqual(u.type, MP.T.MOVE);
  assert.strictEqual(u.sender, 3);
  assert.strictEqual(u.seq, 42);
  assert.deepStrictEqual(Array.from(u.payload), [10, 20, 30]);
  var bad = f.slice(); bad[2] ^= 0xff;                 // flip a header bit
  assert.strictEqual(MP.unframe(bad), null);           // CRC catches it
  assert.strictEqual(MP.unframe(new Uint8Array([1, 2])), null);
});

// ---- schema pack/unpack ----
test('player meta + roster pack/unpack preserve name/colour/gender', function () {
  var players = [
    { id: 0, name: 'Иван', color: '#ee0055', gender: 'm' },
    { id: 2, name: 'Капитан Стоманено Динамо', color: '#00aa55', gender: 'n' },
  ];
  var r = MP.unpackRoster(MP.packRoster(players));
  assert.strictEqual(r.length, 2);
  assert.strictEqual(r[0].name, 'Иван');
  assert.strictEqual(r[0].color, '#ee0055');
  assert.strictEqual(r[1].gender, 'n');
  assert.ok(/Капитан/.test(r[1].name));
});

test('move pack/unpack preserves category, score, rolls and keeps', function () {
  var mv = { playerId: 2, ackVersion: 7, category: 13, score: 50, rolls: [[1, 2, 3, 4, 5], [5, 5, 3, 4, 5], [5, 5, 5, 4, 5]], keeps: [[false, false, true, true, true], [true, true, false, true, true]] };
  var out = MP.unpackMove(MP.packMove(mv));
  assert.strictEqual(out.playerId, 2);
  assert.strictEqual(out.ackVersion, 7);
  assert.strictEqual(out.category, 13);
  assert.strictEqual(out.score, 50);
  assert.deepStrictEqual(out.rolls, mv.rolls);
  assert.deepStrictEqual(out.keeps, mv.keeps);
});

test('state delta + snapshot pack/unpack', function () {
  var d = MP.unpackState(MP.packStateDelta(9, { playerId: 1, category: 4, score: 12 }));
  assert.strictEqual(d.kind, 'delta'); assert.strictEqual(d.version, 9); assert.strictEqual(d.score, 12);
  var snap = MP.unpackState(MP.packStateSnapshot(5, { 0: { 0: 3, 13: 50 }, 1: { 0: 2 } }));
  assert.strictEqual(snap.kind, 'snapshot'); assert.strictEqual(snap.version, 5);
  assert.strictEqual(snap.scores[0][13], 50); assert.strictEqual(snap.scores[1][0], 2);
});

// ---- full lobby → game → end over the mock bus, 3 devices ----
function nextCat(sess, id) {
  var cells = sess.scores[id] || {};
  for (var c = 0; c < 14; c++) if (cells[c] == null) return c;
  return -1;
}

test('host + 2 clients: lobby, roster, full game, consistent final state', function () {
  var bus = new Bus();
  var ended = {};
  function mk(isHost, me) {
    return new MP.Session({ transport: bus.transport(), isHost: isHost, me: me, minPlayers: 2, maxPlayers: 6,
      setTimeout: noTimers.setTimeout, clearTimeout: noTimers.clearTimeout,
      callbacks: { onEnd: function () { ended[me.name] = true; } } });
  }
  var host = mk(true, { name: 'Иван', color: '#ee0055', gender: 'm' });
  var c1 = mk(false, { name: 'Боби', color: '#00aa55', gender: 'm' });
  var c2 = mk(false, { name: 'Мими', color: '#5566ff', gender: 'f' });
  var nodes = [host, c1, c2];

  host.openLobby();
  c1.requestJoin(); c2.requestJoin();
  bus.drain();
  assert.strictEqual(host.roster.length, 3, 'host enrolled both clients');
  assert.ok(c1.myId > 0 && c2.myId > 0 && c1.myId !== c2.myId, 'distinct ids assigned');
  // roster carries metadata to clients
  assert.deepStrictEqual(c1.roster.map(function (p) { return p.name; }), ['Иван', 'Боби', 'Мими']);
  assert.strictEqual(c2.roster.find(function (p) { return p.id === c2.myId; }).gender, 'f');

  assert.ok(host.startGame());
  bus.drain();
  assert.strictEqual(c1.state, 'IN_GAME');

  // play every turn: whoever holds the grant submits their next category
  for (var guard = 0; guard < 5000 && host.state === 'IN_GAME'; guard++) {
    var actId = host.activeId;
    var active = nodes.filter(function (n) { return n.myId === actId; })[0];
    var cat = nextCat(active, actId);
    assert.ok(cat >= 0, 'active player has an open category');
    active.submitMove({ category: cat, score: 1 + cat, rolls: [[1, 2, 3, 4, 5]], keeps: [] });
    bus.drain();
  }

  assert.ok(ended['Иван'] && ended['Боби'] && ended['Мими'], 'END reached on all devices');
  assert.strictEqual(host.version, 3 * 14, 'one version bump per move');
  // every device converged on the same scoreboard
  [c1, c2].forEach(function (n) {
    assert.strictEqual(n.version, host.version, 'client version matches host');
    assert.deepStrictEqual(n.scores, host.scores, 'client scoreboard matches host');
  });
});

// ---- idempotency: replaying a move must not double-apply ----
test('applying the same move twice is a no-op (idempotent)', function () {
  var bus = new Bus();
  var host = new MP.Session({ transport: bus.transport(), isHost: true, me: { name: 'H', color: '#fff', gender: 'm' },
    setTimeout: noTimers.setTimeout, clearTimeout: noTimers.clearTimeout, callbacks: {} });
  host.openLobby();
  host.order = [0]; host.state = 'IN_GAME'; host.activeId = 0;
  assert.strictEqual(host._applyMove({ playerId: 0, category: 0, score: 3 }), true);
  assert.strictEqual(host.version, 1);
  assert.strictEqual(host._applyMove({ playerId: 0, category: 0, score: 3 }), false); // dup
  assert.strictEqual(host.version, 1, 'version unchanged on duplicate');
});

// ---- a version gap triggers a RESYNC_REQ, snapshot re-baselines ----
test('client detects a version gap and resyncs from a snapshot', function () {
  var bus = new Bus();
  var sent = [];
  var tp = bus.transport();
  var realSend = tp.send; tp.send = function (b) { sent.push(MP.unframe(b)); return realSend(b); };
  var c = new MP.Session({ transport: tp, isHost: false, me: { name: 'C', color: '#fff', gender: 'm' },
    setTimeout: noTimers.setTimeout, clearTimeout: noTimers.clearTimeout, callbacks: {} });
  c.myId = 1; c.state = 'IN_GAME'; c.version = 2; c.scores = {};
  // a delta two versions ahead → gap
  c._rxState(MP.unpackState(MP.packStateDelta(4, { playerId: 0, category: 0, score: 9 })));
  assert.ok(sent.some(function (p) { return p && p.type === MP.T.RESYNC_REQ; }), 'sent RESYNC_REQ on gap');
  assert.strictEqual(c.version, 2, 'did not apply the out-of-order delta');
  // host answers with a snapshot
  c._rxState(MP.unpackState(MP.packStateSnapshot(4, { 0: { 0: 9, 1: 4 } })));
  assert.strictEqual(c.version, 4);
  assert.strictEqual(c.scores[0][1], 4, 're-baselined from snapshot');
});
