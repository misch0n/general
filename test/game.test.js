'use strict';

var test = require('node:test');
var assert = require('node:assert');
var G = require('../game.js');

// Deterministic RNG: makes rollDie produce exactly the given faces, in order.
function fixedDice(faces) {
  var i = 0;
  return function () {
    var face = faces[i++ % faces.length];
    return (face - 0.5) / 6; // floor(((f-0.5)/6)*6)+1 === f
  };
}

// ----------------------------------------------------------------- helpers

test('counts tallies each face', function () {
  assert.deepStrictEqual(G.counts([1, 1, 3, 6, 6]), [0, 2, 0, 1, 0, 0, 2]);
});

test('sum and sumOfFace', function () {
  assert.strictEqual(G.sum([1, 2, 3, 4, 5]), 15);
  assert.strictEqual(G.sumOfFace([3, 3, 3, 1, 2], 3), 9);
  assert.strictEqual(G.sumOfFace([3, 3, 3, 1, 2], 5), 0);
});

test('facesWithCount returns qualifying faces high to low', function () {
  assert.deepStrictEqual(G.facesWithCount([2, 2, 4, 4, 4], 2), [4, 2]);
  assert.deepStrictEqual(G.facesWithCount([2, 2, 4, 4, 4], 3), [4]);
  assert.deepStrictEqual(G.facesWithCount([2, 2, 4, 4, 4], 4), []);
});

test('isFullHouse: triple + pair only', function () {
  assert.strictEqual(G.isFullHouse([2, 2, 3, 3, 3]), true);
  assert.strictEqual(G.isFullHouse([2, 2, 2, 2, 3]), false);
  assert.strictEqual(G.isFullHouse([4, 4, 4, 4, 4]), false);
});

test('straights are exact five-dice sequences', function () {
  assert.strictEqual(G.isSmallStraight([5, 4, 3, 2, 1]), true);
  assert.strictEqual(G.isSmallStraight([1, 2, 3, 4, 6]), false);
  assert.strictEqual(G.isLargeStraight([6, 5, 4, 3, 2]), true);
  assert.strictEqual(G.isLargeStraight([1, 2, 3, 4, 5]), false);
});

test('isGeneral: all five equal', function () {
  assert.strictEqual(G.isGeneral([5, 5, 5, 5, 5]), true);
  assert.strictEqual(G.isGeneral([5, 5, 5, 5, 1]), false);
});

// ----------------------------------------------------------------- candidates

test('upper section: sum of matching face (or 0)', function () {
  assert.deepStrictEqual(G.candidates('ones', [1, 1, 1, 4, 5]), [3]);
  assert.deepStrictEqual(G.candidates('sixes', [6, 6, 6, 6, 1]), [24]);
  assert.deepStrictEqual(G.candidates('threes', [1, 2, 4, 5, 6]), [0]);
});

test('2x offers one entry per distinct pair-or-better face (sum of the two)', function () {
  // 1 2 2 5 5 -> pairs of 2 (=4) and 5 (=10)
  assert.deepStrictEqual(G.candidates('twoKind', [1, 2, 2, 5, 5]), [10, 4]);
  // 2 2 4 4 4 -> pair of 4 (=8) and pair of 2 (=4)
  assert.deepStrictEqual(G.candidates('twoKind', [2, 2, 4, 4, 4]), [8, 4]);
  assert.deepStrictEqual(G.candidates('twoKind', [1, 2, 3, 4, 5]), [0]);
});

test('3x and 4x score the sum of the three / four equal dice', function () {
  assert.deepStrictEqual(G.candidates('threeKind', [2, 2, 4, 4, 4]), [12]);
  assert.deepStrictEqual(G.candidates('threeKind', [2, 2, 1, 3, 5]), [0]);
  assert.deepStrictEqual(G.candidates('fourKind', [4, 4, 4, 4, 6]), [16]);
  assert.deepStrictEqual(G.candidates('fourKind', [4, 4, 4, 1, 6]), [0]);
});

test('full house scores the sum of all dice', function () {
  assert.deepStrictEqual(G.candidates('fullHouse', [2, 2, 4, 4, 4]), [16]);
  assert.deepStrictEqual(G.candidates('fullHouse', [2, 2, 2, 2, 3]), [0]);
});

test('kentas score fixed sums, general scores 50 + dice total', function () {
  assert.deepStrictEqual(G.candidates('smallStraight', [1, 2, 3, 4, 5]), [15]);
  assert.deepStrictEqual(G.candidates('smallStraight', [1, 2, 3, 4, 6]), [0]);
  assert.deepStrictEqual(G.candidates('largeStraight', [2, 3, 4, 5, 6]), [20]);
  assert.deepStrictEqual(G.candidates('general', [5, 5, 5, 5, 5]), [75]); // 50 + 25
  assert.deepStrictEqual(G.candidates('general', [5, 5, 5, 5, 1]), [0]);
});

test('chance is always the dice total', function () {
  assert.deepStrictEqual(G.candidates('chance', [1, 3, 3, 5, 6]), [18]);
});

test('candidates rejects an unknown category', function () {
  assert.throws(function () { G.candidates('nope', [1, 2, 3, 4, 5]); });
});

// Matches the worked examples from the spec.
test('suggestion set for 1 2 2 5 5', function () {
  var scoring = {};
  G.CATEGORIES.forEach(function (c) { scoring[c.key] = G.candidates(c.key, [1, 2, 2, 5, 5]); });
  var positive = G.CATEGORIES.filter(function (c) {
    return Math.max.apply(null, scoring[c.key]) > 0;
  }).map(function (c) { return c.key; });
  assert.deepStrictEqual(positive.sort(), ['chance', 'fives', 'ones', 'twoKind', 'twos']);
  assert.strictEqual(scoring.twoKind.length, 2); // two entries on 2x
});

test('suggestion set for 2 2 4 4 4', function () {
  var d = [2, 2, 4, 4, 4];
  var positive = G.CATEGORIES.filter(function (c) {
    return G.scoreFor(c.key, d) > 0;
  }).map(function (c) { return c.key; });
  assert.deepStrictEqual(positive.sort(),
    ['chance', 'fours', 'fullHouse', 'threeKind', 'twoKind', 'twos']);
  assert.strictEqual(G.candidates('twoKind', d).length, 2);
  assert.strictEqual(G.candidates('threeKind', d).length, 1);
});

// ----------------------------------------------------------------- dice

test('rollAll produces DICE_COUNT dice from the rng', function () {
  assert.deepStrictEqual(G.rollAll(fixedDice([1, 2, 3, 4, 5])), [1, 2, 3, 4, 5]);
});

test('rollDie stays within 1..6', function () {
  for (var i = 0; i < 500; i++) {
    var d = G.rollDie();
    assert.ok(d >= 1 && d <= 6 && Number.isInteger(d));
  }
});

test('reroll keeps held dice and replaces the rest in order', function () {
  var result = G.reroll([1, 1, 1, 1, 1], [true, false, true, false, true], fixedDice([6, 4]));
  assert.deepStrictEqual(result, [1, 6, 1, 4, 1]);
});

// ----------------------------------------------------------------- players

test('createPlayer captures name, colour and AI flag', function () {
  var p = G.createPlayer('Иван', '#ff0000', true);
  assert.strictEqual(p.name, 'Иван');
  assert.strictEqual(p.isAI, true);
  assert.deepStrictEqual(p.scores, {});
  assert.strictEqual(G.createPlayer('A', '#000').isAI, false);
});

test('assignScore defaults to the best candidate and blocks overwrite', function () {
  var p = G.createPlayer('A', '#000');
  assert.strictEqual(G.assignScore(p, 'twoKind', [1, 2, 2, 5, 5]), 10); // best pair
  assert.strictEqual(p.scores.twoKind, 10);
  assert.throws(function () { G.assignScore(p, 'twoKind', [3, 3, 1, 1, 1]); });
});

test('assignScore accepts a chosen legal candidate but rejects illegal ones', function () {
  var p = G.createPlayer('A', '#000');
  assert.strictEqual(G.assignScore(p, 'twoKind', [1, 2, 2, 5, 5], 4), 4); // pick the 2s
  assert.throws(function () { G.assignScore(G.createPlayer('B', '#0'), 'twoKind', [1, 2, 2, 5, 5], 7); });
});

test('a category can be sacrificed for 0', function () {
  var p = G.createPlayer('A', '#000');
  assert.strictEqual(G.assignScore(p, 'general', [1, 2, 3, 4, 5]), 0);
  assert.strictEqual(G.isCategoryFilled(p, 'general'), true);
});

test('forfeitScore zeroes any unfilled category, even a scoring one', function () {
  var p = G.createPlayer('A', '#000');
  // chance would score 15 here, but a deliberate forfeit writes 0
  assert.strictEqual(G.forfeitScore(p, 'chance'), 0);
  assert.strictEqual(p.scores.chance, 0);
  assert.throws(function () { G.forfeitScore(p, 'chance'); }); // already filled
});

test('playerTotal sums recorded scores', function () {
  var p = G.createPlayer('A', '#000');
  p.scores.chance = 17;
  p.scores.general = 75;
  assert.strictEqual(G.playerTotal(p), 92);
});

// ----------------------------------------------------------------- game flow

test('turn rotation cycles players and counts rounds', function () {
  var game = G.createGame(['A', 'B', 'C'].map(function (n) { return G.createPlayer(n, '#0'); }));
  assert.strictEqual(G.currentPlayer(game).name, 'A');
  G.nextTurn(game); assert.strictEqual(G.currentPlayer(game).name, 'B');
  G.nextTurn(game); assert.strictEqual(G.currentPlayer(game).name, 'C');
  G.nextTurn(game);
  assert.strictEqual(G.currentPlayer(game).name, 'A');
  assert.strictEqual(game.round, 2);
});

test('isGameOver only when every board is complete', function () {
  var game = G.createGame([G.createPlayer('A', '#0'), G.createPlayer('B', '#0')]);
  G.CATEGORIES.forEach(function (c) { game.players[0].scores[c.key] = 1; });
  assert.strictEqual(G.isGameOver(game), false);
  G.CATEGORIES.forEach(function (c) { game.players[1].scores[c.key] = 1; });
  assert.strictEqual(G.isGameOver(game), true);
});

test('ranking sorts by total desc, stable on ties', function () {
  var game = G.createGame(['A', 'B', 'C'].map(function (n) { return G.createPlayer(n, '#0'); }));
  game.players[0].scores.chance = 10;
  game.players[1].scores.chance = 30;
  game.players[2].scores.chance = 10;
  assert.deepStrictEqual(G.ranking(game).map(function (x) { return x.player.name; }), ['B', 'A', 'C']);
});

// ----------------------------------------------------------------- AI

test('aiChooseHolds keeps the largest matching group', function () {
  assert.deepStrictEqual(G.aiChooseHolds([4, 4, 4, 1, 2]), [true, true, true, false, false]);
  assert.deepStrictEqual(G.aiChooseHolds([2, 2, 5, 5, 1]), [false, false, true, true, false]); // ties pick the higher face (5s)
});

test('aiChooseHolds with no pair keeps the high dice', function () {
  assert.deepStrictEqual(G.aiChooseHolds([1, 2, 3, 5, 6]), [false, false, false, true, true]);
});

test('aiChooseCategory picks the highest-scoring open category', function () {
  var p = G.createPlayer('AI', '#0', true);
  var choice = G.aiChooseCategory(p, [6, 6, 6, 6, 6]); // general = 80
  assert.strictEqual(choice.category, 'general');
  assert.strictEqual(choice.value, G.SCORING.generalBonus + 30);
});

test('aiChooseCategory sacrifices in order when nothing scores', function () {
  var p = G.createPlayer('AI', '#0', true);
  // fill everything except general and ones; a non-scoring roll for both
  G.CATEGORIES.forEach(function (c) {
    if (c.key !== 'general' && c.key !== 'ones') p.scores[c.key] = 0;
  });
  var choice = G.aiChooseCategory(p, [2, 3, 4, 6, 6]); // ones=0, general=0
  assert.strictEqual(choice.category, 'general'); // general sacrificed before ones
  assert.strictEqual(choice.value, 0);
});

test('aiChooseCategory only ever picks an open category', function () {
  var p = G.createPlayer('AI', '#0', true);
  p.scores.chance = 5;
  var choice = G.aiChooseCategory(p, [1, 1, 2, 3, 4]);
  assert.notStrictEqual(choice.category, 'chance');
  assert.strictEqual(G.isCategoryFilled(p, choice.category), false);
});

// ----------------------------------------------------------------- probabilities

function approx(actual, expected, eps) {
  assert.ok(Math.abs(actual - expected) <= (eps || 1e-9),
    'expected ~' + expected + ' got ' + actual);
}

test('hitProbability with no rerolls is 1 if made, else 0', function () {
  assert.strictEqual(G.hitProbability('general', [6, 6, 6, 6, 6], 0), 1);
  assert.strictEqual(G.hitProbability('general', [6, 6, 6, 6, 1], 0), 0);
  assert.strictEqual(G.hitProbability('smallStraight', [1, 2, 3, 4, 5], 2), 1); // already made
});

test('hitProbability stays within [0,1] and never decreases with more rerolls', function () {
  G.CATEGORIES.forEach(function (c) {
    var dice = [1, 2, 3, 4, 6];
    var p1 = G.hitProbability(c.key, dice, 1);
    var p2 = G.hitProbability(c.key, dice, 2);
    assert.ok(p1 >= 0 && p1 <= 1 && p2 >= 0 && p2 <= 1);
    assert.ok(p2 >= p1 - 1e-12, c.key + ': more rerolls should not lower the chance');
  });
});

test('chance is always certain', function () {
  assert.strictEqual(G.hitProbability('chance', [1, 1, 1, 1, 1], 0), 1);
  assert.strictEqual(G.hitProbability('chance', [2, 4, 6, 1, 3], 2), 1);
});

test('one reroll for the last die of a general is exactly 1/6', function () {
  approx(G.hitProbability('general', [6, 6, 6, 6, 1], 1), 1 / 6, 1e-12);
});

test('chance to roll a face with one reroll of five dice', function () {
  // need at least one 1, currently none, reroll all five
  approx(G.hitProbability('ones', [2, 3, 4, 5, 6], 1), 1 - Math.pow(5 / 6, 5), 1e-12);
});

test('hitProbabilityFresh is a valid probability for every category', function () {
  G.CATEGORIES.forEach(function (c) {
    var p = G.hitProbabilityFresh(c.key);
    assert.ok(p >= 0 && p <= 1, c.key + ' fresh prob out of range: ' + p);
  });
  approx(G.hitProbabilityFresh('chance'), 1, 1e-9);
});

// ----------------------------------------------------------------- risk & roasts

test('bestOpenScore ignores already-filled categories', function () {
  var p = G.createPlayer('A', '#0');
  assert.strictEqual(G.bestOpenScore(p, [5, 5, 5, 1, 2]), 18); // 3x = 15? no: threeKind 15, chance 18
  p.scores.chance = 0; // remove chance from the pool
  assert.strictEqual(G.bestOpenScore(p, [5, 5, 5, 1, 2]), 15); // now threeKind 15 leads
});

test('atRiskPremium flags a made combo not preserved by the holds', function () {
  var p = G.createPlayer('A', '#0');
  // full house held only by the triple -> the pair is being rerolled
  var risk = G.atRiskPremium(p, [3, 3, 3, 2, 2], [true, true, true, false, false]);
  assert.strictEqual(risk.length, 1);
  assert.strictEqual(risk[0].key, 'fullHouse');
});

test('atRiskPremium is empty when the combo is preserved or already filled', function () {
  var p = G.createPlayer('A', '#0');
  // four of a kind kept, only the fifth die rerolled -> not at risk
  assert.strictEqual(G.atRiskPremium(p, [5, 5, 5, 5, 2], [true, true, true, true, false]).length, 0);
  // same gamble but four-of-a-kind already scored -> nothing to lose
  p.scores.fourKind = 20;
  assert.strictEqual(G.atRiskPremium(p, [5, 5, 5, 5, 2], [true, true, true, false, false]).length, 0);
});

test('roast pools are non-empty', function () {
  assert.ok(G.ROASTS.risk.length > 0 && G.ROASTS.fail.length > 0);
});

// --------------------------------------------------- Bulgarian agreement engine

test('inflectAdj agrees with gender (regular pattern)', function () {
  assert.strictEqual(G.inflectAdj({ base: 'смотан' }, 'm'), 'смотан');
  assert.strictEqual(G.inflectAdj({ base: 'смотан' }, 'f'), 'смотана');
  assert.strictEqual(G.inflectAdj({ base: 'смотан' }, 'n'), 'смотано');
});

test('inflectAdj leaves indeclinable adjectives untouched', function () {
  var inv = { base: 'електро', inv: true };
  assert.strictEqual(G.inflectAdj(inv, 'm'), 'електро');
  assert.strictEqual(G.inflectAdj(inv, 'f'), 'електро');
  assert.strictEqual(G.inflectAdj(inv, 'n'), 'електро');
});

test('possessive agrees with gender (subject vs object for masc)', function () {
  assert.strictEqual(G.possessive('m', true), 'твоят');
  assert.strictEqual(G.possessive('m', false), 'твоя');
  assert.strictEqual(G.possessive('f', true), 'твоята');
  assert.strictEqual(G.possessive('n', false), 'твоето');
});

test('renderRoast fills grammar tokens coherently per combo gender', function () {
  // feminine combo: малка кента (sentence-cased)
  assert.strictEqual(G.renderRoast('{ps} {c} замина.', 'smallStraight'), 'Твоята малка кента замина.');
  // masculine combo: генерал (subject form)
  assert.strictEqual(G.renderRoast('{ps} {c} замина.', 'general'), 'Твоят генерал замина.');
  // neuter combo: каре (object form)
  assert.strictEqual(G.renderRoast('Сбогом на {po} {c}.', 'fourKind'), 'Сбогом на твоето каре.');
});

test('every premium combo has roast grammar', function () {
  G.PREMIUM.forEach(function (k) {
    assert.ok(G.COMBO_GRAMMAR[k], 'missing grammar for ' + k);
  });
});

test('generated names agree: adjective matches noun gender', function () {
  // a feminine noun must get a feminine adjective (ends in 'а' for our set)
  // sample many names and check coherence holds structurally
  for (var i = 0; i < 50; i++) {
    var name = G.randomHumanName();
    assert.strictEqual(name.split(' ').length, 3, 'Title + Adj + Noun: ' + name);
  }
  // deterministic check via a forced rng that always picks index 0:
  //   TITLES[0]=Генерал, ADJS[0]=смотан, NOUNS[0]=Пишка (feminine)
  var zero = function () { return 0; };
  assert.strictEqual(G.randomHumanName(zero), 'Генерал Смотана Пишка');
});

// ----------------------------------------------------------------- names

test('name generators follow Title + Adjective + Noun', function () {
  assert.strictEqual(G.randomHumanName().split(' ').length, 3);
  assert.strictEqual(G.randomAiName().split(' ').length, 3);
});

test('randomBet returns a non-empty wager', function () {
  assert.strictEqual(typeof G.randomBet(), 'string');
  assert.ok(G.randomBet().length > 0);
});

test('nameGenerator yields distinct names', function () {
  var gen = G.nameGenerator('human');
  var seen = {};
  for (var i = 0; i < 8; i++) {
    var n = gen();
    assert.strictEqual(seen[n], undefined, 'duplicate name: ' + n);
    seen[n] = true;
  }
});

// ----------------------------------------------------------- full play-through

test('a full solo game fills every category exactly once', function () {
  var game = G.createGame([G.createPlayer('Solo', '#0')]);
  G.CATEGORIES.forEach(function (c) {
    G.assignScore(G.currentPlayer(game), c.key, [1, 2, 3, 4, 5]);
    G.nextTurn(game);
  });
  assert.strictEqual(G.isGameOver(game), true);
});
