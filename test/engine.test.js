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
