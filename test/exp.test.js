'use strict';

var test = require('node:test');
var assert = require('node:assert');
var G = require('../game.js');
var X = require('../exp.js');

function player(name) { return X.createPlayerCard({ name: name, scores: {} }); }

test('a fresh card has three empty columns and a zero reserve', function () {
  var p = player('A');
  assert.strictEqual(p.cols.length, 3);
  assert.strictEqual(p.reserve, 0);
  assert.strictEqual(X.activeCol(p), 0);
  assert.strictEqual(X.playerDone(p), false);
});

test('column 0 is forced top-to-bottom; columns 1 & 2 are free', function () {
  var p = player('A');
  // column 0: only the next-in-order cell is available
  var av = X.availableCells(p);
  assert.strictEqual(av.length, 1);
  assert.deepStrictEqual(av[0], { col: 0, key: 'ones' });
  assert.ok(X.canPlay(p, 0, 'ones'));
  assert.ok(!X.canPlay(p, 0, 'twos'));
  // fill column 0 entirely (in order)
  X.KEYS.forEach(function (k) { X.assignScore(p, 0, k, [1, 1, 1, 2, 3]); });
  assert.strictEqual(X.activeCol(p), 1);
  // column 1: any unfilled cell is available
  var av1 = X.availableCells(p);
  assert.strictEqual(av1.length, X.KEYS.length);
  assert.ok(X.canPlay(p, 1, 'general'));
});

test('reserve banking and column-2 spending', function () {
  var p = player('A');
  X.bankReserve(p, 2); X.bankReserve(p, 1);
  assert.strictEqual(p.reserve, 3);
  // not spendable outside column 2
  assert.strictEqual(X.canSpendReserve(p, 0), false);
  // jump the card to column 2
  X.KEYS.forEach(function (k) { X.assignScore(p, 0, k, [1, 1, 1, 2, 3]); });
  X.KEYS.forEach(function (k) { X.assignScore(p, 1, k, [1, 1, 1, 2, 3]); });
  assert.strictEqual(X.activeCol(p), 2);
  assert.strictEqual(X.canSpendReserve(p, 0), true);   // throws spent, reserve available
  assert.strictEqual(X.canSpendReserve(p, 1), false);  // still has a normal re-roll
});

test('game over only when every player finished all three columns', function () {
  var g = X.createGame([player('A'), player('B')]);
  assert.strictEqual(X.isGameOver(g), false);
  g.players.forEach(function (p) {
    for (var c = 0; c < 3; c++) X.KEYS.forEach(function (k) { X.assignScore(p, c, k, [6, 6, 6, 6, 6]); });
  });
  assert.strictEqual(X.isGameOver(g), true);
});

test('nextTurn skips finished players and advances the turn counter', function () {
  var g = X.createGame([player('A'), player('B')]);
  // finish player B entirely
  var b = g.players[1];
  for (var c = 0; c < 3; c++) X.KEYS.forEach(function (k) { X.assignScore(b, c, k, [1, 2, 3, 4, 5]); });
  g.current = 0;
  X.nextTurn(g);
  assert.strictEqual(g.current, 0);   // B is done → bounced back to A
});

test('AI keeps the relevant dice and writes a sensible cell', function () {
  var p = player('A');
  // jump to a free column so the AI has choices
  X.KEYS.forEach(function (k) { X.assignScore(p, 0, k, [1, 1, 1, 2, 3]); });
  // chasing with four sixes showing → keep the sixes
  var keeps = X.aiKeeps(p, [6, 6, 6, 6, 1], 2);
  assert.deepStrictEqual(keeps, [true, true, true, true, false]);
  // a five-of-a-kind roll should be written to general (50 + sum), not dumped
  var cell = X.aiChooseCell(p, [6, 6, 6, 6, 6]);
  assert.strictEqual(cell.key, 'general');
});

test('grand total runs through the engine', function () {
  var p = player('A');
  X.assignScore(p, 0, 'chance', [6, 6, 6, 6, 6]);   // 30
  X.assignScore(p, 1, 'general', [6, 6, 6, 6, 6]);  // 80
  assert.strictEqual(X.total(p), 110);
});
