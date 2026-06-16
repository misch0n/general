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

test('drop: a vanished client is skipped, the rest finish, its board stays incomplete', function () {
  var bus = new StarBus();
  var ended = {};
  function mk(isHost, me) {
    return new MP.Session({ transport: bus.transport(isHost), isHost: isHost, me: me, minPlayers: 2, maxPlayers: 6,
      rounds: General.CATEGORIES.length, setTimeout: noTimers.setTimeout, clearTimeout: noTimers.clearTimeout,
      callbacks: { onEnd: function () { ended[me.name] = true; } } });
  }
  var host = mk(true, { name: 'H', color: '#ee0055', gender: 'm' });
  var c1tp = bus.transport(false);
  var c1 = new MP.Session({ transport: c1tp, isHost: false, me: { name: 'A', color: '#00aa55', gender: 'm' },
    minPlayers: 2, maxPlayers: 6, rounds: General.CATEGORIES.length, setTimeout: noTimers.setTimeout, clearTimeout: noTimers.clearTimeout, callbacks: {} });
  var c2 = mk(false, { name: 'B', color: '#5566ff', gender: 'f' });
  host.openLobby(); c1.requestJoin(); c2.requestJoin(); bus.drain();
  host.startGame(); bus.drain();
  var c1id = c1.myId;

  // play 3 full rounds normally
  var nodes = [host, c1, c2];
  function step() { var a = nodes.filter(function (n) { return n.myId === host.activeId; })[0]; a.submitMove({ category: nextCat(a, a.myId), score: 5, rolls: [[1, 2, 3, 4, 5]], keeps: [] }); bus.drain(); }
  for (var i = 0; i < 9 && host.state === 'IN_GAME'; i++) step();

  // c1 vanishes; host marks it dropped
  bus.drop(c1tp); host.markDropped(c1id, true); bus.drain();
  assert.strictEqual(host._byId(c1id).dropped, true, 'host flagged the dropped seat');
  assert.strictEqual(c2.roster.find(function (p) { return p.id === c1id; }).dropped, true, 'c2 sees it greyed');

  // host + c2 keep playing to the end — c1 must never be granted again
  var guard = 0;
  while (host.state === 'IN_GAME' && guard++ < 5000) {
    assert.notStrictEqual(host.activeId, c1id, 'dropped seat is never granted a turn');
    var a = nodes.filter(function (n) { return n.myId === host.activeId; })[0];
    a.submitMove({ category: nextCat(a, a.myId), score: 5, rolls: [[1, 2, 3, 4, 5]], keeps: [] });
    bus.drain();
  }
  assert.ok(ended['H'] && ended['B'], 'the connected players finished the game');
  assert.strictEqual(host._filled(host.myId), General.CATEGORIES.length, 'host board complete');
  assert.ok(host._filled(c1id) < General.CATEGORIES.length, 'dropped board left incomplete');
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
