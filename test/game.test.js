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

// ----------------------------------------------------------------- names

test('name generators follow Title + Adjective + Noun', function () {
  var h = G.randomHumanName();
  var a = G.randomAiName();
  assert.strictEqual(h.split(' ').length >= 3, true);
  assert.strictEqual(a.split(' ').length >= 3, true);
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
