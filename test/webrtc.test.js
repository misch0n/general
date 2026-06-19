'use strict';

// Verifies the WebRTC slice's transport topology: PeerBus gives MP.Session a STAR bus
// (every client talks only to the host; the host talks to every client) rather than the
// acoustic broadcast bus where everyone hears everyone. The host is the source of truth and
// always re-emits authoritative ROSTER/STATE, so clients never need to hear each other.
// This proves the existing transport-agnostic Session drives a full game over that star.

var test = require('node:test');
var assert = require('node:assert');
var MP = require('../mp.js');
var General = require('../game.js');

var noTimers = { setTimeout: function () { return 0; }, clearTimeout: function () {} };

// ---- a STAR bus: the host node is index 0. Client sends reach only the host; host sends
// reach only the clients. Delivered when drain() runs. This is exactly what PeerBus emulates
// (a client's conn list = [host]; the host's conn list = [every client]). ----
function StarBus() { this.host = null; this.clients = []; this.q = []; }
StarBus.prototype.transport = function (isHost) {
  var bus = this, node = { cb: null, isHost: isHost, down: false };
  node.tp = {
    maxPayload: 60000,
    send: function (bytes) { if (!node.down) bus.q.push({ from: node, bytes: bytes }); return Promise.resolve(); },
    onReceive: function (cb) { node.cb = cb; },
    __node: node,
  };
  if (isHost) bus.host = node; else bus.clients.push(node);
  return node.tp;
};
StarBus.prototype.drop = function (tp) { tp.__node.down = true; };          // simulate a vanished client
StarBus.prototype.drain = function () {
  var bus = this, guard = 0;
  while (this.q.length && guard++ < 100000) {
    var m = this.q.shift();
    if (m.from.down) continue;
    if (m.from.isHost) {                                   // host → every (live) client
      this.clients.forEach(function (n) { if (n.cb && !n.down) n.cb(m.bytes); });
    } else if (bus.host && bus.host.cb) {                  // client → host only
      bus.host.cb(m.bytes);
    }
  }
};

function nextCat(node, id) {
  var sc = node.scores[id] || {};
  for (var i = 0; i < General.CATEGORIES.length; i++) if (sc[i] == null) return i;
  return -1;
}

test('star topology (PeerBus): host + 2 clients run a full game, all converge', function () {
  var bus = new StarBus();
  var ended = {};
  function mk(isHost, me) {
    return new MP.Session({ transport: bus.transport(isHost), isHost: isHost, me: me, minPlayers: 2, maxPlayers: 6,
      rounds: General.CATEGORIES.length, setTimeout: noTimers.setTimeout, clearTimeout: noTimers.clearTimeout,
      callbacks: { onEnd: function () { ended[me.name] = true; } } });
  }
  var host = mk(true, { name: 'Иван', color: '#ee0055', gender: 'm' });
  var c1 = mk(false, { name: 'Боби', color: '#00aa55', gender: 'm' });
  var c2 = mk(false, { name: 'Мими', color: '#5566ff', gender: 'f' });
  var nodes = [host, c1, c2];

  host.openLobby();
  c1.requestJoin(); c2.requestJoin();
  bus.drain();
  assert.strictEqual(host.roster.length, 3, 'host enrolled both clients over the star');
  assert.ok(c1.myId > 0 && c2.myId > 0 && c1.myId !== c2.myId, 'distinct ids assigned');
  // clients learn the full roster from the host's broadcast even though they never hear each other
  assert.deepStrictEqual(c1.roster.map(function (p) { return p.name; }), ['Иван', 'Боби', 'Мими']);
  assert.deepStrictEqual(c2.roster.map(function (p) { return p.name; }), ['Иван', 'Боби', 'Мими']);

  assert.ok(host.startGame());
  bus.drain();
  assert.strictEqual(c1.state, 'IN_GAME');
  assert.strictEqual(c2.state, 'IN_GAME');

  for (var guard = 0; guard < 5000 && host.state === 'IN_GAME'; guard++) {
    var actId = host.activeId;
    var active = nodes.filter(function (n) { return n.myId === actId; })[0];
    var cat = nextCat(active, actId);
    assert.ok(cat >= 0, 'active player has an open category');
    active.submitMove({ category: cat, score: 1 + cat, rolls: [[1, 2, 3, 4, 5]], keeps: [] });
    bus.drain();
  }

  assert.ok(ended['Иван'] && ended['Боби'] && ended['Мими'], 'END reached on every device');
  // a client's move (it only reached the host) still propagated to the OTHER client via the host's STATE
  [c1, c2].forEach(function (n) {
    assert.strictEqual(n.version, host.version, 'client version matches host');
    assert.deepStrictEqual(n.scores, host.scores, 'client scoreboard matches host');
  });
});

test('star topology: a client move propagates to the other client only via the host', function () {
  var bus = new StarBus();
  function mk(isHost, me) {
    return new MP.Session({ transport: bus.transport(isHost), isHost: isHost, me: me, minPlayers: 2, maxPlayers: 6,
      rounds: General.CATEGORIES.length, setTimeout: noTimers.setTimeout, clearTimeout: noTimers.clearTimeout, callbacks: {} });
  }
  var host = mk(true, { name: 'H', color: '#ee0055', gender: 'm' });
  var c1 = mk(false, { name: 'A', color: '#00aa55', gender: 'm' });
  var c2 = mk(false, { name: 'B', color: '#5566ff', gender: 'f' });
  host.openLobby(); c1.requestJoin(); c2.requestJoin(); bus.drain();
  host.startGame(); bus.drain();

  // drive turns until a CLIENT holds the grant, then make exactly that move
  var nodes = [host, c1, c2], moved = false;
  for (var g = 0; g < 5000 && host.state === 'IN_GAME' && !moved; g++) {
    var actId = host.activeId;
    var active = nodes.filter(function (n) { return n.myId === actId; })[0];
    var cat = nextCat(active, actId);
    if (active !== host) {
      var vBefore = host.version;
      active.submitMove({ category: cat, score: 42, rolls: [[1, 2, 3, 4, 5]], keeps: [] });
      bus.drain();
      assert.strictEqual(host.scores[actId][cat], 42, 'host applied the client move');
      var other = active === c1 ? c2 : c1;
      assert.strictEqual(other.scores[actId][cat], 42, 'the other client got it via the host rebroadcast');
      assert.strictEqual(host.version, vBefore + 1, 'one version bump');
      moved = true;
    } else {
      active.submitMove({ category: cat, score: 1, rolls: [[1, 2, 3, 4, 5]], keeps: [] });
      bus.drain();
    }
  }
  assert.ok(moved, 'a client took at least one turn');
});

test('the full turn log rides the move to the host and on to the other client (complete history)', function () {
  var bus = new StarBus();
  var seen = { H: {}, A: {}, B: {} };
  function mk(isHost, me) {
    return new MP.Session({ transport: bus.transport(isHost), isHost: isHost, me: me, minPlayers: 2, maxPlayers: 6,
      rounds: General.CATEGORIES.length, setTimeout: noTimers.setTimeout, clearTimeout: noTimers.clearTimeout,
      callbacks: { onMove: function (mv) { seen[me.name][mv.playerId] = mv.log; } } });
  }
  var host = mk(true, { name: 'H', color: '#ee0055', gender: 'm' });
  var c1 = mk(false, { name: 'A', color: '#00aa55', gender: 'm' });
  var c2 = mk(false, { name: 'B', color: '#5566ff', gender: 'f' });
  host.openLobby(); c1.requestJoin(); c2.requestJoin(); bus.drain();
  host.startGame(); bus.drain();
  var nodes = [host, c1, c2], theLog = JSON.stringify({ mask: 7, rolls: [[1, 2, 3, 4, 5]], keeps: [[true, false, true, false, true]], category: 0 });
  var moved = false;
  for (var g = 0; g < 5000 && host.state === 'IN_GAME' && !moved; g++) {
    var actId = host.activeId, active = nodes.filter(function (n) { return n.myId === actId; })[0], cat = nextCat(active, actId);
    if (active !== host) {
      active.submitMove({ category: cat, score: 42, rolls: [[1, 2, 3, 4, 5]], keeps: [], log: theLog });
      bus.drain();
      assert.strictEqual(seen.H[actId], theLog, 'host received the full turn log');
      var otherName = active === c1 ? 'B' : 'A';
      assert.strictEqual(seen[otherName][actId], theLog, 'the other client received the full turn log too');
      moved = true;
    } else {
      active.submitMove({ category: cat, score: 1, rolls: [[1, 2, 3, 4, 5]], keeps: [] }); bus.drain();
    }
  }
  assert.ok(moved, 'a client move carried its log end to end');
});

test('drop: a vanished seat pauses the game (not stranded); the rest play on then it WAITS', function () {
  var bus = new StarBus();
  var ended = {}, waited = false;
  function mk(isHost, me) {
    return new MP.Session({ transport: bus.transport(isHost), isHost: isHost, me: me, minPlayers: 2, maxPlayers: 6,
      rounds: General.CATEGORIES.length, setTimeout: noTimers.setTimeout, clearTimeout: noTimers.clearTimeout,
      callbacks: { onEnd: function () { ended[me.name] = true; }, onWait: function () { if (me.name === 'H') waited = true; } } });
  }
  var host = mk(true, { name: 'H', color: '#ee0055', gender: 'm' });
  var c1tp = bus.transport(false);
  var c1 = new MP.Session({ transport: c1tp, isHost: false, me: { name: 'A', color: '#00aa55', gender: 'm' },
    minPlayers: 2, maxPlayers: 6, rounds: General.CATEGORIES.length, setTimeout: noTimers.setTimeout, clearTimeout: noTimers.clearTimeout, callbacks: {} });
  var c2 = mk(false, { name: 'B', color: '#5566ff', gender: 'f' });
  host.openLobby(); c1.requestJoin(); c2.requestJoin(); bus.drain();
  host.startGame(); bus.drain();
  var c1id = c1.myId;
  var nodes = [host, c1, c2];
  function step() { var a = nodes.filter(function (n) { return n.myId === host.activeId; })[0]; a.submitMove({ category: nextCat(a, a.myId), score: 5, rolls: [[1, 2, 3, 4, 5]], keeps: [] }); bus.drain(); }
  for (var i = 0; i < 9 && host.state === 'IN_GAME'; i++) step();

  // c1 vanishes mid-game; host marks it dropped
  bus.drop(c1tp); host.markDropped(c1id, true); bus.drain();
  assert.strictEqual(host._byId(c1id).dropped, true, 'host flagged the dropped seat');

  // host + c2 keep playing; c1 is never granted; the game does NOT end — it PAUSES on the missing seat
  var guard = 0;
  while (host.state === 'IN_GAME' && host.activeId != null && guard++ < 5000) {
    assert.notStrictEqual(host.activeId, c1id, 'dropped seat is never granted a turn');
    var a = nodes.filter(function (n) { return n.myId === host.activeId; })[0]; if (!a) break;
    a.submitMove({ category: nextCat(a, a.myId), score: 5, rolls: [[1, 2, 3, 4, 5]], keeps: [] });
    bus.drain();
  }
  assert.strictEqual(host.state, 'IN_GAME', 'game is NOT over — it waits for the dropped seat');
  assert.strictEqual(host.activeId, null, 'rotation paused on the missing seat');
  assert.ok(waited, 'onWait fired');
  assert.ok(!ended['H'], 'no premature game-over while a board is incomplete');
  assert.ok(host._filled(c1id) < General.CATEGORIES.length, 'dropped board still incomplete');
});

test('drop → reconnect: the returned seat is re-granted and finishes the game', function () {
  var bus = new StarBus();
  var ended = {};
  function cb(name) { return { onEnd: function () { ended[name] = true; } }; }
  var host = new MP.Session({ transport: bus.transport(true), isHost: true, me: { name: 'H', color: '#ee0055', gender: 'm' },
    minPlayers: 2, maxPlayers: 6, rounds: General.CATEGORIES.length, setTimeout: noTimers.setTimeout, clearTimeout: noTimers.clearTimeout, callbacks: cb('H') });
  var c1 = new MP.Session({ transport: bus.transport(false), isHost: false, me: { name: 'A', color: '#00aa55', gender: 'm' },
    minPlayers: 2, maxPlayers: 6, rounds: General.CATEGORIES.length, setTimeout: noTimers.setTimeout, clearTimeout: noTimers.clearTimeout, callbacks: {} });
  host.openLobby(); c1.requestJoin(); bus.drain();
  host.startGame(); bus.drain();
  var c1id = c1.myId;
  var nodes = [host, c1];
  function step() { var a = nodes.filter(function (n) { return n.myId === host.activeId; })[0]; if (a) { a.submitMove({ category: nextCat(a, a.myId), score: 5, rolls: [[1, 2, 3, 4, 5]], keeps: [] }); bus.drain(); } }
  // the host finishes its whole board; c1 still owes turns
  for (var i = 0; i < 40 && host.state === 'IN_GAME' && host._filled(host.myId) < General.CATEGORIES.length; i++) {
    if (host.activeId === c1id) step(); else step();   // both play their granted turns
  }
  // drop c1 while it still owes categories; the game pauses (no end)
  host.markDropped(c1id, true); bus.drain();
  var sane = 0; while (host.state === 'IN_GAME' && host.activeId != null && sane++ < 40) step();
  assert.strictEqual(host.state, 'IN_GAME', 'paused, not ended');
  // c1 returns → host resumes and re-grants it → it finishes → game over
  host.markDropped(c1id, false); bus.drain();
  var g = 0; while (host.state === 'IN_GAME' && g++ < 40) { assert.strictEqual(host.activeId, c1id, 'only the returned seat owes turns'); step(); }
  assert.strictEqual(host.state, 'GAME_OVER', 'finished after the returned seat completed');
  assert.strictEqual(host._filled(c1id), General.CATEGORIES.length, 'returned board completed');
});

test('host crash recovery: snapshot → restore on a fresh host rebuilds the authoritative state', function () {
  var bus = new StarBus();
  var host = new MP.Session({ transport: bus.transport(true), isHost: true, me: { name: 'H', color: '#ee0055', gender: 'm' },
    minPlayers: 2, maxPlayers: 6, rounds: General.CATEGORIES.length, setTimeout: noTimers.setTimeout, clearTimeout: noTimers.clearTimeout, callbacks: {} });
  var c1 = new MP.Session({ transport: bus.transport(false), isHost: false, me: { name: 'A', color: '#00aa55', gender: 'm' },
    minPlayers: 2, maxPlayers: 6, rounds: General.CATEGORIES.length, setTimeout: noTimers.setTimeout, clearTimeout: noTimers.clearTimeout, callbacks: {} });
  host.openLobby(); c1.requestJoin(); bus.drain();
  host.startGame(); bus.drain();
  var c1id = c1.myId, nodes = [host, c1];
  for (var i = 0; i < 6 && host.state === 'IN_GAME'; i++) { var a = nodes.filter(function (n) { return n.myId === host.activeId; })[0]; a.submitMove({ category: nextCat(a, a.myId), score: 7, rolls: [[1, 2, 3, 4, 5]], keeps: [] }); bus.drain(); }
  var snap = host.snapshot();
  assert.ok(snap && snap.roster.length === 2 && snap.version > 0, 'snapshot captured roster + version');

  // a brand-new host process restores from the snapshot, re-hosting the same code
  var started = null, resynced = null;
  var host2 = new MP.Session({ transport: bus.transport(true), isHost: true, me: { name: 'H', color: '#ee0055', gender: 'm' },
    minPlayers: 2, maxPlayers: 6, rounds: General.CATEGORIES.length, setTimeout: noTimers.setTimeout, clearTimeout: noTimers.clearTimeout,
    callbacks: { onStart: function (r) { started = r; }, onResync: function (s) { resynced = s; } } });
  assert.ok(host2.restore(snap), 'restore accepted the snapshot');
  assert.strictEqual(host2.state, 'IN_GAME');
  assert.deepStrictEqual(host2.scores[c1id], host.scores[c1id], 'restored boards match');
  assert.strictEqual(host2._byId(c1id).dropped, true, 'clients marked dropped until they reconnect');
  host2.resumeHost();
  assert.ok(started && resynced, 'resumeHost rebuilt the local game + boards');
  assert.deepStrictEqual(resynced[c1id], host.scores[c1id], 'resync carried the saved scores');
});

test('pause: a paused dropped seat is skipped and the game finishes without it', function () {
  var bus = new StarBus();
  var ended = false;
  var host = new MP.Session({ transport: bus.transport(true), isHost: true, me: { name: 'H', color: '#ee0055', gender: 'm' },
    minPlayers: 2, maxPlayers: 6, rounds: General.CATEGORIES.length, setTimeout: noTimers.setTimeout, clearTimeout: noTimers.clearTimeout,
    callbacks: { onEnd: function () { ended = true; } } });
  var c1 = new MP.Session({ transport: bus.transport(false), isHost: false, me: { name: 'A', color: '#00aa55', gender: 'm' },
    minPlayers: 2, maxPlayers: 6, rounds: General.CATEGORIES.length, setTimeout: noTimers.setTimeout, clearTimeout: noTimers.clearTimeout, callbacks: {} });
  host.openLobby(); c1.requestJoin(); bus.drain();
  host.startGame(); bus.drain();
  var c1id = c1.myId, nodes = [host, c1];
  function step() { var a = nodes.filter(function (n) { return n.myId === host.activeId; })[0]; if (a) { a.submitMove({ category: nextCat(a, a.myId), score: 6, rolls: [[1, 2, 3, 4, 5]], keeps: [] }); bus.drain(); } }
  for (var i = 0; i < 4; i++) step();
  // c1 vanishes; host PAUSES it — the game should NOT wait for it
  host.markDropped(c1id, true); host.setPaused(c1id, true); bus.drain();
  var guard = 0;
  while (host.state === 'IN_GAME' && host.activeId != null && guard++ < 60) {
    assert.notStrictEqual(host.activeId, c1id, 'paused seat is never granted a turn');
    step();
  }
  assert.strictEqual(host.state, 'GAME_OVER', 'game finished without waiting for the paused seat');
  assert.ok(ended, 'onEnd fired');
  assert.ok(host._filled(c1id) < General.CATEGORIES.length, 'paused board left incomplete (forfeited)');
});

test('pause → un-pause + reconnect: the seat is re-included and finishes', function () {
  var bus = new StarBus();
  var host = new MP.Session({ transport: bus.transport(true), isHost: true, me: { name: 'H', color: '#ee0055', gender: 'm' },
    minPlayers: 2, maxPlayers: 6, rounds: General.CATEGORIES.length, setTimeout: noTimers.setTimeout, clearTimeout: noTimers.clearTimeout, callbacks: {} });
  var c1 = new MP.Session({ transport: bus.transport(false), isHost: false, me: { name: 'A', color: '#00aa55', gender: 'm' },
    minPlayers: 2, maxPlayers: 6, rounds: General.CATEGORIES.length, setTimeout: noTimers.setTimeout, clearTimeout: noTimers.clearTimeout, callbacks: {} });
  host.openLobby(); c1.requestJoin(); bus.drain();
  host.startGame(); bus.drain();
  var c1id = c1.myId, nodes = [host, c1];
  function step() { var a = nodes.filter(function (n) { return n.myId === host.activeId; })[0]; if (a) { a.submitMove({ category: nextCat(a, a.myId), score: 6, rolls: [[1, 2, 3, 4, 5]], keeps: [] }); bus.drain(); } }
  for (var i = 0; i < 4; i++) step();
  host.markDropped(c1id, true); host.setPaused(c1id, true); bus.drain();
  step();   // host plays a turn while c1 is paused
  // c1 comes back: un-pause + clear dropped → it owes turns again and the game waits for/grants it
  host.setPaused(c1id, false); host.markDropped(c1id, false); bus.drain();
  assert.strictEqual(host.paused[c1id], undefined, 'pause reverted');
  var g = 0; while (host.state === 'IN_GAME' && g++ < 60) step();
  assert.strictEqual(host.state, 'GAME_OVER');
  assert.strictEqual(host._filled(c1id), General.CATEGORIES.length, 'the returned seat completed its board');
});

test('disband: host cancels the lobby → every client is told (onHostGone)', function () {
  var bus = new StarBus();
  var gone = {};
  function mk(isHost, me) {
    return new MP.Session({ transport: bus.transport(isHost), isHost: isHost, me: me, minPlayers: 2, maxPlayers: 6,
      rounds: General.CATEGORIES.length, setTimeout: noTimers.setTimeout, clearTimeout: noTimers.clearTimeout,
      callbacks: { onHostGone: function () { gone[me.name] = true; } } });
  }
  var host = mk(true, { name: 'Иван', color: '#ee0055', gender: 'm' });
  var c1 = mk(false, { name: 'Боби', color: '#00aa55', gender: 'm' });
  var c2 = mk(false, { name: 'Мими', color: '#5566ff', gender: 'f' });
  host.openLobby(); c1.requestJoin(); c2.requestJoin(); bus.drain();
  assert.strictEqual(host.roster.length, 3, 'both clients joined');
  host.disband(); bus.drain();
  assert.ok(gone['Боби'] && gone['Мими'], 'both clients were notified the host disbanded');
  assert.strictEqual(c1.state, 'DEAD', 'client session is torn down');
  assert.strictEqual(c2.state, 'DEAD', 'client session is torn down');
});

test('reconnect: a dropped player rejoins by eph, catches up, and finishes', function () {
  var bus = new StarBus();
  function mk(isHost, me, extra) {
    var o = { transport: bus.transport(isHost), isHost: isHost, me: me, minPlayers: 2, maxPlayers: 6,
      rounds: General.CATEGORIES.length, setTimeout: noTimers.setTimeout, clearTimeout: noTimers.clearTimeout, callbacks: {} };
    for (var k in (extra || {})) o[k] = extra[k];
    return new MP.Session(o);
  }
  var host = mk(true, { name: 'H', color: '#ee0055', gender: 'm' });
  var c1tp = bus.transport(false);
  var c1 = new MP.Session({ transport: c1tp, isHost: false, me: { name: 'A', color: '#00aa55', gender: 'm' },
    minPlayers: 2, maxPlayers: 6, rounds: General.CATEGORIES.length, setTimeout: noTimers.setTimeout, clearTimeout: noTimers.clearTimeout, callbacks: {} });
  var c2 = mk(false, { name: 'B', color: '#5566ff', gender: 'f' });
  host.openLobby(); c1.requestJoin(); c2.requestJoin(); bus.drain();
  var c1eph = c1.eph, c1id = c1.myId;
  host.startGame(); bus.drain();

  var nodes = [host, c1, c2];
  function step() { var a = nodes.filter(function (n) { return n.myId === host.activeId; })[0]; if (!a) return; a.submitMove({ category: nextCat(a, a.myId), score: 7, rolls: [[1, 2, 3, 4, 5]], keeps: [] }); bus.drain(); }
  for (var i = 0; i < 6; i++) step();

  // c1 drops; host skips it for a few rounds
  bus.drop(c1tp); host.markDropped(c1id, true); bus.drain();
  var missed = 0;
  for (var j = 0; j < 6 && host.state === 'IN_GAME'; j++) { if (host.activeId === host.myId || host.activeId === c2.myId) { step(); missed++; } }
  assert.ok(host._filled(c1id) < host._filled(host.myId), 'dropped player fell behind while away');

  // c1 returns: a NEW session reusing the SAME eph (as the app does from stored state)
  var r1tp = bus.transport(false);
  var rejoined = { start: false };
  var r1 = new MP.Session({ transport: r1tp, isHost: false, me: { name: 'A', color: '#00aa55', gender: 'm' },
    minPlayers: 2, maxPlayers: 6, rounds: General.CATEGORIES.length, eph: c1eph,
    setTimeout: noTimers.setTimeout, clearTimeout: noTimers.clearTimeout,
    callbacks: { onStart: function () { rejoined.start = true; } } });
  r1.requestJoin(); bus.drain();
  assert.strictEqual(r1.myId, c1id, 'host re-admitted the returning player under its old id');
  assert.strictEqual(host._byId(c1id).dropped, false, 'host cleared the dropped flag');
  assert.ok(rejoined.start, 'returning client rebuilt its game board');
  // the snapshot caught it up to the host scoreboard
  assert.deepStrictEqual(r1.scores, host.scores, 'returning client is fully caught up');

  // now everyone (including the returned player) plays to the finish
  nodes = [host, r1, c2];
  var guard = 0;
  while (host.state === 'IN_GAME' && guard++ < 5000) {
    var a = nodes.filter(function (n) { return n.myId === host.activeId; })[0];
    a.submitMove({ category: nextCat(a, a.myId), score: 7, rolls: [[1, 2, 3, 4, 5]], keeps: [] });
    bus.drain();
  }
  assert.strictEqual(host._filled(c1id), General.CATEGORIES.length, 'returned player completed its board');
  assert.strictEqual(host.state, 'GAME_OVER', 'game ended cleanly with everyone done');
});

test('join: a client adopts the host game mode regardless of what it picked', function () {
  var bus = new StarBus();
  var joined = { id: null, manual: null };
  var host = new MP.Session({ transport: bus.transport(true), isHost: true, manual: true, me: { name: 'H', color: '#ee0055', gender: 'm' },
    minPlayers: 2, maxPlayers: 6, rounds: General.CATEGORIES.length, setTimeout: noTimers.setTimeout, clearTimeout: noTimers.clearTimeout, callbacks: {} });
  // client requests a REGULAR game, but the host is MANUAL — the client must be seated and switch to manual
  var cli = new MP.Session({ transport: bus.transport(false), isHost: false, manual: false, me: { name: 'A', color: '#00aa55', gender: 'm' },
    minPlayers: 2, maxPlayers: 6, rounds: General.CATEGORIES.length, setTimeout: noTimers.setTimeout, clearTimeout: noTimers.clearTimeout,
    callbacks: { onJoined: function (id, manual) { joined.id = id; joined.manual = manual; } } });
  host.openLobby(); cli.requestJoin(); bus.drain();
  assert.ok(joined.id != null, 'client was seated');
  assert.strictEqual(joined.manual, true, 'onJoined reported the host mode (manual)');
  assert.strictEqual(cli.manual, true, 'client session adopted the host mode');
  assert.strictEqual(host.roster.length, 2, 'host seated the client');
});

test('manual game: free-for-all — players fill their own boards in any order, ends when all done', function () {
  var bus = new StarBus();
  var ended = {};
  function mk(isHost, me) {
    return new MP.Session({ transport: bus.transport(isHost), isHost: isHost, manual: true, me: me, minPlayers: 2, maxPlayers: 6,
      rounds: General.CATEGORIES.length, setTimeout: noTimers.setTimeout, clearTimeout: noTimers.clearTimeout,
      callbacks: { onEnd: function () { ended[me.name] = true; } } });
  }
  var host = mk(true, { name: 'H', color: '#ee0055', gender: 'm' });
  var c1 = mk(false, { name: 'A', color: '#00aa55', gender: 'm' });
  var c2 = mk(false, { name: 'B', color: '#5566ff', gender: 'f' });
  host.openLobby(); c1.requestJoin(); c2.requestJoin(); bus.drain();
  assert.ok(host.startGame());
  bus.drain();
  assert.ok(host.activeId == null, 'no turn token in a manual game');

  var N = General.CATEGORIES.length, nodes = [host, c1, c2];
  // interleave: each round, every player fills their NEXT category (any order works)
  for (var cat = 0; cat < N; cat++) {
    nodes.forEach(function (n) {
      n.submitMove({ category: cat, score: cat + 1, rolls: [[1, 2, 3, 4, 5]], keeps: [] });
      bus.drain();
    });
  }
  assert.ok(ended['H'] && ended['A'] && ended['B'], 'game ended for everyone once all boards were full');
  [c1, c2].forEach(function (n) { assert.deepStrictEqual(n.scores, host.scores, 'every device converged on the full scoreboard'); });
  assert.strictEqual(host._filled(c1.myId), N, 'a client board is complete');
});

test('lobby cheer (SPUR): a client\'s ДАЙ ЗОР reaches the host + the other client, not itself', function () {
  var bus = new StarBus();
  var got = { host: [], c1: [], c2: [] };
  function mk(isHost, me, key) {
    return new MP.Session({ transport: bus.transport(isHost), isHost: isHost, me: me, minPlayers: 2, maxPlayers: 6,
      rounds: General.CATEGORIES.length, setTimeout: noTimers.setTimeout, clearTimeout: noTimers.clearTimeout,
      callbacks: { onSpur: function (id, heat) { got[key].push({ id: id, heat: heat }); } } });
  }
  var host = mk(true, { name: 'H', color: '#ee0055', gender: 'm' }, 'host');
  var c1 = mk(false, { name: 'A', color: '#00aa55', gender: 'm' }, 'c1');
  var c2 = mk(false, { name: 'B', color: '#5566ff', gender: 'f' }, 'c2');
  host.openLobby(); c1.requestJoin(); c2.requestJoin(); bus.drain();
  host.startPrep(0); bus.drain();

  c1.sendSpur(0.6); bus.drain();
  assert.strictEqual(got.host.length, 1, 'host saw the cheer');
  assert.strictEqual(got.c2.length, 1, 'other client saw the relayed cheer');
  assert.strictEqual(got.c1.length, 0, 'the cheerer does not get its own echo');
  assert.strictEqual(got.host[0].id, c1.myId, 'attributed to the cheering player');
  assert.ok(Math.abs(got.host[0].heat - 0.6) < 0.02, 'heat carried (quantised)');
});

test('live spectating: the active player\'s action reaches the host AND the other client (relay)', function () {
  var bus = new StarBus();
  var got = { host: [], c1: [], c2: [] };
  function mk(isHost, me, key) {
    return new MP.Session({ transport: bus.transport(isHost), isHost: isHost, me: me, minPlayers: 2, maxPlayers: 6,
      rounds: General.CATEGORIES.length, setTimeout: noTimers.setTimeout, clearTimeout: noTimers.clearTimeout,
      callbacks: { onAction: function (a) { got[key].push(a); } } });
  }
  var host = mk(true, { name: 'H', color: '#ee0055', gender: 'm' }, 'host');
  var c1 = mk(false, { name: 'A', color: '#00aa55', gender: 'm' }, 'c1');
  var c2 = mk(false, { name: 'B', color: '#5566ff', gender: 'f' }, 'c2');
  host.openLobby(); c1.requestJoin(); c2.requestJoin(); bus.drain();
  host.startGame(); bus.drain();

  // c1 (a client) broadcasts a roll action; it should reach the host and be relayed to c2 — but NOT echo to c1
  c1.activeId = c1.myId; host.activeId = c1.myId;   // make c1 the active player on both
  c1.sendAction({ throwsLeft: 2, dice: [1, 2, 3, 4, 5], mask: 0 });
  bus.drain();
  assert.strictEqual(got.host.length, 1, 'host received the action');
  assert.strictEqual(got.c2.length, 1, 'other client received the relayed action');
  assert.strictEqual(got.c1.length, 0, 'the actor does not receive its own action back');
  assert.deepStrictEqual(got.host[0].dice, [1, 2, 3, 4, 5], 'dice carried intact');
  assert.strictEqual(got.host[0].playerId, c1.myId, 'attributed to the active player');

  // a commit action carries the category + value
  c1.sendAction({ commit: true, category: 7, value: 24, dice: [3, 3, 3, 4, 5] });
  bus.drain();
  var last = got.c2[got.c2.length - 1];
  assert.strictEqual(last.commit, true);
  assert.strictEqual(last.category, 7);
  assert.strictEqual(last.value, 24);

  // the HOST as active player broadcasts straight to clients (no relay needed)
  host.activeId = host.myId;
  host.sendAction({ throwsLeft: 1, dice: [6, 6, 6, 2, 1], mask: 0b00011 });
  bus.drain();
  assert.strictEqual(got.c1[got.c1.length - 1].playerId, host.myId, 'host action reaches clients');
  assert.deepStrictEqual(got.c2[got.c2.length - 1].dice, [6, 6, 6, 2, 1]);
});

test('re-GRANT idempotency: the host re-granting a slow player does NOT re-fire onTurn', function () {
  var bus = new StarBus();
  var turns = [];
  var host = new MP.Session({ transport: bus.transport(true), isHost: true, me: { name: 'H', color: '#ee0055', gender: 'm' },
    minPlayers: 2, maxPlayers: 6, rounds: General.CATEGORIES.length, setTimeout: noTimers.setTimeout, clearTimeout: noTimers.clearTimeout, callbacks: {} });
  var c1 = new MP.Session({ transport: bus.transport(false), isHost: false, me: { name: 'A', color: '#00aa55', gender: 'm' },
    minPlayers: 2, maxPlayers: 6, rounds: General.CATEGORIES.length, setTimeout: noTimers.setTimeout, clearTimeout: noTimers.clearTimeout,
    callbacks: { onTurn: function (id, mine) { turns.push({ id: id, mine: mine }); } } });
  host.openLobby(); c1.requestJoin(); bus.drain();
  assert.ok(host.startGame()); bus.drain();
  var before = turns.length, active = host.activeId;
  // simulate the move-timeout retransmit: the host re-sends GRANT for the SAME active seat
  host._grant(); bus.drain();
  host._grant(); bus.drain();
  assert.strictEqual(host.activeId, active, 'active seat unchanged by re-grants');
  assert.strictEqual(turns.length, before, 'duplicate GRANTs for the same active player did not re-fire onTurn');
});

// ---- minus ruleset: scores go NEGATIVE; the wire must carry them signed (regression: a -2
// upper-row cell was read back as 65534 → a multi-thousand bogus total on the receiving device) ----
test('MOVE/STATE codecs round-trip negative (minus-ruleset) scores', function () {
  [-2, -17, -1, 0, 5, 42, -65, 70].forEach(function (sc) {
    var mv = MP.unpackMove(MP.packMove({ playerId: 1, category: 4, score: sc, log: '' }));
    assert.strictEqual(mv.score, sc, 'MOVE score ' + sc);
    var dl = MP.unpackState(MP.packStateDelta(7, { playerId: 1, category: 4, score: sc, log: '' }));
    assert.strictEqual(dl.score, sc, 'STATE delta score ' + sc);
    var snap = MP.unpackState(MP.packStateSnapshot(7, { 1: { 4: sc } }));
    assert.strictEqual(snap.scores[1][4], sc, 'STATE snapshot score ' + sc);
  });
});
