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

test('move pack/unpack preserves the canonical move action (playerId, category, score, log)', function () {
  // the turn detail (rolls/keeps) rides inside the JSON `log`, not a binary sidecar
  var log = JSON.stringify({ category: 'general', rolls: [[1, 2, 3, 4, 5], [5, 5, 3, 4, 5], [5, 5, 5, 4, 5]], keeps: [[false, false, true, true, true], [true, true, false, true, true]] });
  var mv = { playerId: 2, category: 13, score: 50, log: log };
  var out = MP.unpackMove(MP.packMove(mv));
  assert.strictEqual(out.playerId, 2);
  assert.strictEqual(out.category, 13);
  assert.strictEqual(out.score, 50);
  assert.strictEqual(out.log, log);
  assert.deepStrictEqual(JSON.parse(out.log).rolls, JSON.parse(log).rolls);
});

test('state delta + snapshot pack/unpack', function () {
  var d = MP.unpackState(MP.packStateDelta(9, { playerId: 1, category: 4, score: 12, log: 'L' }));
  assert.strictEqual(d.kind, 'delta'); assert.strictEqual(d.version, 9); assert.strictEqual(d.score, 12);
  assert.strictEqual(d.playerId, 1); assert.strictEqual(d.category, 4); assert.strictEqual(d.log, 'L');
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

// ---- Step 0 (Task A 5c-remainder): the loopback safety net for the net-payload rewrite.
// The full-game test above proves the numeric SCOREBOARD converges; this proves the full
// per-player TURN LOG (the canonical JSON the wire carries in mv.log) converges on every
// device too — host included — propagating intact host→clients (STATE delta) AND
// client→host (MOVE). That log is the part the payload rewrite must not regress. ----
test('host + 2 clients: per-player turn LOGS converge across the wire', function () {
  var bus = new Bus();
  function mk(isHost, me) {
    var logs = {};   // playerId -> [reconstructed turn-log entries], in arrival order
    var s = new MP.Session({ transport: bus.transport(), isHost: isHost, me: me, minPlayers: 2, maxPlayers: 6,
      setTimeout: noTimers.setTimeout, clearTimeout: noTimers.clearTimeout,
      callbacks: { onMove: function (mv) { (logs[mv.playerId] || (logs[mv.playerId] = [])).push(mv.log ? JSON.parse(mv.log) : null); } } });
    s._logs = logs;
    return s;
  }
  var host = mk(true, { name: 'Иван', color: '#ee0055', gender: 'm' });
  var c1 = mk(false, { name: 'Боби', color: '#00aa55', gender: 'm' });
  var c2 = mk(false, { name: 'Мими', color: '#5566ff', gender: 'f' });
  var nodes = [host, c1, c2];

  host.openLobby(); c1.requestJoin(); c2.requestJoin(); bus.drain();
  assert.ok(host.startGame()); bus.drain();

  for (var guard = 0; guard < 5000 && host.state === 'IN_GAME'; guard++) {
    var actId = host.activeId;
    var active = nodes.filter(function (n) { return n.myId === actId; })[0];
    var cat = nextCat(active, actId);
    // a representative turn-log entry (the same JSON shape afterCommit ships in mv.log)
    var entry = { category: CATS[cat], rolls: [[1, 2, 3, 4, 5]], keeps: [], mask: cat };
    active.submitMove({ category: cat, score: 1 + cat, log: JSON.stringify(entry) });
    bus.drain();
  }

  [c1, c2].forEach(function (n) {
    assert.deepStrictEqual(n._logs, host._logs, 'per-player turn logs match the host');
  });
  // the logs carry the real turn detail, not a fill-order-only marker
  assert.strictEqual(host._logs[host.myId].length, 14, 'host played a full board');
  assert.deepStrictEqual(host._logs[c1.myId][0].rolls, [[1, 2, 3, 4, 5]], 'roll detail survived the wire');
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

// ---- record sanitisation (JSON-paste import gate; the acoustic packRecord/
//      unpackRecord codec was removed in Task A slice 5c) ----
test('selectKeep (dice-selection flavour) survives sanitizeRecord', function () {
  var rec = { ts: 1700000000000, manualMode: false, ownerSkipped: false, selectKeep: true,
    players: [{ name: 'A', color: '#ee0055', gender: 'm', owner: true, bonus: 0, scores: { ones: 3 } },
              { name: 'B', color: '#00aa55', gender: 'f', owner: false, bonus: 0, scores: { ones: 2 } }],
    moveLog: [[{ dice: [1, 1, 1, 4, 5], category: 'ones' }], [{ dice: [2, 2, 4, 5, 6], category: 'ones' }]] };
  assert.strictEqual(MP.sanitizeRecord(rec, CATS).selectKeep, true, 'import sanitise keeps it');
  assert.strictEqual(MP.sanitizeRecord({ players: rec.players, moveLog: rec.moveLog }, CATS).selectKeep, false, 'defaults off when absent');
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

test('a clean record sanitises into a usable game (scores + categories preserved)', function () {
  var rec = { ts: 1700000000000, manualMode: false, players: [
    { name: 'Иван', color: '#ee0055', gender: 'm', owner: true, bonus: 0, scores: { ones: 3 } },
    { name: 'Боби', color: '#00aa55', gender: 'm', owner: false, bonus: 0, scores: { twos: 6 } } ],
    moveLog: [[{ dice: [1, 1, 1, 4, 5], category: 'ones' }], [{ dice: [2, 2, 4, 5, 6], category: 'twos' }]] };
  var clean = MP.sanitizeRecord(rec, CATS);
  assert.strictEqual(clean.players.length, 2);
  assert.strictEqual(clean.players[0].scores.ones, 3);
  assert.strictEqual(clean.moveLog[1][0].category, 'twos');
});

test('host dedupes colliding colours and names across joining devices', function () {
  var bus = new Bus();
  function mk(isHost, me) { return new MP.Session({ transport: bus.transport(), isHost: isHost, me: me, minPlayers: 2, setTimeout: noTimers.setTimeout, clearTimeout: noTimers.clearTimeout, callbacks: {} }); }
  var host = mk(true, { name: 'Иван', color: '#c8a64b', gender: 'm' });
  var c1 = mk(false, { name: 'Иван', color: '#c8a64b', gender: 'm' });   // same name + colour as host
  var c2 = mk(false, { name: 'Иван', color: '#c8a64b', gender: 'f' });   // same again
  host.openLobby(); c1.requestJoin(); c2.requestJoin(); bus.drain();
  var names = host.roster.map(function (p) { return p.name; });
  var cols = host.roster.map(function (p) { return p.color.toLowerCase(); });
  assert.strictEqual(new Set(names).size, 3, 'all names unique after dedupe');
  assert.strictEqual(new Set(cols).size, 3, 'all colours unique after dedupe');
  assert.strictEqual(host.roster[0].name, 'Иван');   // host keeps its own
  assert.strictEqual(host.roster[0].color.toLowerCase(), '#c8a64b');
});

// ---- lobby preparation (scan → prep → ready → start) ----
test('lobby prep: host freezes joins, publishes settings, clients enter prep', function () {
  var bus = new Bus();
  function mk(isHost, me, cb) { return new MP.Session({ transport: bus.transport(), isHost: isHost, me: me, minPlayers: 2, setTimeout: noTimers.setTimeout, clearTimeout: noTimers.clearTimeout, callbacks: cb || {} }); }
  var prepC1 = null;
  var host = mk(true, { name: 'Хост', color: '#d4a02e', gender: 'm' });
  var c1 = mk(false, { name: 'Боян', color: '#e07a2e', gender: 'm' }, { onPrep: function (bits, isHost) { prepC1 = { bits: bits, isHost: isHost }; } });
  host.openLobby(); c1.requestJoin(); bus.drain();
  assert.strictEqual(host.roster.length, 2, 'client joined during scan');
  host.startPrep(0b10101); bus.drain();
  assert.strictEqual(host.state, 'PREP');
  assert.strictEqual(c1.state, 'IN_PREP');
  assert.deepStrictEqual(prepC1, { bits: 0b10101, isHost: false }, 'client got settings summary');
  // a late join is ignored now that the scan is closed
  var c2 = mk(false, { name: 'Late', color: '#2f86c8', gender: 'm' });
  c2.requestJoin(); bus.drain();
  assert.strictEqual(host.roster.length, 2, 'joins frozen in prep');
});

test('lobby prep: a client edits only its own meta (host dedupes), readies up, host can start', function () {
  var bus = new Bus();
  function mk(isHost, me) { return new MP.Session({ transport: bus.transport(), isHost: isHost, me: me, minPlayers: 2, setTimeout: noTimers.setTimeout, clearTimeout: noTimers.clearTimeout, callbacks: {} }); }
  var host = mk(true, { name: 'Хост', color: '#d4a02e', gender: 'm' });
  var c1 = mk(false, { name: 'Боян', color: '#e07a2e', gender: 'm' });
  host.openLobby(); c1.requestJoin(); bus.drain();
  host.startPrep(0); bus.drain();
  // client recolours to the host's colour → host bumps it to a free one
  c1.setMyMeta({ color: '#d4a02e', gender: 'f', name: 'Боян' }); bus.drain();
  var cl = host.roster[1];
  assert.notStrictEqual(cl.color.toLowerCase(), '#d4a02e', 'collision bumped away from host colour');
  assert.strictEqual(cl.gender, 'f', 'gender applied');
  assert.strictEqual(host.allReady(), false, 'not ready yet');
  c1.setReady(true); bus.drain();
  assert.strictEqual(host.roster[1].ready, true, 'host saw the ready');
  assert.strictEqual(host.allReady(), true, 'quorum readied → host may start');
  assert.strictEqual(host.startGame(), true); bus.drain();
  assert.strictEqual(c1.state, 'IN_GAME');
});

test('lobby prep: host adds and removes AI seats (AI is auto-ready, names/colours unique)', function () {
  var bus = new Bus();
  function mk(isHost, me) { return new MP.Session({ transport: bus.transport(), isHost: isHost, me: me, minPlayers: 2, setTimeout: noTimers.setTimeout, clearTimeout: noTimers.clearTimeout, callbacks: {} }); }
  var host = mk(true, { name: 'Хост', color: '#d4a02e', gender: 'm' });
  var c1 = mk(false, { name: 'Боян', color: '#e07a2e', gender: 'm' });
  host.openLobby(); c1.requestJoin(); bus.drain(); host.startPrep(0); bus.drain();
  var ai = host.addAI({ name: 'Леля ти', color: '#d4a02e', gender: 'f' }); bus.drain();
  assert.ok(ai && ai.isAI && ai.ready, 'AI seat is auto-ready');
  assert.strictEqual(host.roster.length, 3);
  assert.notStrictEqual(ai.color.toLowerCase(), '#d4a02e', 'AI colour deduped from host');
  assert.strictEqual(c1.roster.length, 3, 'client sees the AI in the roster');
  assert.ok(c1.roster.some(function (p) { return p.isAI; }), 'client roster flags the AI seat');
  host.removeAI(ai.id); bus.drain();
  assert.strictEqual(host.roster.length, 2);
  assert.strictEqual(c1.roster.length, 2, 'client saw the removal');
});

// ---- AI takeover of a dropped player ----
test('takeover: host plays a stalled seat authoritatively and advances the turn', function () {
  var bus = new Bus();
  var moves = [];
  function mk(isHost, me, cb) { return new MP.Session({ transport: bus.transport(), isHost: isHost, me: me, minPlayers: 2, rounds: 1, setTimeout: noTimers.setTimeout, clearTimeout: noTimers.clearTimeout, callbacks: cb || {} }); }
  var host = mk(true, { name: 'Хост', color: '#d4a02e', gender: 'm' }, { onMove: function (mv) { moves.push(mv); } });
  var takeNotice = null;
  var c1 = mk(false, { name: 'Боян', color: '#e07a2e', gender: 'm' }, { onTakeover: function (id, on) { takeNotice = { id: id, on: on }; } });
  host.openLobby(); c1.requestJoin(); bus.drain(); host.startPrep(0); bus.drain();
  c1.setReady(true); bus.drain();
  host.startGame(); bus.drain();
  // turn 1 is the host's own seat; host plays it to hand the token to the client
  host.submitMove({ category: 0, score: 3 }); bus.drain();
  assert.strictEqual(host.activeId, c1.myId, 'token is on the client now');
  // client drops; host takes the seat over
  host.setTakeover(c1.myId, true); bus.drain();
  assert.strictEqual(host.isAIControlled(c1.myId), true);
  assert.deepStrictEqual(takeNotice, { id: c1.myId, on: true }, 'client notified of AI control');
  assert.strictEqual(host.submitMoveFor(c1.myId, { category: 1, score: 9 }), true, 'host injected the AI move');
  assert.strictEqual(host.scores[c1.myId][1], 9, 'AI score recorded');
  assert.ok(host.state === 'GAME_OVER', 'rounds=1 → game ends after both seats filled');
});

test('takeover: lobby AI seats are host-controlled from the first grant', function () {
  var bus = new Bus();
  function mk(isHost, me) { return new MP.Session({ transport: bus.transport(), isHost: isHost, me: me, minPlayers: 2, rounds: 1, setTimeout: noTimers.setTimeout, clearTimeout: noTimers.clearTimeout, callbacks: {} }); }
  var host = mk(true, { name: 'Хост', color: '#d4a02e', gender: 'm' });
  var c1 = mk(false, { name: 'Боян', color: '#e07a2e', gender: 'm' });
  host.openLobby(); c1.requestJoin(); bus.drain(); host.startPrep(0); bus.drain();
  c1.setReady(true); bus.drain();
  var ai = host.addAI({ name: 'Бот', color: '#2aa0a0', gender: 'm' }); bus.drain();
  host.startGame(); bus.drain();
  assert.strictEqual(host.isAIControlled(ai.id), true, 'AI seat is host-controlled');
  assert.strictEqual(host.isAIControlled(c1.myId), false, 'a live human seat is not');
});

// ---- performance-matched takeover policy ----
test('botPolicyForAccuracy ladders strength to measured accuracy', function () {
  var EV = require('../engine.js');
  assert.strictEqual(EV.botPolicyForAccuracy(1.0).type, 'optimal');
  assert.strictEqual(EV.botPolicyForAccuracy(0.85).type, 'softmax');
  assert.strictEqual(EV.botPolicyForAccuracy(0.6).type, 'epsilon');
  assert.strictEqual(EV.botPolicyForAccuracy(0.2).type, 'greedy');
  assert.strictEqual(EV.botPolicyForAccuracy(null).type, 'softmax');   // unknown → solid default
  assert.ok(EV.botPolicyForAccuracy(0.85).tau < EV.botPolicyForAccuracy(0.72).tau, 'higher accuracy → sharper softmax');
});
