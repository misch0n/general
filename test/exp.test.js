'use strict';

var test = require('node:test');
var assert = require('node:assert');
var G = require('../public/game.js');
var X = require('../public/exp.js');

function player(name) { return X.createPlayerCard({ name: name, scores: {} }); }

test('a fresh card is empty and all rows are available (free order)', function () {
  var p = player('A');
  assert.strictEqual(X.filledCount(p.scores), 0);
  assert.strictEqual(X.playerDone(p), false);
  assert.strictEqual(X.availableKeys(p).length, X.KEYS.length);
  assert.ok(X.canPlay(p, 'general'));
  assert.ok(X.canPlay(p, 'ones'));
});

test('rows can be filled in any order; a filled row is no longer available', function () {
  var p = player('A');
  X.assignScore(p, 'general', [6, 6, 6, 6, 6]);   // 80
  assert.ok(!X.canPlay(p, 'general'));
  assert.strictEqual(X.availableKeys(p).indexOf('general'), -1);
  assert.strictEqual(X.availableKeys(p).length, X.KEYS.length - 1);
});

test('a forfeit writes 0; assign defaults to the row score for the dice', function () {
  var p = player('A');
  X.assignScore(p, 'fourKind', [1, 2, 3, 4, 5], 0);   // crossed out → 0
  assert.strictEqual(p.scores.fourKind, 0);
  X.assignScore(p, 'chance', [6, 5, 4, 3, 2]);         // default → sum 20
  assert.strictEqual(p.scores.chance, 20);
});

test('game over only when every player filled all 15 rows', function () {
  var g = X.createGame([player('A'), player('B')]);
  assert.strictEqual(X.isGameOver(g), false);
  g.players.forEach(function (p) { X.KEYS.forEach(function (k) { X.assignScore(p, k, [6, 6, 6, 6, 6]); }); });
  assert.strictEqual(X.isGameOver(g), true);
});

test('nextTurn skips a finished player and advances the round', function () {
  var g = X.createGame([player('A'), player('B')]);
  X.KEYS.forEach(function (k) { X.assignScore(g.players[1], k, [1, 2, 3, 4, 5]); });   // B done
  g.current = 0;
  X.nextTurn(g);
  assert.strictEqual(g.current, 0);   // B is done → bounced back to A
});

test('AI keeps the relevant dice and writes a sensible row', function () {
  var p = player('A');
  assert.deepStrictEqual(X.aiKeeps(p, [6, 6, 6, 6, 1]), [true, true, true, true, false]);
  assert.strictEqual(X.aiChooseKey(p, [6, 6, 6, 6, 6]), 'general');   // don't waste five-of-a-kind
});

test('ranking orders players by penalised grand total', function () {
  var a = player('A'), b = player('B');
  X.assignScore(a, 'general', [6, 6, 6, 6, 6]);   // 80
  X.assignScore(b, 'chance', [2, 2, 1, 1, 1]);    // 7
  var g = { players: [b, a] };
  var r = X.ranking(g);
  assert.strictEqual(r[0].player.name, 'A');
  assert.strictEqual(r[0].total, 80);
});
