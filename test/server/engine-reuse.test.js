'use strict';
/*
 * Phase 0.1 — the shared-module bet, under test.
 *
 * The whole server design rests on one claim: the server can `require()` the
 * browser's pure modules and run IDENTICAL rules, rather than re-implementing
 * scoring/the reducer/the codecs (which would let the authoritative server and
 * the clients it referees silently disagree). These tests hold that claim:
 * the modules load under Node, the surface the server names is really there,
 * and one path per module actually executes server-side.
 *
 * Lives under test/server/ so `node --test` (which globs **\/test\/**\/*.js)
 * picks it up alongside the engine/protocol suites, with no extra lane.
 */

var test = require('node:test');
var assert = require('node:assert');

var engine = require('../../server/engine.js');
var index = require('../../server/index.js');

var G = require('../../game.js');
var X = require('../../exp.js');
var GReduce = require('../../reduce.js');
var MP = require('../../mp.js');

test('server binds the four pure modules — the same objects the browser gets', function () {
  // Identity, not just equivalence: a second copy of game.js (a fork, a vendored
  // duplicate) is exactly the drift this whole approach exists to prevent.
  assert.strictEqual(engine.G, G);
  assert.strictEqual(engine.X, X);
  assert.strictEqual(engine.GReduce, GReduce);
  assert.strictEqual(engine.MP, MP);
});

test('server engine self-test passes (loads + smokes under Node)', function () {
  var r = engine.selfTest();
  assert.deepStrictEqual(r.problems, [], 'shared engine problems: ' + r.problems.join('; '));
  assert.strictEqual(r.ok, true);
});

test('every CONTRACT export the server depends on exists', function () {
  var mods = { G: G, X: X, GReduce: GReduce, MP: MP };
  Object.keys(engine.CONTRACT).forEach(function (mod) {
    engine.CONTRACT[mod].forEach(function (name) {
      assert.notStrictEqual(typeof mods[mod][name], 'undefined', mod + '.' + name + ' is missing');
    });
  });
});

test('assertReady() throws with a named casualty when the contract breaks', function () {
  // Simulate a refactor dropping an export the server leans on, then restore it.
  // Proves boot fails loudly (and says which symbol) instead of dying mid-game.
  var saved = G.assignScore;
  delete G.assignScore;
  try {
    assert.throws(function () { engine.assertReady(); }, /G\.assignScore/);
  } finally {
    G.assignScore = saved;
  }
  assert.strictEqual(engine.selfTest().ok, true, 'restore failed — later tests would be poisoned');
});

test('dice rolls use Web Crypto server-side, not Math.random', function () {
  // Phase 3 makes the server the sole roller. game.js falls back to Math.random
  // when Web Crypto is absent; on Node 22 it must not, or the authoritative
  // dice would be predictable.
  assert.strictEqual(engine.cryptoRngAvailable(), true);

  var faces = {};
  for (var i = 0; i < 600; i++) faces[G.rollDie()] = true;
  assert.deepStrictEqual(Object.keys(faces).sort(), ['1', '2', '3', '4', '5', '6']);
});

test('seededRng makes server rolls reproducible for tests', function () {
  var a = G.rollAll(engine.seededRng(42));
  var b = G.rollAll(engine.seededRng(42));
  var c = G.rollAll(engine.seededRng(43));
  assert.deepStrictEqual(a, b);
  assert.strictEqual(a.length, G.DICE_COUNT);
  assert.notDeepStrictEqual(a, c, 'different seeds produced the same hand');
});

test('the server scores a hand exactly like the engine does', function () {
  // Not a rules test (game.test.js owns those) — a wiring test: the value the
  // server would broadcast comes from G, with no server-side arithmetic.
  var dice = [3, 3, 3, 5, 5];
  assert.strictEqual(engine.G.scoreFor('fullHouse', dice), G.scoreFor('fullHouse', dice));
  assert.strictEqual(engine.G.scoreForExp('fullHouse', dice), G.scoreForExp('fullHouse', dice));
});

test('the reducer drives a server-rolled turn', function () {
  // The shape Phase 3.2 uses: the server rolls, then feeds the faces into the
  // same pure reducer the browser shell uses.
  var rng = engine.seededRng(7);
  var st = { turn: GReduce.freshTurn() };
  st = GReduce.reduce(st, { type: 'BEGIN_TURN', mode: 'dice' });
  st = GReduce.reduce(st, { type: 'FIRST_ROLL', dice: G.rollAll(rng) });

  assert.strictEqual(st.turn.rollNo, 1);
  assert.strictEqual(st.turn.dice.length, G.DICE_COUNT);
  assert.strictEqual(st.turn.throwsLeft, GReduce.ROLLS - 1);
});

test('MP.Session constructs and disposes under Node with a stub transport', function () {
  // Phase 1 hosts one of these per room. If it needed a browser it would sink
  // the "host Session, don't rewrite it" plan — so check it here, early.
  var session = new MP.Session({
    transport: { send: function () { return Promise.resolve(); }, onReceive: function () {} },
    isHost: true, me: { name: 'СЪРВЪР', color: '#123456' },
  });
  assert.strictEqual(session.state, 'LOBBY');
  assert.strictEqual(session.myId, MP.HOST_ID);
  session.dispose();
  assert.strictEqual(session.state, 'DEAD');
});

test('the boot banner names the bound modules and the dice rng', function () {
  var f = index.bootFields({ port: 1, host: 'h', maxRooms: 2, maxPlayersPerRoom: 3 }, engine.selfTest());
  assert.match(f.engine, /G←game\.js/);
  assert.match(f.engine, /MP←mp\.js/);
  assert.strictEqual(f.diceRng, 'webcrypto');
});
