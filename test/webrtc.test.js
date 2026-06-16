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
  var bus = this, node = { cb: null, isHost: isHost };
  node.tp = {
    maxPayload: 60000,
    send: function (bytes) { bus.q.push({ from: node, bytes: bytes }); return Promise.resolve(); },
    onReceive: function (cb) { node.cb = cb; },
  };
  if (isHost) bus.host = node; else bus.clients.push(node);
  return node.tp;
};
StarBus.prototype.drain = function () {
  var bus = this, guard = 0;
  while (this.q.length && guard++ < 100000) {
    var m = this.q.shift();
    if (m.from.isHost) {                                   // host → every client
      this.clients.forEach(function (n) { if (n.cb) n.cb(m.bytes); });
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
