/*
 * Генерал — EV (expected-value) engine.
 *
 * Solves the game as an acyclic Markov Decision Process by backward induction.
 * 5 dice / 3 throws / hold-any-subset => the standard 252-multiset reroll table;
 * exactly one category is committed per turn (monotone), so the end-of-game state
 * is the bare 14-bit category mask (2^14 = 16384 states) — see the project spec,
 * Appendix A. No upper bonus / joker / columns in this ruleset.
 *
 * SINGLE SOURCE OF TRUTH: scoring comes from game.js (General.scoreFor /
 * General.CATEGORIES). This module never re-implements the rules.
 *
 * Powers: optimal-play hints, luck-vs-skill decomposition, and calibrated bots.
 * Pure and deterministic (RNG is injected) for reproducible analysis and tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./game.js'));
  } else {
    root.GeneralEV = factory(root.General);
  }
})(typeof self !== 'undefined' ? self : this, function (General) {
  'use strict';

  var DICE = General.DICE_COUNT;          // 5
  var CATS = General.CATEGORIES;          // 14 categories, index == bit position
  var NCAT = CATS.length;
  var FULL_MASK = (1 << NCAT) - 1;
  var scoreFor = General.scoreFor;

  // ---------------------------------------------------------------- multisets

  // All sorted 5-dice multisets (252 of them), indexed; plus counts and the
  // probability of rolling each on a fair throw of 5 dice.
  var MULTISETS = [];          // idx -> dice array (sorted, length 5)
  var IDX_BY_KEY = {};         // counts key -> idx
  var ROLL_PROB = [];          // idx -> P(this multiset on a fair 5-dice roll)

  function countsKey(counts) { return counts.join(','); }
  function fact(n) { var f = 1; for (var i = 2; i <= n; i++) f *= i; return f; }
  function permsOf(counts, n) {
    var d = 1; for (var f = 1; f <= 6; f++) d *= fact(counts[f]);
    return fact(n) / d;
  }

  // enumerate count-vectors (over faces 1..6) summing to n
  function enumCounts(n, cb) {
    var counts = [0, 0, 0, 0, 0, 0, 0];
    (function rec(face, left) {
      if (face === 6) { counts[6] = left; cb(counts.slice()); return; }
      for (var k = 0; k <= left; k++) { counts[face] = k; rec(face + 1, left - k); }
      counts[face] = 0;
    })(1, n);
  }
  function countsToDice(counts) {
    var d = []; for (var f = 1; f <= 6; f++) for (var k = 0; k < counts[f]; k++) d.push(f);
    return d;
  }

  enumCounts(DICE, function (counts) {
    var idx = MULTISETS.length;
    IDX_BY_KEY[countsKey(counts)] = idx;
    MULTISETS.push(countsToDice(counts));
    ROLL_PROB.push(permsOf(counts, DICE) / Math.pow(6, DICE));
  });
  var NMS = MULTISETS.length; // 252

  function idxOfDice(dice) {
    var counts = [0, 0, 0, 0, 0, 0, 0];
    for (var i = 0; i < dice.length; i++) counts[dice[i]]++;
    return IDX_BY_KEY[countsKey(counts)];
  }

  // ---------------------------------------------------------- reroll table

  // For re-rolling m dice (0..5): every resulting added count-vector + its prob.
  var ADDED = [];
  for (var m = 0; m <= DICE; m++) {
    var list = [];
    (function (mm) {
      enumCounts(mm, function (counts) {
        list.push({ counts: counts, prob: permsOf(counts, mm) / Math.pow(6, mm) });
      });
    })(m);
    ADDED.push(list);
  }

  // For each multiset, the distinct "keep" sub-multisets, each with the
  // resulting distribution over 5-dice multiset indices after re-rolling the
  // rest. KEEP_RESULT entries are shared/cached across multisets.
  var KEEP_CACHE = {};
  function keepResult(keptCounts) {
    var key = countsKey(keptCounts);
    if (KEEP_CACHE[key]) return KEEP_CACHE[key];
    var keptSum = 0; for (var f = 1; f <= 6; f++) keptSum += keptCounts[f];
    var added = ADDED[DICE - keptSum];
    var idxArr = new Int32Array(added.length), probArr = new Float64Array(added.length);
    for (var j = 0; j < added.length; j++) {
      var res = keptCounts.slice();
      for (var ff = 1; ff <= 6; ff++) res[ff] += added[j].counts[ff];
      idxArr[j] = IDX_BY_KEY[countsKey(res)];
      probArr[j] = added[j].prob;
    }
    var entry = { idx: idxArr, prob: probArr, keptCounts: keptCounts.slice() };
    KEEP_CACHE[key] = entry;
    return entry;
  }

  // KEEPS[idx] = array of keepResult entries (the distinct keep decisions).
  var KEEPS = [];
  for (var di = 0; di < NMS; di++) {
    var counts = [0, 0, 0, 0, 0, 0, 0];
    MULTISETS[di].forEach(function (v) { counts[v]++; });
    var keeps = [];
    (function rec(face, kept) {
      if (face === 7) { keeps.push(keepResult(kept)); return; }
      for (var k = 0; k <= counts[face]; k++) { kept[face] = k; rec(face + 1, kept); }
      kept[face] = 0;
    })(1, [0, 0, 0, 0, 0, 0, 0]);
    KEEPS.push(keeps);
  }

  function dot(entry, vec) {
    var s = 0, idx = entry.idx, prob = entry.prob, n = idx.length;
    for (var j = 0; j < n; j++) s += prob[j] * vec[idx[j]];
    return s;
  }

  // ---------------------------------------------------------- within-turn

  // valueAt0[d] = best (immediate score + V* of successor) over open categories.
  function stageZero(mask, vstar) {
    var out = new Float64Array(NMS);
    for (var d = 0; d < NMS; d++) {
      var dice = MULTISETS[d], best = -Infinity;
      for (var i = 0; i < NCAT; i++) {
        if (mask & (1 << i)) continue;
        var v = scoreFor(CATS[i].key, dice) + vstar(mask | (1 << i));
        if (v > best) best = v;
      }
      out[d] = best;
    }
    return out;
  }
  // value with r>0 rerolls left = max over keeps of E[next-stage value].
  function stageUp(prev) {
    var out = new Float64Array(NMS);
    for (var d = 0; d < NMS; d++) {
      var keeps = KEEPS[d], best = -Infinity;
      for (var k = 0; k < keeps.length; k++) { var e = dot(keeps[k], prev); if (e > best) best = e; }
      out[d] = best;
    }
    return out;
  }

  // All within-turn value arrays for a scorecard mask.
  function turnArrays(mask, vstar) {
    var v0 = stageZero(mask, vstar);
    var v1 = stageUp(v0);
    var v2 = stageUp(v1);
    return [v0, v1, v2]; // index by rolls-left
  }

  function expectRoll(vec) {
    var s = 0; for (var d = 0; d < NMS; d++) s += ROLL_PROB[d] * vec[d];
    return s;
  }

  // --------------------------------------------------- full V* by induction

  // Compute the end-of-game value table V*[mask]. Heavy (~8e9 mults); run offline
  // and ship the result. `onProgress(done,total)` is optional.
  function computeTable(onProgress) {
    var V = new Float64Array(1 << NCAT);
    var order = [];
    for (var mask = 0; mask < (1 << NCAT); mask++) order.push(mask);
    order.sort(function (a, b) { return popcount(b) - popcount(a); }); // terminal first
    var vstar = function (mIdx) { return V[mIdx]; };
    for (var i = 0; i < order.length; i++) {
      var mk = order[i];
      if (mk === FULL_MASK) { V[mk] = 0; continue; }
      var arr = turnArrays(mk, vstar);
      V[mk] = expectRoll(arr[2]);
      if (onProgress && (i & 1023) === 0) onProgress(i, order.length);
    }
    return V;
  }
  function popcount(x) { var c = 0; while (x) { x &= x - 1; c++; } return c; }

  // ------------------------------------------------------ loaded table + API

  var TABLE = null;     // Float64Array(16384) once loaded/computed
  var PAR = null;
  var turnCache = {};   // mask -> turnArrays (memoised for the session)

  function setTable(V) { TABLE = V; PAR = V[0]; turnCache = {}; }
  function hasTable() { return !!TABLE; }
  function par() { return PAR; }
  function vstar(mask) { return TABLE[mask]; }

  function arraysFor(mask) {
    if (turnCache[mask]) return turnCache[mask];
    var a = turnArrays(mask, vstar);
    turnCache[mask] = a;
    return a;
  }

  // mask from a player's filled-scores object
  function maskOfScores(scores) {
    var mask = 0;
    for (var i = 0; i < NCAT; i++) if (typeof scores[CATS[i].key] === 'number') mask |= (1 << i);
    return mask;
  }

  // Turn a kept count-vector into a boolean keep mask over the actual dice.
  function keepPositions(dice, keptCounts) {
    var need = keptCounts.slice(), keep = dice.map(function () { return false; });
    for (var i = 0; i < dice.length; i++) if (need[dice[i]] > 0) { keep[i] = true; need[dice[i]]--; }
    return keep;
  }

  // 0.6 query API — powers live hints and post-game analysis.
  function evaluate(scores, dice, rollsLeft) {
    return evaluateMask(maskOfScores(scores), dice, rollsLeft);
  }
  function evaluateMask(mask, dice, rollsLeft) {
    var arr = arraysFor(mask);
    var dIdx = idxOfDice(dice);
    var out = { state_value: 0, best_keep: null, keep_ranked: [], best_category: null, category_ranked: [] };

    // category ranking ("if you stop now")
    var cats = [];
    for (var i = 0; i < NCAT; i++) {
      if (mask & (1 << i)) continue;
      var imm = scoreFor(CATS[i].key, dice);
      cats.push({ key: CATS[i].key, immediate: imm, ev: imm + vstar(mask | (1 << i)) });
    }
    cats.sort(function (a, b) { return b.ev - a.ev; });
    out.category_ranked = cats;
    out.best_category = cats.length ? cats[0] : null;

    if (rollsLeft > 0) {
      var next = arr[rollsLeft - 1]; // expectation taken over the next stage
      var keeps = KEEPS[dIdx], ranked = [];
      for (var k = 0; k < keeps.length; k++) {
        ranked.push({ keep: keepPositions(dice, keeps[k].keptCounts), ev: dot(keeps[k], next) });
      }
      ranked.sort(function (a, b) { return b.ev - a.ev; });
      out.keep_ranked = ranked;
      out.best_keep = ranked[0].keep;
      out.state_value = ranked[0].ev;          // = arr[rollsLeft][dIdx]
    } else {
      out.state_value = out.best_category ? out.best_category.ev : 0;
    }
    return out;
  }

  // The open category a keep is steering toward = the one with the highest
  // expected immediate score after re-rolling the non-kept dice. Chance is a
  // dumping ground, not a "target", so it's only chosen if nothing else is open.
  function bestTarget(scores, dice, keep) {
    var counts = [0, 0, 0, 0, 0, 0, 0];
    for (var i = 0; i < dice.length; i++) if (keep[i]) counts[dice[i]]++;
    var entry = keepResult(counts);
    var mask = maskOfScores(scores), best = null, bestE = -1;
    for (var c = 0; c < NCAT; c++) {
      if (mask & (1 << c)) continue;
      if (CATS[c].key === 'chance') continue;
      var e = 0;
      for (var j = 0; j < entry.idx.length; j++) e += entry.prob[j] * scoreFor(CATS[c].key, MULTISETS[entry.idx[j]]);
      if (e > bestE) { bestE = e; best = CATS[c].key; }
    }
    return best === null ? 'chance' : best;
  }

  // value of a within-turn node (realised dice, rolls-left), excluding banked score
  function nodeValue(mask, dice, rollsLeft) {
    return arraysFor(mask)[rollsLeft][idxOfDice(dice)];
  }
  // EV a chosen keep locks in (expectation over the coming reroll)
  function keepValue(mask, dice, rollsLeft, keepBools) {
    var counts = [0, 0, 0, 0, 0, 0, 0];
    for (var i = 0; i < dice.length; i++) if (keepBools[i]) counts[dice[i]]++;
    var entry = keepResult(counts);
    return dot(entry, arraysFor(mask)[rollsLeft - 1]);
  }

  // ============================================================ §2 luck/skill

  function catBit(key) {
    for (var i = 0; i < NCAT; i++) if (CATS[i].key === key) return 1 << i;
    return 0;
  }

  // Decompose one realised turn into luck (roll) and skill (decision) deltas.
  // rolls = dice arrays after each throw (length R, 1..3); keeps = keep bool[5]
  // for each reroll taken (length R-1); category = key committed.
  function analyzeTurn(mask, rolls, keeps, category) {
    var luck = 0, skill = 0, decisions = [];
    var R = rolls.length;
    // first roll: chance delta vs the about-to-roll value V*(mask)
    luck += nodeValue(mask, rolls[0], 2) - vstar(mask);
    for (var i = 0; i < keeps.length; i++) {
      var rl = 2 - i;
      var node = nodeValue(mask, rolls[i], rl);
      var chosenEV = keepValue(mask, rolls[i], rl, keeps[i]);
      var e = evaluateMask(mask, rolls[i], rl);
      var second = e.keep_ranked.length > 1 ? e.keep_ranked[1].ev : node;
      skill += chosenEV - node;
      decisions.push({ type: 'keep', cost: chosenEV - node, chosenEV: chosenEV, optimalEV: node, margin: node - second, optimal: e.best_keep });
      luck += nodeValue(mask, rolls[i + 1], rl - 1) - chosenEV; // reroll chance delta
    }
    // category decision at the dice the player stopped on
    var rlStop = 2 - (R - 1);
    var last = rolls[R - 1];
    var eStop = evaluateMask(mask, last, rlStop);
    var nodeVal = eStop.state_value;
    var chosen = eStop.category_ranked.filter(function (c) { return c.key === category; })[0];
    var secondCat = eStop.category_ranked.length > 1 ? eStop.category_ranked[1].ev : eStop.category_ranked[0].ev;
    skill += chosen.ev - nodeVal;
    decisions.push({ type: 'category', cost: chosen.ev - nodeVal, chosenEV: chosen.ev, optimalEV: nodeVal,
                     margin: eStop.category_ranked[0].ev - secondCat, chosenKey: category, optimalKey: eStop.category_ranked[0].key });
    return { luck: luck, skill: skill, decisions: decisions };
  }

  // Aggregate a whole game's turns (in play order) into the §2 identity:
  // final_score = par + Σ luck + Σ skill.
  function analyzeGame(turns) {
    var luck = 0, skill = 0, decisions = [];
    turns.forEach(function (t) {
      var a = analyzeTurn(t.mask, t.rolls, t.keeps, t.category);
      luck += a.luck; skill += a.skill;
      a.decisions.forEach(function (d) { d.turnCategory = t.category; decisions.push(d); });
    });
    var EPS = 0.05;
    var optimalCount = decisions.filter(function (d) { return d.cost > -EPS; }).length;
    var blunder = null, sharpest = null;
    decisions.forEach(function (d) {
      if (!blunder || d.cost < blunder.cost) blunder = d;
      // sharpest = an optimal (cost≈0) decision that mattered most (largest margin)
      if (d.cost > -EPS && (!sharpest || d.margin > sharpest.margin)) sharpest = d;
    });
    return {
      par: PAR, luck: luck, skill: skill, projectedFinal: PAR + luck + skill,
      decisions: decisions, nDecisions: decisions.length,
      accuracy: decisions.length ? optimalCount / decisions.length : 1,
      avgLostPerDecision: decisions.length ? -skill / decisions.length : 0,
      blunder: blunder, sharpest: sharpest,
    };
  }

  // ============================================================ §3 bot policy

  // ceiling score per category — used by the risk-seeking persona
  var CEIL = { ones: 5, twos: 10, threes: 15, fours: 20, fives: 25, sixes: 30,
    twoKind: 12, threeKind: 18, fourKind: 24, fullHouse: 30, smallStraight: 15, largeStraight: 20, general: 80, chance: 30 };

  function softmaxPick(actions, getEv, tau, rng) {
    if (tau <= 0) {
      var best = actions[0]; for (var i = 1; i < actions.length; i++) if (getEv(actions[i]) > getEv(best)) best = actions[i]; return best;
    }
    var max = -Infinity; for (var i = 0; i < actions.length; i++) max = Math.max(max, getEv(actions[i]));
    var ws = [], sum = 0;
    for (var i = 0; i < actions.length; i++) { var w = Math.exp((getEv(actions[i]) - max) / tau); ws.push(w); sum += w; }
    var r = (rng || Math.random)() * sum, acc = 0;
    for (var i = 0; i < actions.length; i++) { acc += ws[i]; if (r <= acc) return actions[i]; }
    return actions[actions.length - 1];
  }

  // policy: { type:'optimal'|'softmax'|'risk', tau, lambda }
  // Non-optimal personas play WEAK DICE but still bank points: they only scratch
  // a category for 0 when nothing scores (no random/repeated forfeits). The
  // weakness lives in their keeps and in suboptimal-but-positive placement.
  function botCategory(scores, dice, policy, rng) {
    var ranked = evaluate(scores, dice, 0).category_ranked;
    if (policy.type === 'optimal') return ranked[0].key; // may strategically scratch
    var positive = ranked.filter(function (r) { return r.immediate > 0; });
    var pool = positive.length ? positive : ranked; // forfeit only when forced
    if (policy.type === 'risk') {
      var lambda = policy.lambda == null ? 1.4 : policy.lambda;
      return softmaxPick(pool, function (a) { return a.ev + lambda * (CEIL[a.key] || 0); }, policy.tau || 2, rng).key;
    }
    return softmaxPick(pool, function (a) { return a.ev; }, policy.tau, rng).key;
  }
  function botKeep(scores, dice, rollsLeft, policy, rng) {
    var ranked = evaluate(scores, dice, rollsLeft).keep_ranked;
    if (policy.type === 'risk') {
      // bias toward holding the biggest matching group (chase General / straights)
      var lambda = policy.lambda == null ? 1.4 : policy.lambda;
      var pick = softmaxPick(ranked, function (a) {
        var c = [0, 0, 0, 0, 0, 0, 0], mx = 0;
        for (var i = 0; i < dice.length; i++) if (a.keep[i]) { c[dice[i]]++; if (c[dice[i]] > mx) mx = c[dice[i]]; }
        return a.ev + lambda * mx;
      }, policy.tau || 2, rng);
      return pick.keep;
    }
    return softmaxPick(ranked, function (a) { return a.ev; }, policy.type === 'optimal' ? 0 : policy.tau, rng).keep;
  }

  return {
    CATS: CATS, NCAT: NCAT, NMS: NMS, FULL_MASK: FULL_MASK,
    MULTISETS: MULTISETS, ROLL_PROB: ROLL_PROB, idxOfDice: idxOfDice,
    KEEPS: KEEPS, keepResult: keepResult, dot: dot,
    turnArrays: turnArrays, expectRoll: expectRoll, computeTable: computeTable, popcount: popcount,
    setTable: setTable, hasTable: hasTable, par: par, vstar: vstar,
    maskOfScores: maskOfScores, evaluate: evaluate, evaluateMask: evaluateMask, catBit: catBit,
    nodeValue: nodeValue, keepValue: keepValue, keepPositions: keepPositions,
    analyzeTurn: analyzeTurn, analyzeGame: analyzeGame, bestTarget: bestTarget,
    softmaxPick: softmaxPick, botCategory: botCategory, botKeep: botKeep,
  };
});
