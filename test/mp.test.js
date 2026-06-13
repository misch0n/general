'use strict';

var test = require('node:test');
var assert = require('node:assert');
var MP = require('../mp.js');
var General = require('../game.js');
var CATS = General.CATEGORIES.map(function (c) { return c.key; });

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

// ---- compact record codec (acoustic transfer) ----
test('packRecord/unpackRecord round-trips scores, meta, ts and final dice', function () {
  var rec = {
    ts: 1700000000000, manualMode: false, ownerSkipped: false,
    players: [
      { name: 'Иван', color: '#ee0055', gender: 'm', owner: true, bonus: 5, scores: { ones: 3, general: 50 } },
      { name: 'Боби', color: '#00aa55', gender: 'f', owner: false, bonus: 0, scores: { ones: 2, twos: 6 } },
    ],
    moveLog: [
      [{ rolls: [[1, 2, 3, 4, 5], [1, 1, 3, 4, 5]], keeps: [[true, false, false, false, false]], category: 'ones' },
       { dice: [5, 5, 5, 5, 5], category: 'general' }],
      [{ dice: [2, 2, 4, 5, 6], category: 'twos' }],
    ],
  };
  var out = MP.unpackRecord(MP.packRecord(rec, CATS), CATS);
  assert.strictEqual(out.ts, 1700000000000);
  assert.strictEqual(out.players[0].name, 'Иван');
  assert.strictEqual(out.players[0].color, '#ee0055');
  assert.strictEqual(out.players[0].owner, true);
  assert.strictEqual(out.players[0].bonus, 5);
  assert.strictEqual(out.players[0].scores.general, 50);
  assert.strictEqual(out.players[1].gender, 'f');
  // final dice survive; mask is reconstructed from category order (0 then 'ones' bit)
  assert.deepStrictEqual(out.moveLog[0][0].dice, [1, 1, 3, 4, 5]); // last roll
  assert.strictEqual(out.moveLog[0][0].category, 'ones');
  assert.strictEqual(out.moveLog[0][0].mask, 0);
  assert.strictEqual(out.moveLog[0][1].category, 'general');
  assert.strictEqual(out.moveLog[0][1].mask, 1 << CATS.indexOf('ones'));
  assert.strictEqual(out.manualMode, true);  // transferred games analyse manual-style
});

// ---- sanitisation: data only, nothing executable or unknown survives ----
test('sanitizeRecord whitelists, clamps, and drops junk', function () {
  var dirty = {
    ts: 1700000000000, manualMode: true, evil: function () { return 1; }, __proto__hax: 1,
    players: [
      { name: 'X'.repeat(200), color: 'javascript:alert(1)', gender: 'zzz', bonus: 99999, owner: 'yes',
        scores: { ones: 9999, twos: 'NaN', notACategory: 5, __proto__: 9 }, run: function () {}, ribbons: ['#fff', 7, 'drop;'] },
    ],
    moveLog: [[{ category: '__proto__', dice: [9, 9, 9, 9, 9, 9], mask: 999999, hack: function () {} }]],
  };
  var clean = MP.sanitizeRecord(dirty, CATS);
  assert.ok(clean && typeof clean === 'object');
  assert.strictEqual(typeof clean.players[0].run, 'undefined', 'functions dropped');
  assert.ok(clean.players[0].name.length <= 40, 'name capped');
  assert.strictEqual(clean.players[0].color, '#888888', 'bad colour replaced');
  assert.strictEqual(clean.players[0].gender, 'm', 'bad gender defaulted');
  assert.strictEqual(clean.players[0].bonus, 999, 'bonus clamped');
  assert.strictEqual(clean.players[0].owner, true, 'owner coerced to bool');
  assert.strictEqual(clean.players[0].scores.ones, 1000, 'score clamped');
  assert.ok(!('notACategory' in clean.players[0].scores), 'unknown category dropped');
  assert.ok(!('twos' in clean.players[0].scores), 'non-number score dropped');
  assert.deepStrictEqual(clean.players[0].ribbons, ['#fff'], 'only valid ribbon strings');
  // category coerced to a real key, dice clamped to 0..6
  assert.ok(CATS.indexOf(clean.moveLog[0][0].category) >= 0);
  assert.ok(clean.moveLog[0][0].dice.every(function (v) { return v >= 0 && v <= 6; }));
  assert.strictEqual(MP.sanitizeRecord(null, CATS), null);
  assert.strictEqual(MP.sanitizeRecord({ players: [] }, CATS), null);
});

test('a packed record survives transfer-then-sanitise into a usable game', function () {
  var rec = { ts: 1700000000000, manualMode: false, players: [
    { name: 'Иван', color: '#ee0055', gender: 'm', owner: true, bonus: 0, scores: { ones: 3 } },
    { name: 'Боби', color: '#00aa55', gender: 'm', owner: false, bonus: 0, scores: { twos: 6 } } ],
    moveLog: [[{ dice: [1, 1, 1, 4, 5], category: 'ones' }], [{ dice: [2, 2, 4, 5, 6], category: 'twos' }]] };
  var clean = MP.sanitizeRecord(MP.unpackRecord(MP.packRecord(rec, CATS), CATS), CATS);
  assert.strictEqual(clean.players.length, 2);
  assert.strictEqual(clean.players[0].scores.ones, 3);
  assert.strictEqual(clean.moveLog[1][0].category, 'twos');
});

// ---- chunked acoustic transfer over the mock bus ----
test('Transfer: a blob sends + reassembles identically', function () {
  var bus = new Bus();
  var data = new Uint8Array(140); for (var i = 0; i < data.length; i++) data[i] = (i * 37 + 11) & 0xff;
  var got = null;
  var sender = new MP.Transfer({ transport: bus.transport(), mode: 'send', data: data,
    setTimeout: noTimers.setTimeout, clearTimeout: noTimers.clearTimeout, callbacks: {} });
  var recv = new MP.Transfer({ transport: bus.transport(), mode: 'recv',
    setTimeout: noTimers.setTimeout, clearTimeout: noTimers.clearTimeout, callbacks: { onComplete: function (b) { got = b; } } });
  recv.start(); sender.start();
  for (var k = 0; k < 200 && !got; k++) bus.drain();
  assert.ok(got, 'receiver completed');
  assert.deepStrictEqual(Array.from(got), Array.from(data), 'blob identical end to end');
});

// ---- adaptive link layer ----
test('pickProfile takes the fastest comfortably-below-threshold profile', function () {
  var L = MP.CAL_LADDER; // fastest → safest
  // transfer (fastest) is clean → pick it
  var r1 = {}; r1[L[0].id] = 0.01; r1[L[1].id] = 0.0; r1[L[2].id] = 0.0; r1[L[3].id] = 0.0;
  assert.strictEqual(MP.pickProfile(r1, { threshold: 0.05, margin: 0.5 }).id, L[0].id);
  // fastest is marginal (above comfortable but below thr), next is comfortable → take next
  var r2 = {}; r2[L[0].id] = 0.04; r2[L[1].id] = 0.01; r2[L[2].id] = 0; r2[L[3].id] = 0;
  assert.strictEqual(MP.pickProfile(r2, { threshold: 0.05, margin: 0.5 }).id, L[1].id);
  // all bad → anchor floor
  var r3 = {}; L.forEach(function (p) { r3[p.id] = 0.9; });
  assert.strictEqual(MP.pickProfile(r3, { threshold: 0.05 }).id, MP.ANCHOR.id);
});

test('LinkMeter: bars/state track errors; ECC load is an early warning', function () {
  var m = new MP.LinkMeter({ window: 10 });
  for (var i = 0; i < 10; i++) m.record({ ok: true, ecc: 0.05 });
  assert.strictEqual(m.state(), 'GOOD');
  assert.strictEqual(m.bars(), 4);
  // clean decodes but ECC working hard → DEGRADING before any failure
  var m2 = new MP.LinkMeter({ window: 10 });
  for (i = 0; i < 10; i++) m2.record({ ok: true, ecc: 0.7 });
  assert.strictEqual(m2.errorRate(), 0);
  assert.strictEqual(m2.state(), 'DEGRADING', 'ecc load warns before failures');
  // lots of failures → CRITICAL, few bars
  var m3 = new MP.LinkMeter({ window: 10 });
  for (i = 0; i < 10; i++) m3.record({ ok: i % 2 === 0 ? true : false });
  assert.strictEqual(m3.state(), 'CRITICAL');
  assert.ok(m3.bars() <= 1);
});

test('AdaptiveController: hysteresis before stepping, cooldown after', function () {
  var a = new MP.AdaptiveController({ consecutive: 3, cooldown: 5 });
  assert.strictEqual(a.sample('DEGRADING'), null);   // 1
  assert.strictEqual(a.sample('DEGRADING'), null);   // 2
  assert.strictEqual(a.sample('DEGRADING'), 'down');  // 3 → step down
  assert.strictEqual(a.sample('DEGRADING'), null, 'cooldown blocks immediate re-trigger');
  // a single GOOD breaks a DEGRADING streak (no flapping)
  var b = new MP.AdaptiveController({ consecutive: 3, cooldown: 0 });
  b.sample('DEGRADING'); b.sample('GOOD'); b.sample('DEGRADING'); b.sample('DEGRADING');
  assert.strictEqual(b.sample('DEGRADING'), 'down', 'needs 3 consecutive after the break');
  // sustained critical → recalibrate
  var c = new MP.AdaptiveController({ consecutive: 2, cooldown: 0 });
  c.sample('CRITICAL');
  assert.strictEqual(c.sample('CRITICAL'), 'recal');
});

test('relay/gossip guards keep the host the single source of truth', function () {
  assert.strictEqual(MP.acceptRelayVersion(5, 4), true);   // newer relayed state accepted
  assert.strictEqual(MP.acceptRelayVersion(4, 4), false);  // stale relay ignored
  assert.strictEqual(MP.acceptRelayVersion(3, 4), false);
  assert.strictEqual(MP.isBehind(2, 5), true);             // gossip: peer ahead → I resync from host
  assert.strictEqual(MP.isBehind(5, 5), false);
  // a hash detects divergence at the same version
  assert.notStrictEqual(MP.stateHash({ 0: { 0: 3 } }), MP.stateHash({ 0: { 0: 4 } }));
});

test('adaptive schemas round-trip', function () {
  var ps = MP.unpackProfileSwitch(MP.packProfileSwitch(2, 17)); assert.strictEqual(ps.profileId, 2); assert.strictEqual(ps.effVersion, 17);
  var q = MP.unpackQuality(MP.packQuality(3, 12, 60)); assert.deepStrictEqual(q, { bars: 3, errorPct: 12, eccPct: 60 });
  var g = MP.unpackGossip(MP.packGossip(9, 0xabcd)); assert.strictEqual(g.version, 9); assert.strictEqual(g.hash, 0xabcd);
  var rl = MP.unpackRelay(MP.packRelay(7, new Uint8Array([1, 2, 3]))); assert.strictEqual(rl.version, 7); assert.deepStrictEqual(Array.from(rl.snapshot), [1, 2, 3]);
  var cr = MP.unpackCalReport(MP.packCalReport([{ profileId: 3, errorRate: 0.0, snr: 20 }, { profileId: 0, errorRate: 0.5, snr: -8 }]));
  assert.strictEqual(cr[0].profileId, 3); assert.ok(Math.abs(cr[0].errorRate - 0) < 0.01); assert.strictEqual(cr[1].snr, -8);
});

// ---- adaptive layer wired into Session ----
test('PROFILE_SWITCH: host switches, client adopts it and acks', function () {
  var bus = new Bus();
  var hostTp = bus.transport(), clientTp = bus.transport();
  var hp = null, cp = null; hostTp.setProfile = function (p) { hp = p; }; clientTp.setProfile = function (p) { cp = p; };
  var sent = []; var real = clientTp.send; clientTp.send = function (b) { sent.push(MP.unframe(b)); return real(b); };
  var host = new MP.Session({ transport: hostTp, isHost: true, me: { name: 'H', color: '#fff', gender: 'm' }, setTimeout: noTimers.setTimeout, clearTimeout: noTimers.clearTimeout, callbacks: {} });
  var c = new MP.Session({ transport: clientTp, isHost: false, me: { name: 'C', color: '#fff', gender: 'm' }, setTimeout: noTimers.setTimeout, clearTimeout: noTimers.clearTimeout, callbacks: {} });
  host.openLobby(); c.requestJoin(); bus.drain();
  host.switchProfile(2); bus.drain();
  assert.strictEqual(c.profile.id, 2, 'client adopted the new profile');
  assert.strictEqual(cp.id, 2, 'client transport reconfigured');
  assert.ok(sent.some(function (p) { return p && p.type === MP.T.CAL_CONFIRM; }), 'client acked the switch');
});

test('calibrate probes the ladder and switches to the fastest comfortable profile', function () {
  var bus = new Bus();
  var hostTp = bus.transport(); hostTp.setProfile = function () {};
  hostTp.measureProbe = function (p, cb) { cb(p.id === 3 ? 0.2 : p.id === 2 ? 0.01 : 0.0); };  // transfer bad, setup clean
  var host = new MP.Session({ transport: hostTp, isHost: true, me: { name: 'H', color: '#fff', gender: 'm' }, setTimeout: noTimers.setTimeout, clearTimeout: noTimers.clearTimeout, callbacks: {} });
  var chosen = null; host.calibrate(function (p) { chosen = p; });
  assert.strictEqual(chosen.id, 2, 'fastest comfortable profile (setup)');
  assert.strictEqual(host.profile.id, 2);
});

test('onLink surfaces bars/state from decode outcomes', function () {
  var bus = new Bus(); var seen = [];
  var c = new MP.Session({ transport: bus.transport(), isHost: false, me: { name: 'C', color: '#fff', gender: 'm' }, setTimeout: noTimers.setTimeout, clearTimeout: noTimers.clearTimeout, callbacks: { onLink: function (l) { seen.push(l); } } });
  c._rx(MP.frame(MP.T.PING, 0, 1, new Uint8Array(0)));
  assert.strictEqual(seen[seen.length - 1].state, 'GOOD');
  for (var i = 0; i < 12; i++) c._rx(new Uint8Array([9, 9]));   // undecodable bytes
  assert.ok(['DEGRADING', 'CRITICAL'].indexOf(seen[seen.length - 1].state) >= 0, 'link reads degraded');
});

test('GOSSIP: a peer ahead makes a behind client resync from the host', function () {
  var bus = new Bus(); var sent = [];
  var tp = bus.transport(); var real = tp.send; tp.send = function (b) { sent.push(MP.unframe(b)); return real(b); };
  var c = new MP.Session({ transport: tp, isHost: false, me: { name: 'C', color: '#fff', gender: 'm' }, setTimeout: noTimers.setTimeout, clearTimeout: noTimers.clearTimeout, callbacks: {} });
  c.version = 2;
  c._rx(MP.frame(MP.T.GOSSIP, 1, 1, MP.packGossip(5, 0xabcd)));
  assert.ok(sent.some(function (p) { return p && p.type === MP.T.RESYNC_REQ; }), 'detected divergence → resync from host');
});
