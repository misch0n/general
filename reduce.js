/*
 * General (Генерал) — pure turn-flow reducer.
 *
 * The app game-loop (features/game/game.js) historically mutated ~20 scattered
 * globals in place, with no unit coverage (only puppeteer drove the loop). This
 * module factors the *state transitions* of a turn into one pure
 * `reduce(state, action)`: given a game state and an action it returns the NEXT
 * state and never mutates its input nor touches the DOM. Side effects (render,
 * net send, timers, AI scheduling, per-turn logging) stay in the imperative
 * shell that calls reduce.
 *
 * Scope (Task A, slice 3): the local turn mechanics — BEGIN_TURN, FIRST_ROLL,
 * REROLL, COMMIT, TAP_MANUAL, UNDO, NEXT_TURN, END_GAME. Random dice are NOT
 * rolled here (that would make it non-deterministic); the shell rolls and hands
 * the faces in via the action, which also makes every transition unit-testable.
 * Merging the experimental path (slice 4) and net/serialization (slice 5) build
 * on this.
 *
 * Loaded by the browser (index.html, as `window.GReduce`) and by the test suite
 * (`require('./reduce.js')`) via the UMD wrapper below; depends only on the
 * engine for the two fixed counts (DICE_COUNT, MAX_ROLLS).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./game.js'));
  else root.GReduce = factory(root.General);
})(typeof self !== 'undefined' ? self : this, function (G) {
  'use strict';

  var DICE_COUNT = G.DICE_COUNT;   // 5
  var ROLLS = G.MAX_ROLLS;         // 3 (1 first roll + ROLLS-1 rerolls)

  // The per-turn state, defaulted. Single source of truth for the turn object's
  // shape — features/game/game.js, exp.js, net.js, history.js all build theirs here.
  function freshTurn() {
    return { dice: [], selected: [false, false, false, false, false],
             diceNew: [false, false, false, false, false], diceGen: [], throwsLeft: 0, rollNo: 0,
             awaitingRoll: false, locked: false, aiBusy: false, rerolledAll: false,
             manualCounts: [0, 0, 0, 0, 0, 0, 0], curLog: null };
  }

  // ОТЧЕТ (manual entry): expand the per-face tally into a flat sorted-by-face hand.
  function manualDiceFromCounts(counts) {
    var d = [];
    for (var f = 1; f <= 6; f++) for (var k = 0; k < counts[f]; k++) d.push(f);
    return d;
  }

  // --- pure helpers (never mutate inputs) ---
  function clone(turn) { var t = {}; for (var k in turn) if (turn.hasOwnProperty(k)) t[k] = turn[k]; return t; }
  function withTurn(state, turn) { return Object.assign({}, state, { turn: turn }); }
  var FALSE5 = [false, false, false, false, false];

  // The base per-turn reset shared by every BEGIN_TURN flavour: clears the
  // accent/generation/roll bookkeeping but leaves aiBusy + manualCounts alone
  // (mirrors the original beginTurn's common prologue).
  function resetCommon(turn) {
    var t = clone(turn);
    t.locked = false; t.rerolledAll = false;
    t.diceNew = FALSE5.slice(); t.diceGen = []; t.rollNo = 0;
    return t;
  }

  function reduce(state, action) {
    var turn = state.turn;
    switch (action.type) {

      // Reset the turn for the active player. `mode` picks the flavour:
      //   'dice'   — human/AI dice game: wait on a first throw (ROLLS-1 rerolls queued)
      //   'manual' — ОТЧЕТ point entry: zero the per-face tally, no throws
      //   'net'    — networked: only the active device may roll (action.myTurn)
      case 'BEGIN_TURN': {
        var t = resetCommon(turn);
        if (action.mode === 'manual') {
          t.manualCounts = [0, 0, 0, 0, 0, 0, 0];
          t.dice = []; t.throwsLeft = 0; t.curLog = null;
        } else if (action.mode === 'net') {
          t.selected = FALSE5.slice(); t.dice = []; t.curLog = null;
          if (action.myTurn) { t.awaitingRoll = true; t.locked = false; t.throwsLeft = ROLLS - 1; }
          else { t.awaitingRoll = false; t.locked = true; t.throwsLeft = 0; }
        } else { // 'dice' (default): local human or AI
          t.selected = FALSE5.slice();
          t.awaitingRoll = true; t.throwsLeft = ROLLS - 1; t.dice = []; t.curLog = null;
        }
        return withTurn(state, t);
      }

      // The turn's first throw. `action.dice` are the freshly-rolled faces (the
      // shell rolls them); every die is generation 1. No-op unless we're waiting.
      case 'FIRST_ROLL': {
        if (!turn.awaitingRoll || turn.locked) return state;
        var d = action.dice.slice().sort(function (a, b) { return a - b; });
        var t = clone(turn);
        t.awaitingRoll = false; t.dice = d; t.rollNo = 1;
        t.diceGen = d.map(function () { return 1; });
        return withTurn(state, t);
      }

      // Re-throw the masked dice. `action.mask[i]` true = die i is re-thrown to
      // `action.faces[i]` (kept dice ignore faces). When `action.batch`, stamp each
      // die with its generation and group kept|fresh; otherwise plain ascending sort.
      case 'REROLL': {
        var t = clone(turn);
        t.rollNo = turn.rollNo + 1;
        var gen = t.rollNo;
        var paired = turn.dice.map(function (v, i) {
          return { v: action.mask[i] ? action.faces[i] : v, nw: !!action.mask[i], g: action.mask[i] ? gen : (turn.diceGen[i] || 1) };
        });
        if (action.batch) paired.sort(function (a, b) { return (a.g - b.g) || (a.v - b.v); });
        else paired.sort(function (a, b) { return a.v - b.v; });
        t.dice = paired.map(function (x) { return x.v; });
        t.diceNew = paired.map(function (x) { return x.nw; });
        t.diceGen = paired.map(function (x) { return x.g; });
        return withTurn(state, t);
      }

      // ОТЧЕТ: count one more die of `action.face` into the hand. No-op once the
      // turn is locked or all 5 dice are in.
      case 'TAP_MANUAL': {
        if (turn.locked || turn.dice.length >= DICE_COUNT) return state;
        var counts = turn.manualCounts.slice();
        counts[action.face]++;
        var t = clone(turn);
        t.manualCounts = counts; t.dice = manualDiceFromCounts(counts);
        return withTurn(state, t);
      }

      // Lock the turn after a category is committed. Score assignment + logging
      // stay in the shell (ruleset-coupled; unified in slices 4/5).
      case 'COMMIT': {
        var t = clone(turn); t.locked = true;
        return withTurn(state, t);
      }

      // ОПА — rewind one logged action. A 'tap' un-counts one die; a 'commit'
      // restores the committing player's entered hand and rewinds the cursor
      // (the score delete + moveLog pop are the shell's, being score/log-coupled).
      case 'UNDO': {
        var a = action.entry, t = clone(turn);
        var cur = state.current, rnd = state.round;
        if (a.t === 'tap') {
          var counts = turn.manualCounts.slice();
          if (counts[a.face] > 0) counts[a.face]--;
          t.manualCounts = counts; t.dice = manualDiceFromCounts(counts);
        } else { // 'commit'
          cur = a.playerIdx; rnd = a.prevRound;
          t.manualCounts = a.counts.slice(); t.dice = manualDiceFromCounts(t.manualCounts);
        }
        t.locked = false;
        return Object.assign({}, state, { turn: t, current: cur, round: rnd });
      }

      // Advance the cursor to the next seat (wrapping bumps the round) — the pure
      // analogue of G.nextTurn.
      case 'NEXT_TURN': {
        var n = state.players.length;
        var cur = (state.current + 1) % n;
        var rnd = cur === 0 ? state.round + 1 : state.round;
        return Object.assign({}, state, { current: cur, round: rnd });
      }

      // The turn flow is over (the board is full). No state change here — the
      // end-game screen is pure UI — but kept in the vocabulary so callers route
      // the terminal transition through reduce too.
      case 'END_GAME':
        return state;

      default:
        return state;
    }
  }

  return { reduce: reduce, freshTurn: freshTurn, manualDiceFromCounts: manualDiceFromCounts, ROLLS: ROLLS, DICE_COUNT: DICE_COUNT };
});
