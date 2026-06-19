'use strict';

// First unit coverage for the app game-loop: the pure turn-flow reducer (reduce.js).
// The live loop (features/game/game.js) was puppeteer-only; reduce() being pure and
// DOM-free makes the turn mechanics directly testable here.

var test = require('node:test');
var assert = require('node:assert');
var R = require('../reduce.js');

var ROLLS = R.ROLLS;     // 3
var DICE = R.DICE_COUNT; // 5

// minimal game state around a turn; helpers fill in what each action reads
function st(over) {
  var s = { ruleset: 'standard', manual: false, current: 0, round: 1,
            players: [{ scores: {} }, { scores: {} }], turn: R.freshTurn() };
  return Object.assign(s, over || {});
}
function turn(over) { return Object.assign(R.freshTurn(), over || {}); }

// ----------------------------------------------------------------- freshTurn

test('freshTurn is the documented default shape', function () {
  assert.deepStrictEqual(R.freshTurn(), {
    dice: [], selected: [false, false, false, false, false],
    diceNew: [false, false, false, false, false], diceGen: [], throwsLeft: 0, rollNo: 0,
    awaitingRoll: false, locked: false, aiBusy: false, rerolledAll: false,
    manualCounts: [0, 0, 0, 0, 0, 0, 0], curLog: null });
});

test('freshTurn returns a fresh object each call (no shared arrays)', function () {
  var a = R.freshTurn(), b = R.freshTurn();
  a.dice.push(1); a.selected[0] = true;
  assert.deepStrictEqual(b.dice, []);
  assert.strictEqual(b.selected[0], false);
});

// --------------------------------------------------------- manualDiceFromCounts

test('manualDiceFromCounts expands a per-face tally to a sorted hand', function () {
  assert.deepStrictEqual(R.manualDiceFromCounts([0, 2, 0, 1, 0, 0, 2]), [1, 1, 3, 6, 6]);
  assert.deepStrictEqual(R.manualDiceFromCounts([0, 0, 0, 0, 0, 0, 0]), []);
});

// ------------------------------------------------------------------- purity

test('reduce never mutates the input state or turn', function () {
  var s = st();
  var before = JSON.stringify(s);
  R.reduce(s, { type: 'BEGIN_TURN', mode: 'dice' });
  R.reduce(s, { type: 'FIRST_ROLL', dice: [3, 1, 2, 5, 4] });
  R.reduce(s, { type: 'NEXT_TURN' });
  assert.strictEqual(JSON.stringify(s), before);
});

test('unknown action returns the same state reference (no-op)', function () {
  var s = st();
  assert.strictEqual(R.reduce(s, { type: 'NOPE' }), s);
});

// ----------------------------------------------------------------- BEGIN_TURN

test('BEGIN_TURN dice: waits on a first throw with ROLLS-1 rerolls queued', function () {
  var s = st({ turn: turn({ locked: true, dice: [6, 6, 6], rollNo: 2, diceGen: [2, 2, 2] }) });
  var t = R.reduce(s, { type: 'BEGIN_TURN', mode: 'dice' }).turn;
  assert.strictEqual(t.awaitingRoll, true);
  assert.strictEqual(t.locked, false);
  assert.strictEqual(t.throwsLeft, ROLLS - 1);
  assert.deepStrictEqual(t.dice, []);
  assert.strictEqual(t.rollNo, 0);
  assert.deepStrictEqual(t.diceGen, []);
  assert.deepStrictEqual(t.selected, [false, false, false, false, false]);
  assert.strictEqual(t.curLog, null);
});

test('BEGIN_TURN manual: zeroes the tally, no throws, not awaiting', function () {
  var s = st({ manual: true, turn: turn({ manualCounts: [0, 3, 0, 0, 0, 0, 0], dice: [1, 1, 1] }) });
  var t = R.reduce(s, { type: 'BEGIN_TURN', mode: 'manual' }).turn;
  assert.deepStrictEqual(t.manualCounts, [0, 0, 0, 0, 0, 0, 0]);
  assert.deepStrictEqual(t.dice, []);
  assert.strictEqual(t.throwsLeft, 0);
  assert.strictEqual(t.awaitingRoll, false);
});

test('BEGIN_TURN net: active device may roll; watchers are locked', function () {
  var mine = R.reduce(st(), { type: 'BEGIN_TURN', mode: 'net', myTurn: true }).turn;
  assert.strictEqual(mine.awaitingRoll, true);
  assert.strictEqual(mine.locked, false);
  assert.strictEqual(mine.throwsLeft, ROLLS - 1);
  var watch = R.reduce(st(), { type: 'BEGIN_TURN', mode: 'net', myTurn: false }).turn;
  assert.strictEqual(watch.awaitingRoll, false);
  assert.strictEqual(watch.locked, true);
  assert.strictEqual(watch.throwsLeft, 0);
});

test('BEGIN_TURN leaves aiBusy untouched (common prologue only)', function () {
  var s = st({ turn: turn({ aiBusy: true }) });
  assert.strictEqual(R.reduce(s, { type: 'BEGIN_TURN', mode: 'dice' }).turn.aiBusy, true);
});

// ----------------------------------------------------------------- FIRST_ROLL

test('FIRST_ROLL sorts the dice, stamps generation 1, stops awaiting', function () {
  var s = st({ turn: turn({ awaitingRoll: true, throwsLeft: ROLLS - 1 }) });
  var t = R.reduce(s, { type: 'FIRST_ROLL', dice: [5, 1, 3, 2, 4] }).turn;
  assert.deepStrictEqual(t.dice, [1, 2, 3, 4, 5]);
  assert.strictEqual(t.rollNo, 1);
  assert.deepStrictEqual(t.diceGen, [1, 1, 1, 1, 1]);
  assert.strictEqual(t.awaitingRoll, false);
  assert.strictEqual(t.throwsLeft, ROLLS - 1);   // preserved
});

test('FIRST_ROLL is a no-op unless awaiting a throw', function () {
  var s = st({ turn: turn({ awaitingRoll: false }) });
  assert.strictEqual(R.reduce(s, { type: 'FIRST_ROLL', dice: [1, 1, 1, 1, 1] }), s);
  var locked = st({ turn: turn({ awaitingRoll: true, locked: true }) });
  assert.strictEqual(R.reduce(locked, { type: 'FIRST_ROLL', dice: [1, 1, 1, 1, 1] }), locked);
});

// -------------------------------------------------------------------- REROLL

test('REROLL re-throws only the masked dice, ascending sort by default', function () {
  var s = st({ turn: turn({ dice: [2, 3, 4, 5, 6], rollNo: 1, diceGen: [1, 1, 1, 1, 1] }) });
  // throw positions 0 and 4 → 6 and 1
  var t = R.reduce(s, { type: 'REROLL', mask: [true, false, false, false, true], faces: [6, 0, 0, 0, 1], batch: false }).turn;
  assert.deepStrictEqual(t.dice, [1, 3, 4, 5, 6]);
  assert.strictEqual(t.rollNo, 2);
  // diceNew marks the freshly thrown faces after the sort
  var fresh = t.dice.map(function (v, i) { return t.diceNew[i] ? v : null; }).filter(function (v) { return v !== null; });
  assert.deepStrictEqual(fresh.sort(function (a, b) { return a - b; }), [1, 6]);
});

test('REROLL batch mode groups kept dice then the fresh generation', function () {
  var s = st({ turn: turn({ dice: [2, 3, 4, 5, 6], rollNo: 1, diceGen: [1, 1, 1, 1, 1] }) });
  var t = R.reduce(s, { type: 'REROLL', mask: [true, false, false, false, true], faces: [1, 0, 0, 0, 1], batch: true }).turn;
  // kept gen-1 (3,4,5) sort first, then fresh gen-2 (1,1)
  assert.deepStrictEqual(t.dice, [3, 4, 5, 1, 1]);
  assert.deepStrictEqual(t.diceGen, [1, 1, 1, 2, 2]);
  assert.deepStrictEqual(t.diceNew, [false, false, false, true, true]);
});

// ----------------------------------------------------------------- TAP_MANUAL

test('TAP_MANUAL counts a die and rebuilds the hand', function () {
  var s = st({ manual: true, turn: turn({ manualCounts: [0, 1, 0, 0, 0, 0, 0], dice: [1] }) });
  var t = R.reduce(s, { type: 'TAP_MANUAL', face: 4 }).turn;
  assert.deepStrictEqual(t.manualCounts, [0, 1, 0, 0, 1, 0, 0]);
  assert.deepStrictEqual(t.dice, [1, 4]);
});

test('TAP_MANUAL no-ops when locked or the hand is full', function () {
  var locked = st({ turn: turn({ locked: true }) });
  assert.strictEqual(R.reduce(locked, { type: 'TAP_MANUAL', face: 1 }), locked);
  var full = st({ turn: turn({ dice: [1, 2, 3, 4, 5], manualCounts: [0, 1, 1, 1, 1, 1, 0] }) });
  assert.strictEqual(R.reduce(full, { type: 'TAP_MANUAL', face: 1 }), full);
});

// -------------------------------------------------------------------- COMMIT

test('COMMIT locks the turn', function () {
  var s = st({ turn: turn({ dice: [1, 1, 1, 1, 1] }) });
  var t = R.reduce(s, { type: 'COMMIT' }).turn;
  assert.strictEqual(t.locked, true);
  assert.deepStrictEqual(t.dice, [1, 1, 1, 1, 1]);   // hand untouched
});

// ---------------------------------------------------------------------- UNDO

test('UNDO of a tap un-counts one die and unlocks', function () {
  var s = st({ manual: true, turn: turn({ manualCounts: [0, 2, 0, 0, 0, 0, 0], dice: [1, 1], locked: true }) });
  var t = R.reduce(s, { type: 'UNDO', entry: { t: 'tap', face: 1 } }).turn;
  assert.deepStrictEqual(t.manualCounts, [0, 1, 0, 0, 0, 0, 0]);
  assert.deepStrictEqual(t.dice, [1]);
  assert.strictEqual(t.locked, false);
});

test('UNDO of a commit restores the entered hand and rewinds the cursor', function () {
  var s = st({ manual: true, current: 1, round: 3, turn: turn({ locked: true }) });
  var entry = { t: 'commit', playerIdx: 0, key: 'ones', prevRound: 2, counts: [0, 0, 0, 2, 0, 0, 1] };
  var n = R.reduce(s, { type: 'UNDO', entry: entry });
  assert.strictEqual(n.current, 0);
  assert.strictEqual(n.round, 2);
  assert.deepStrictEqual(n.turn.manualCounts, [0, 0, 0, 2, 0, 0, 1]);
  assert.deepStrictEqual(n.turn.dice, [3, 3, 6]);
  assert.strictEqual(n.turn.locked, false);
});

// ----------------------------------------------------------------- NEXT_TURN

test('NEXT_TURN advances the seat and bumps the round on wrap', function () {
  var two = st({ players: [{}, {}], current: 0, round: 1 });
  var a = R.reduce(two, { type: 'NEXT_TURN' });
  assert.strictEqual(a.current, 1);
  assert.strictEqual(a.round, 1);
  var b = R.reduce(Object.assign({}, two, { current: 1 }), { type: 'NEXT_TURN' });
  assert.strictEqual(b.current, 0);
  assert.strictEqual(b.round, 2);   // wrapped → new round
});

// ----------------------------------------------------------------- END_GAME

test('END_GAME is a recognised no-op (end screen is pure UI)', function () {
  var s = st();
  assert.strictEqual(R.reduce(s, { type: 'END_GAME' }), s);
});

// ---------------------------------------------------- a full local turn sequence

test('a human turn threads through reduce: begin → roll → reroll → commit → next', function () {
  var s = st();
  s = R.reduce(s, { type: 'BEGIN_TURN', mode: 'dice' });
  assert.strictEqual(s.turn.awaitingRoll, true);
  s = R.reduce(s, { type: 'FIRST_ROLL', dice: [1, 1, 2, 3, 6] });
  assert.deepStrictEqual(s.turn.dice, [1, 1, 2, 3, 6]);
  // keep the pair of 1s, re-throw the other three to 1,1,1 → five 1s
  s = R.reduce(s, { type: 'REROLL', mask: [false, false, true, true, true], faces: [0, 0, 1, 1, 1], batch: false });
  assert.deepStrictEqual(s.turn.dice, [1, 1, 1, 1, 1]);
  assert.strictEqual(s.turn.rollNo, 2);
  s = R.reduce(s, { type: 'COMMIT' });
  assert.strictEqual(s.turn.locked, true);
  s = R.reduce(s, { type: 'NEXT_TURN' });
  assert.strictEqual(s.current, 1);
});
