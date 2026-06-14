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
    module.exports.create = factory;          // build a second engine for another ruleset (e.g. experimental)
  } else {
    root.GeneralEV = factory(root.General);
    root.GeneralEV.create = factory;
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
    // first roll: chance delta vs the about-to-roll value V*(mask) — the "net
    // dice variance" of the throw (how far the dice landed from expectation)
    var firstLuck = nodeValue(mask, rolls[0], 2) - vstar(mask);
    luck += firstLuck;
    for (var i = 0; i < keeps.length; i++) {
      var rl = 2 - i;
      var node = nodeValue(mask, rolls[i], rl);
      var chosenEV = keepValue(mask, rolls[i], rl, keeps[i]);
      var e = evaluateMask(mask, rolls[i], rl);
      var second = e.keep_ranked.length > 1 ? e.keep_ranked[1].ev : node;
      skill += chosenEV - node;
      decisions.push({ type: 'keep', cost: chosenEV - node, chosenEV: chosenEV, optimalEV: node, margin: node - second,
                       chosen: keeps[i], optimal: e.best_keep });
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
    // was a zero mathematically forced (nothing scores), or self-inflicted?
    var anyPositive = eStop.category_ranked.some(function (c) { return c.immediate > 0; });
    return { luck: luck, skill: skill, decisions: decisions,
             firstLuck: firstLuck, rerollLuck: luck - firstLuck,
             score: chosen.immediate, forcedZero: !anyPositive, finalDice: last };
  }

  var EPS = 0.05;                                  // "optimal" tolerance (points)
  var SEV = { major: 3, fatal: 8 };                // blunder severity thresholds

  function severityOf(cost) { var c = -cost; return c >= SEV.fatal ? 'fatal' : c >= SEV.major ? 'major' : 'minor'; }
  function stageOf(ti) { return ti < 5 ? 'early' : ti < 10 ? 'mid' : 'late'; }
  function avg(arr) { if (!arr.length) return 0; var s = 0; arr.forEach(function (x) { s += x; }); return s / arr.length; }

  // Aggregates shared by the full and the manual analysis.
  function aggregate(decisions, turnDetails) {
    var optimalCount = decisions.filter(function (d) { return d.cost > -EPS; }).length;
    var blunder = null, sharpest = null;
    decisions.forEach(function (d) {
      if (!blunder || d.cost < blunder.cost) blunder = d;
      // sharpest = an optimal (cost≈0) decision that mattered most (largest margin)
      if (d.cost > -EPS && (!sharpest || d.margin > sharpest.margin)) sharpest = d;
    });
    // blunder categorisation: counts by severity + by decision type
    var sev = { minor: 0, major: 0, fatal: 0 }, mistakes = { keep: 0, category: 0 };
    var costs = { keep: 0, category: 0 }, counts = { keep: 0, category: 0 };
    decisions.forEach(function (d) {
      counts[d.type]++; costs[d.type] += d.cost;
      if (d.cost < -EPS) { sev[severityOf(d.cost)]++; mistakes[d.type]++; }
    });
    // outstanding moves: the optimal calls with the biggest margins
    var topMoves = decisions.filter(function (d) { return d.cost > -EPS && d.margin > 0.5; })
      .sort(function (a, b) { return b.margin - a.margin; }).slice(0, 3);
    // game-section ratings: avg EV loss per turn by stage (late game is tightest)
    var stages = { early: { skill: 0, luck: 0, n: 0 }, mid: { skill: 0, luck: 0, n: 0 }, late: { skill: 0, luck: 0, n: 0 } };
    turnDetails.forEach(function (td) {
      var s = stages[stageOf(td.turn)];
      s.skill += td.skill; s.luck += (td.luck || 0); s.n++;
    });
    // zero-out avoidance: forced (nothing scored) vs self-inflicted
    var zeroOuts = { total: 0, forced: 0, unforced: 0 };
    turnDetails.forEach(function (td) {
      if (td.score === 0) { zeroOuts.total++; td.forcedZero ? zeroOuts.forced++ : zeroOuts.unforced++; }
    });
    // §0.1 the per-category cube cell: each turn fills exactly one category, so this
    // is just turnDetails re-keyed by category — the atom every per-category view reduces.
    // score = points placed, leak = EV left on the table (≥0), optimal = was it the best fill.
    var byCategory = {};
    turnDetails.forEach(function (td) {
      byCategory[td.category] = {
        category: td.category, score: td.score, leak: -td.skill,
        luck: (typeof td.luck === 'number' ? td.luck : null), optimal: td.skill > -EPS,
      };
    });
    return {
      decisions: decisions, nDecisions: decisions.length, turns: turnDetails,
      accuracy: decisions.length ? optimalCount / decisions.length : 1,
      blunder: blunder, sharpest: sharpest, topMoves: topMoves,
      severity: sev, mistakes: mistakes, leak: costs, leakCounts: counts,
      stages: stages, zeroOuts: zeroOuts, byCategory: byCategory,
    };
  }

  // Aggregate a whole game's turns (in play order) into the §2 identity:
  // final_score = par + Σ luck + Σ skill — plus the deep-dive metrics.
  function analyzeGame(turns) {
    var luck = 0, skill = 0, decisions = [], turnDetails = [];
    turns.forEach(function (t, ti) {
      var a = analyzeTurn(t.mask, t.rolls, t.keeps, t.category);
      luck += a.luck; skill += a.skill;
      a.decisions.forEach(function (d) { d.turnCategory = t.category; d.turn = ti; decisions.push(d); });
      turnDetails.push({ turn: ti, category: t.category, score: a.score, luck: a.luck, skill: a.skill,
                         firstLuck: a.firstLuck, rerollLuck: a.rerollLuck, forcedZero: a.forcedZero,
                         finalDice: a.finalDice, nRolls: t.rolls.length, decisions: a.decisions });
    });
    var out = aggregate(decisions, turnDetails);
    out.par = PAR; out.luck = luck; out.skill = skill; out.projectedFinal = PAR + luck + skill;
    out.avgLostPerDecision = decisions.length ? -skill / decisions.length : 0;
    out.avgLostPerTurn = turns.length ? -skill / turns.length : 0;

    // deep luck deconstruction: net dice variance split first-throw vs rerolls,
    // and the clutch factor — late-game luck weighs differently (fewer outs)
    out.luckFirst = avg(turnDetails.map(function (td) { return td.firstLuck; })) * turnDetails.length;
    out.luckRerolls = out.luck - out.luckFirst;
    out.clutch = out.stages.late.luck;

    // tilt: does EV loss spike on the turn after a terrible roll?
    var afterBad = [], baselineT = [];
    turnDetails.forEach(function (td, i) {
      (i > 0 && turnDetails[i - 1].luck < -6 ? afterBad : baselineT).push(-td.skill);
    });
    out.tilt = afterBad.length ? { n: afterBad.length, afterBad: avg(afterBad), baseline: avg(baselineT), delta: avg(afterBad) - avg(baselineT) } : null;

    // bailout rating: decision quality in turns whose FIRST throw broke the plan
    // (−2.5 ≈ the worst ~20% of opening throws; the spread is tight because two
    // rerolls still remain, so most bad starts are partially recoverable)
    var badStart = turnDetails.filter(function (td) { return td.firstLuck < -2.5; });
    out.bailout = badStart.length
      ? { n: badStart.length, avgCost: avg(badStart.map(function (td) { return -td.skill; })), baseline: out.avgLostPerTurn }
      : null;

    // aggression: extra dice rerolled vs the optimal keep (chasing > 0 > settling)
    var keepDeltas = decisions.filter(function (d) { return d.type === 'keep'; }).map(function (d) {
      var cr = 0, or = 0;
      for (var i = 0; i < d.chosen.length; i++) { if (!d.chosen[i]) cr++; if (!d.optimal[i]) or++; }
      return cr - or;
    });
    out.aggression = avg(keepDeltas);
    return out;
  }

  // Manual-mode analysis: only the FINAL dice and the category pick are known
  // (the table rolled real dice we never saw), so only the category decision is
  // judged — against the same optimal table at rolls_left = 0. No luck terms.
  function analyzeManualGame(turns) {
    var decisions = [], turnDetails = [], skill = 0;
    turns.forEach(function (t, ti) {
      var e = evaluateMask(t.mask, t.dice, 0);
      var chosen = e.category_ranked.filter(function (c) { return c.key === t.category; })[0];
      var secondCat = e.category_ranked.length > 1 ? e.category_ranked[1].ev : e.category_ranked[0].ev;
      var cost = chosen.ev - e.category_ranked[0].ev;
      skill += cost;
      decisions.push({ type: 'category', turn: ti, cost: cost, chosenEV: chosen.ev, optimalEV: e.category_ranked[0].ev,
                       margin: e.category_ranked[0].ev - secondCat, chosenKey: t.category, optimalKey: e.category_ranked[0].key,
                       turnCategory: t.category });
      var anyPositive = e.category_ranked.some(function (c) { return c.immediate > 0; });
      turnDetails.push({ turn: ti, category: t.category, score: chosen.immediate, skill: cost,
                         forcedZero: !anyPositive, finalDice: t.dice, decisions: [decisions[decisions.length - 1]] });
    });
    var out = aggregate(decisions, turnDetails);
    out.manual = true;
    out.skill = skill;
    out.avgLostPerDecision = decisions.length ? -skill / decisions.length : 0;
    out.avgLostPerTurn = turns.length ? -skill / turns.length : 0;
    return out;
  }

  // §0.2 margin decomposition: M = points(A) − points(B) = ΔLuck + ΔSkill (par is
  // constant and cancels). Returns integer parts that SUM EXACTLY to the visible
  // point margin (the rounding remainder is absorbed into the larger-magnitude
  // term), or { luck: null } when luck is unknown (either side a manual game).
  function marginSplit(anaA, anaB, pointsMargin) {
    if (!anaA || !anaB) return null;
    var M = Math.round(pointsMargin);
    var dSkill = (anaA.skill || 0) - (anaB.skill || 0);
    var luckKnown = !anaA.manual && !anaB.manual && typeof anaA.luck === 'number' && typeof anaB.luck === 'number';
    if (!luckKnown) return { luck: null, skill: M, margin: M };
    var rl = Math.round(anaA.luck - anaB.luck), rs = Math.round(dSkill), rem = M - rl - rs;
    if (Math.abs(dSkill) >= Math.abs(anaA.luck - anaB.luck)) rs += rem; else rl += rem;
    return { luck: rl, skill: rs, margin: M };
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

  // policy: { type:'optimal'|'softmax'|'epsilon'|'greedy'|'random'|'risk', tau, epsilon, lambda }
  // The persona ladder: GOD = optimal table lookup; HARD = softmax over the
  // table; MEDIUM = epsilon-greedy over the table; EASY = no lookup at all,
  // pure immediate-gain heuristics; RANDOM = blind rethrows (1–2), then the
  // best immediate placement. Non-optimal personas only scratch a category
  // for 0 when nothing scores (no random/repeated forfeits). 'risk' is the
  // legacy gambler policy, kept for experiments/calibration.
  function botCategory(scores, dice, policy, rng) {
    // EASY/RANDOM: no table lookup — best immediate score via the game's own
    // greedy heuristic (sacrifices in its fixed order only when forced).
    if (policy.type === 'greedy' || policy.type === 'random') {
      return General.aiChooseCategory({ scores: scores }, dice).category;
    }
    var ranked = evaluate(scores, dice, 0).category_ranked;
    if (policy.type === 'optimal') return ranked[0].key; // may strategically scratch
    var positive = ranked.filter(function (r) { return r.immediate > 0; });
    var pool = positive.length ? positive : ranked; // forfeit only when forced
    if (policy.type === 'epsilon') {
      var eps = policy.epsilon == null ? 0.25 : policy.epsilon;
      if ((rng || Math.random)() < eps) return pool[Math.floor((rng || Math.random)() * pool.length)].key;
      return pool[0].key;
    }
    if (policy.type === 'risk') {
      var lambda = policy.lambda == null ? 1.4 : policy.lambda;
      return softmaxPick(pool, function (a) { return a.ev + lambda * (CEIL[a.key] || 0); }, policy.tau || 2, rng).key;
    }
    return softmaxPick(pool, function (a) { return a.ev; }, policy.tau, rng).key;
  }
  function botKeep(scores, dice, rollsLeft, policy, rng) {
    rng = rng || Math.random;
    // EASY: greedy heuristic holds (largest matching group / high dice).
    if (policy.type === 'greedy') return General.aiChooseHolds(dice);
    // RANDOM: always rethrows the whole hand once, then a second time half the
    // time — i.e. 1–2 blind rethrows, no keep intelligence at all.
    if (policy.type === 'random') {
      var all = rollsLeft === 2 ? false : rng() < 0.5;
      return dice.map(function () { return all; }); // all-true = stop, all-false = rethrow everything
    }
    var ranked = evaluate(scores, dice, rollsLeft).keep_ranked;
    if (policy.type === 'epsilon') {
      var eps = policy.epsilon == null ? 0.25 : policy.epsilon;
      if (rng() < eps) return ranked[Math.floor(rng() * ranked.length)].keep;
      return ranked[0].keep;
    }
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

  // §3.1 takeover policy — pick a bot strength that MATCHES a (dropped) player's
  // play so far. `acc` is their optimal-decision fraction in the game up to now
  // (1 = flawless). Stronger play → a sharper policy; weaker → noisier/greedier.
  // No "difficulty" knob: the level is read off the human's own track record.
  function botPolicyForAccuracy(acc) {
    if (acc == null || !isFinite(acc)) return { type: 'softmax', tau: 0.7 };  // unknown → solid club player
    if (acc >= 0.93) return { type: 'optimal' };
    if (acc >= 0.82) return { type: 'softmax', tau: 0.5 };
    if (acc >= 0.70) return { type: 'softmax', tau: 1.1 };
    if (acc >= 0.55) return { type: 'epsilon', epsilon: 0.28 };
    if (acc >= 0.40) return { type: 'epsilon', epsilon: 0.45 };
    return { type: 'greedy' };
  }

  return {
    CATS: CATS, NCAT: NCAT, NMS: NMS, FULL_MASK: FULL_MASK,
    MULTISETS: MULTISETS, ROLL_PROB: ROLL_PROB, idxOfDice: idxOfDice,
    KEEPS: KEEPS, keepResult: keepResult, dot: dot,
    turnArrays: turnArrays, expectRoll: expectRoll, computeTable: computeTable, popcount: popcount,
    setTable: setTable, hasTable: hasTable, par: par, vstar: vstar,
    maskOfScores: maskOfScores, evaluate: evaluate, evaluateMask: evaluateMask, catBit: catBit,
    nodeValue: nodeValue, keepValue: keepValue, keepPositions: keepPositions,
    analyzeTurn: analyzeTurn, analyzeGame: analyzeGame, analyzeManualGame: analyzeManualGame, marginSplit: marginSplit, bestTarget: bestTarget,
    softmaxPick: softmaxPick, botCategory: botCategory, botKeep: botKeep, botPolicyForAccuracy: botPolicyForAccuracy,
  };
});
