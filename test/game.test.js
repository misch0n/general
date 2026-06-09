'use strict';

var test = require('node:test');
var assert = require('node:assert');
var G = require('../game.js');

// A deterministic RNG: given a list of desired die faces (1..6), returns a
// function shaped like Math.random that makes rollDie produce exactly those
// faces, in order, cycling if exhausted.
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

test('sum adds all dice', function () {
  assert.strictEqual(G.sum([1, 2, 3, 4, 5]), 15);
  assert.strictEqual(G.sum([6, 6, 6, 6, 6]), 30);
});

test('sumOfFace adds only matching dice', function () {
  assert.strictEqual(G.sumOfFace([3, 3, 3, 1, 2], 3), 9);
  assert.strictEqual(G.sumOfFace([3, 3, 3, 1, 2], 5), 0);
});

test('hasNOfAKind detection', function () {
  assert.strictEqual(G.hasNOfAKind([2, 2, 5, 1, 6], 2), true);
  assert.strictEqual(G.hasNOfAKind([2, 2, 5, 1, 6], 3), false);
  assert.strictEqual(G.hasNOfAKind([4, 4, 4, 4, 1], 4), true);
});

test('isFullHouse: triple + pair only', function () {
  assert.strictEqual(G.isFullHouse([2, 2, 3, 3, 3]), true);
  assert.strictEqual(G.isFullHouse([5, 5, 5, 1, 1]), true);
  assert.strictEqual(G.isFullHouse([2, 2, 2, 2, 3]), false); // four + one
  assert.strictEqual(G.isFullHouse([4, 4, 4, 4, 4]), false); // five of a kind
  assert.strictEqual(G.isFullHouse([1, 2, 3, 4, 5]), false);
});

test('hasStraight: small (4) and large (5)', function () {
  assert.strictEqual(G.hasStraight([1, 2, 3, 4, 6], 4), true);
  assert.strictEqual(G.hasStraight([3, 4, 5, 6, 6], 4), true);
  assert.strictEqual(G.hasStraight([1, 2, 3, 5, 6], 4), false);
  assert.strictEqual(G.hasStraight([1, 2, 3, 4, 5], 5), true);
  assert.strictEqual(G.hasStraight([2, 3, 4, 5, 6], 5), true);
  assert.strictEqual(G.hasStraight([1, 2, 3, 4, 6], 5), false);
});

test('isGeneral: all five equal', function () {
  assert.strictEqual(G.isGeneral([5, 5, 5, 5, 5]), true);
  assert.strictEqual(G.isGeneral([5, 5, 5, 5, 1]), false);
});

// ----------------------------------------------------------------- scoring

test('upper section scores sum of matching face', function () {
  assert.strictEqual(G.scoreFor('ones', [1, 1, 1, 4, 5]), 3);
  assert.strictEqual(G.scoreFor('twos', [2, 2, 6, 6, 6]), 4);
  assert.strictEqual(G.scoreFor('sixes', [6, 6, 6, 6, 1]), 24);
  assert.strictEqual(G.scoreFor('threes', [1, 2, 4, 5, 6]), 0);
});

test('2x/3x/4x score sum of all dice when satisfied, else 0', function () {
  assert.strictEqual(G.scoreFor('twoKind', [2, 2, 1, 3, 4]), 12);
  assert.strictEqual(G.scoreFor('twoKind', [1, 2, 3, 4, 5]), 0);
  assert.strictEqual(G.scoreFor('threeKind', [5, 5, 5, 1, 2]), 18);
  assert.strictEqual(G.scoreFor('threeKind', [5, 5, 1, 2, 3]), 0);
  assert.strictEqual(G.scoreFor('fourKind', [4, 4, 4, 4, 6]), 22);
  assert.strictEqual(G.scoreFor('fourKind', [4, 4, 4, 1, 6]), 0);
});

test('a general satisfies the lower N-of-a-kind categories', function () {
  assert.strictEqual(G.scoreFor('twoKind', [3, 3, 3, 3, 3]), 15);
  assert.strictEqual(G.scoreFor('threeKind', [3, 3, 3, 3, 3]), 15);
  assert.strictEqual(G.scoreFor('fourKind', [3, 3, 3, 3, 3]), 15);
});

test('fixed-value categories', function () {
  assert.strictEqual(G.scoreFor('fullHouse', [2, 2, 3, 3, 3]), G.SCORING.fullHouse);
  assert.strictEqual(G.scoreFor('fullHouse', [2, 2, 2, 2, 3]), 0);
  assert.strictEqual(G.scoreFor('smallStraight', [1, 2, 3, 4, 6]), G.SCORING.smallStraight);
  assert.strictEqual(G.scoreFor('smallStraight', [1, 1, 3, 4, 6]), 0);
  assert.strictEqual(G.scoreFor('largeStraight', [2, 3, 4, 5, 6]), G.SCORING.largeStraight);
  assert.strictEqual(G.scoreFor('largeStraight', [1, 2, 3, 4, 6]), 0);
  assert.strictEqual(G.scoreFor('general', [6, 6, 6, 6, 6]), G.SCORING.general);
  assert.strictEqual(G.scoreFor('general', [6, 6, 6, 6, 1]), 0);
});

test('chance scores the sum of all dice', function () {
  assert.strictEqual(G.scoreFor('chance', [1, 3, 3, 5, 6]), 18);
});

test('scoreFor rejects an unknown category', function () {
  assert.throws(function () { G.scoreFor('nope', [1, 2, 3, 4, 5]); });
});

test('every category has a scorer', function () {
  G.CATEGORIES.forEach(function (c) {
    assert.strictEqual(typeof G.SCORERS[c.key], 'function', 'missing scorer for ' + c.key);
  });
});

// ----------------------------------------------------------------- dice

test('rollAll produces DICE_COUNT dice from the rng', function () {
  var dice = G.rollAll(fixedDice([1, 2, 3, 4, 5]));
  assert.deepStrictEqual(dice, [1, 2, 3, 4, 5]);
});

test('rollDie stays within 1..6 across many random rolls', function () {
  for (var i = 0; i < 500; i++) {
    var d = G.rollDie();
    assert.ok(d >= 1 && d <= 6 && Number.isInteger(d));
  }
});

test('reroll keeps held dice and replaces the rest in order', function () {
  var dice = [1, 1, 1, 1, 1];
  var holds = [true, false, true, false, true];
  var result = G.reroll(dice, holds, fixedDice([6, 4]));
  assert.deepStrictEqual(result, [1, 6, 1, 4, 1]);
});

test('reroll with all dice held returns the same dice', function () {
  var dice = [2, 3, 4, 5, 6];
  var result = G.reroll(dice, [true, true, true, true, true], fixedDice([1]));
  assert.deepStrictEqual(result, [2, 3, 4, 5, 6]);
});

// ----------------------------------------------------------------- players

test('createPlayer starts with an empty board', function () {
  var p = G.createPlayer('Иван', '#ff0000');
  assert.strictEqual(p.name, 'Иван');
  assert.strictEqual(p.color, '#ff0000');
  assert.deepStrictEqual(p.scores, {});
  assert.strictEqual(G.isBoardComplete(p), false);
});

test('assignScore records the score and prevents overwrite', function () {
  var p = G.createPlayer('A', '#000');
  assert.strictEqual(G.assignScore(p, 'fives', [5, 5, 5, 1, 2]), 15);
  assert.strictEqual(p.scores.fives, 15);
  assert.throws(function () { G.assignScore(p, 'fives', [5, 5, 5, 5, 5]); });
});

test('assignScore can record a zero (sacrificing a category)', function () {
  var p = G.createPlayer('A', '#000');
  assert.strictEqual(G.assignScore(p, 'general', [1, 2, 3, 4, 5]), 0);
  assert.strictEqual(G.isCategoryFilled(p, 'general'), true);
});

test('playerTotal and isBoardComplete', function () {
  var p = G.createPlayer('A', '#000');
  G.CATEGORIES.forEach(function (c) { p.scores[c.key] = 0; });
  assert.strictEqual(G.isBoardComplete(p), true);
  p.scores.chance = 17;
  assert.strictEqual(G.playerTotal(p), 17);
});

// ----------------------------------------------------------------- game

test('turn rotation cycles players and counts rounds', function () {
  var game = G.createGame([
    G.createPlayer('A', '#a'),
    G.createPlayer('B', '#b'),
    G.createPlayer('C', '#c'),
  ]);
  assert.strictEqual(G.currentPlayer(game).name, 'A');
  assert.strictEqual(game.round, 1);

  G.nextTurn(game);
  assert.strictEqual(G.currentPlayer(game).name, 'B');
  assert.strictEqual(game.round, 1);

  G.nextTurn(game);
  assert.strictEqual(G.currentPlayer(game).name, 'C');

  G.nextTurn(game); // wraps back to A => new round
  assert.strictEqual(G.currentPlayer(game).name, 'A');
  assert.strictEqual(game.round, 2);
});

test('game supports a single player', function () {
  var game = G.createGame([G.createPlayer('Solo', '#a')]);
  G.nextTurn(game);
  assert.strictEqual(G.currentPlayer(game).name, 'Solo');
  assert.strictEqual(game.round, 2);
});

test('isGameOver only when every board is complete', function () {
  var game = G.createGame([G.createPlayer('A', '#a'), G.createPlayer('B', '#b')]);
  G.CATEGORIES.forEach(function (c) { game.players[0].scores[c.key] = 1; });
  assert.strictEqual(G.isGameOver(game), false);
  G.CATEGORIES.forEach(function (c) { game.players[1].scores[c.key] = 1; });
  assert.strictEqual(G.isGameOver(game), true);
});

test('ranking sorts by total descending, stable on ties', function () {
  var game = G.createGame([
    G.createPlayer('A', '#a'),
    G.createPlayer('B', '#b'),
    G.createPlayer('C', '#c'),
  ]);
  game.players[0].scores.chance = 10; // A = 10
  game.players[1].scores.chance = 30; // B = 30
  game.players[2].scores.chance = 10; // C = 10 (ties A, keeps order)
  var r = G.ranking(game);
  assert.deepStrictEqual(r.map(function (x) { return x.player.name; }), ['B', 'A', 'C']);
  assert.strictEqual(r[0].total, 30);
});

// ----------------------------------------------------------- full play-through

test('a full solo game fills every category exactly once', function () {
  var game = G.createGame([G.createPlayer('Solo', '#a')]);
  G.CATEGORIES.forEach(function (c) {
    var p = G.currentPlayer(game);
    G.assignScore(p, c.key, [1, 2, 3, 4, 5]);
    G.nextTurn(game);
  });
  assert.strictEqual(G.isGameOver(game), true);
  assert.strictEqual(G.isBoardComplete(game.players[0]), true);
});
