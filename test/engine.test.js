'use strict';

var test = require('node:test');
var assert = require('node:assert');
var General = require('../game.js');
var EV = require('../engine.js');
var TABLE = require('../ev-table.js');

EV.setTable(TABLE.V);

function approx(a, b, eps) {
  assert.ok(Math.abs(a - b) <= (eps || 1e-6), 'expected ~' + b + ' got ' + a);
}
function bit(key) { return 1 << EV.CATS.map(function (c) { return c.key; }).indexOf(key); }

// ---- combinatorics ----

test('exactly 252 dice multisets, roll probabilities sum to 1', function () {
  assert.strictEqual(EV.NMS, 252);
  var s = 0; for (var i = 0; i < EV.NMS; i++) s += EV.ROLL_PROB[i];
  approx(s, 1, 1e-9);
});

test('every keep distribution sums to 1', function () {
  for (var i = 0; i < EV.NMS; i++) {
    EV.KEEPS[i].forEach(function (k) {
      var s = 0; for (var j = 0; j < k.prob.length; j++) s += k.prob[j];
      approx(s, 1, 1e-9);
    });
  }
});

// ---- exact within-turn values (independent of the full table) ----

test('Chance-only scorecard: optimal expected value is 70/3', function () {
  // all categories filled except шанс -> the only successor is the full mask (0)
  var mask = EV.FULL_MASK ^ bit('chance');
  var v = EV.expectRoll(EV.turnArrays(mask, function () { return 0; })[2]);
  approx(v, 70 / 3, 1e-9); // keep dice > 4.25 ; 5 * E[max(face,4.25)]
});

test('Sixes-only scorecard: optimal expected value is 30*(1-(5/6)^3)', function () {
  var mask = EV.FULL_MASK ^ bit('sixes');
  var v = EV.expectRoll(EV.turnArrays(mask, function () { return 0; })[2]);
  approx(v, 30 * (1 - Math.pow(5 / 6, 3)), 1e-9);
});

// ---- the loaded table ----

test('table is well-formed: terminal 0, par positive and matches header', function () {
  assert.strictEqual(EV.vstar(EV.FULL_MASK), 0);
  assert.ok(EV.par() > 150 && EV.par() < 250, 'par out of range: ' + EV.par());
  approx(EV.par(), TABLE.par, 0.01);
});

test('V* of a one-open scorecard matches a direct within-turn solve', function () {
  // sixes open, everything else filled -> V*[mask] should equal the exact 30*(1-(5/6)^3)
  var mask = EV.FULL_MASK ^ bit('sixes');
  approx(EV.vstar(mask), 30 * (1 - Math.pow(5 / 6, 3)), 1e-3); // table rounded to 1e-3
});

// ---- evaluate() query API ----

test('evaluate ranks categories at rolls_left 0 and is deterministic', function () {
  var scores = {};
  var dice = [6, 6, 6, 1, 2];
  var a = EV.evaluate(scores, dice, 0);
  var b = EV.evaluate(scores, dice, 0);
  assert.deepStrictEqual(a.category_ranked, b.category_ranked); // pure/deterministic
  // ranked descending by EV
  for (var i = 1; i < a.category_ranked.length; i++) {
    assert.ok(a.category_ranked[i - 1].ev >= a.category_ranked[i].ev);
  }
  // immediate scores use the game's real scoring (single source of truth)
  var threeKind = a.category_ranked.filter(function (c) { return c.key === 'threeKind'; })[0];
  assert.strictEqual(threeKind.immediate, General.scoreFor('threeKind', dice)); // 18
  assert.strictEqual(a.best_category.ev, a.category_ranked[0].ev);
  assert.strictEqual(a.state_value, a.best_category.ev);
});

test('evaluate offers keeps with rolls left; best_keep is a 5-bool mask', function () {
  var a = EV.evaluate({}, [6, 6, 6, 1, 2], 2);
  assert.strictEqual(a.best_keep.length, 5);
  assert.ok(a.keep_ranked.length > 0);
  for (var i = 1; i < a.keep_ranked.length; i++) {
    assert.ok(a.keep_ranked[i - 1].ev >= a.keep_ranked[i].ev);
  }
  // state value equals the within-turn node value
  approx(a.state_value, EV.nodeValue(0, [6, 6, 6, 1, 2], 2), 1e-9);
  // keeping the three 6s should be the (or a) top keep here
  assert.deepStrictEqual(a.best_keep, [true, true, true, false, false]);
});

test('keepValue equals the EV of the matching ranked keep', function () {
  var dice = [5, 5, 2, 3, 1];
  var a = EV.evaluate({}, dice, 2);
  var kv = EV.keepValue(0, dice, 2, a.best_keep);
  approx(kv, a.keep_ranked[0].ev, 1e-9);
});

// ---- §2 luck/skill decomposition ----

// play a full game with real dice, logging every node; the identity
// final_score = par + Σluck + Σskill must hold exactly.
function simulateLoggedGame(rng, decide) {
  var scores = {}, total = 0, turns = [];
  function roll5() { var d = []; for (var i = 0; i < 5; i++) d.push(1 + Math.floor(rng() * 6)); return d.sort(function (a, b) { return a - b; }); }
  for (var t = 0; t < EV.NCAT; t++) {
    var mask = EV.maskOfScores(scores);
    var rolls = [roll5()], keeps = [];
    var nThrows = 1 + Math.floor(rng() * 3); // stop after 1..3 throws (varied)
    for (var r = 1; r < nThrows; r++) {
      var rl = 2 - (r - 1);
      var keep = decide ? decide(scores, rolls[r - 1], rl) : rolls[r - 1].map(function () { return rng() < 0.5; });
      keeps.push(keep);
      rolls.push(rolls[r - 1].map(function (v, i) { return keep[i] ? v : 1 + Math.floor(rng() * 6); }).sort(function (a, b) { return a - b; }));
    }
    var last = rolls[rolls.length - 1];
    // pick a random open category
    var open = EV.CATS.filter(function (c) { return typeof scores[c.key] !== 'number'; });
    var cat = open[Math.floor(rng() * open.length)].key;
    var got = General.scoreFor(cat, last);
    scores[cat] = got; total += got;
    turns.push({ mask: mask, rolls: rolls, keeps: keeps, category: cat });
  }
  return { total: total, turns: turns };
}

test('luck/skill identity holds: par + luck + skill == final score', function () {
  var seed = 12345;
  var rng = function () { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (var g = 0; g < 25; g++) {
    var game = simulateLoggedGame(rng);
    var a = EV.analyzeGame(game.turns);
    approx(a.projectedFinal, game.total, 1e-6);
    assert.ok(a.skill <= 1e-6, 'skill must be <= 0 (EV given up): ' + a.skill);
  }
});

test('analyzeGame reports accuracy, blunder and sharpest', function () {
  var seed = 999;
  var rng = function () { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  var game = simulateLoggedGame(rng);
  var a = EV.analyzeGame(game.turns);
  assert.ok(a.accuracy >= 0 && a.accuracy <= 1);
  assert.ok(a.blunder && a.blunder.cost <= 1e-6);
  assert.strictEqual(a.nDecisions, a.decisions.length);
});

test('an optimal player leaves ~0 skill on the table', function () {
  var seed = 7;
  var rng = function () { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  var decide = function (scores, dice, rl) { return EV.botKeep(scores, dice, rl, { type: 'optimal' }, rng); };
  // optimal keeps + optimal category
  function game() {
    var scores = {}, turns = [], total = 0;
    function roll5() { var d = []; for (var i = 0; i < 5; i++) d.push(1 + Math.floor(rng() * 6)); return d.sort(function (a, b) { return a - b; }); }
    for (var t = 0; t < EV.NCAT; t++) {
      var mask = EV.maskOfScores(scores), rolls = [roll5()], keeps = [];
      for (var r = 1; r < 3; r++) { var k = decide(scores, rolls[r - 1], 2 - (r - 1)); keeps.push(k); rolls.push(rolls[r - 1].map(function (v, i) { return k[i] ? v : 1 + Math.floor(rng() * 6); }).sort(function (a, b) { return a - b; })); }
      var last = rolls[2], cat = EV.botCategory(scores, last, { type: 'optimal' }, rng);
      scores[cat] = General.scoreFor(cat, last); total += scores[cat];
      turns.push({ mask: mask, rolls: rolls, keeps: keeps, category: cat });
    }
    return { turns: turns, total: total };
  }
  var gg = game();
  var a = EV.analyzeGame(gg.turns);
  assert.ok(a.accuracy === 1, 'optimal player should be 100% accurate, got ' + a.accuracy);
  approx(a.skill, 0, 1e-6);
});

// ---- §3 bot policy ----

test('softmax with τ=0 is argmax; bots return legal actions', function () {
  var top = EV.evaluate({}, [6, 6, 6, 1, 2], 0).category_ranked[0].key;
  assert.strictEqual(EV.botCategory({}, [6, 6, 6, 1, 2], { type: 'optimal' }), top);
  var keep = EV.botKeep({}, [6, 6, 6, 1, 2], 2, { type: 'softmax', tau: 5 }, Math.random);
  assert.strictEqual(keep.length, 5);
});

// ---- §3.4 personas + §6 ranks (game.js) ----

test('personas bind names to fixed strengths; Господ бог optimal, Комар gambler', function () {
  var g = General.personaById('gospod');
  assert.strictEqual(g.name, 'Господ бог');
  assert.strictEqual(g.policy.type, 'optimal');
  // Комар is the гамблер (комарджия) -> risk-seeking, not the weakling
  assert.strictEqual(General.personaById('komar').name, 'Комар');
  assert.strictEqual(General.personaById('komar').policy.type, 'risk');
  // Мушица is the harmless near-random weakling
  assert.strictEqual(General.personaById('mushica').strength < General.personaById('lyubitel').strength, true);
});

test('bestTarget names the combo a keep chases, never Chance unless forced', function () {
  // keep three 6s, reroll the rest -> steering toward sixes or general, not chance
  var target = EV.bestTarget({}, [6, 6, 6, 1, 2], [true, true, true, false, false]);
  assert.notStrictEqual(target, 'chance');
  assert.ok(['sixes', 'general', 'threeKind', 'fourKind'].indexOf(target) >= 0, 'unexpected target ' + target);
  // only chance left open -> must return chance
  var scores = {};
  General.CATEGORIES.forEach(function (c) { if (c.key !== 'chance') scores[c.key] = 0; });
  assert.strictEqual(EV.bestTarget(scores, [2, 3, 4, 5, 6], [false, false, false, false, false]), 'chance');
});

test('rank ladder: winner is Генерал, last is Редник', function () {
  assert.strictEqual(General.rankForPlacement(0, 2), 'Генерал');
  assert.strictEqual(General.rankForPlacement(1, 2), 'Редник');
  assert.strictEqual(General.rankForPlacement(0, 4), 'Генерал');
  assert.strictEqual(General.rankForPlacement(3, 4), 'Редник');
  assert.strictEqual(General.rankForAccuracy(1), 'Генерал');
  assert.strictEqual(General.rankForAccuracy(0.5), 'Редник');
});
