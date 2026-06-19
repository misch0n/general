'use strict';
// Experimental ruleset (single-column Генерал): exact evaluator, hints, rendering.
  // ============================================================ EXPERIMENTAL flow (single column)
  var expMode = false;
  var EXP_CELLS = X ? X.KEYS.length : 15;
  function expStartGame(players, manual) {
    expMode = true; netMode = false; manualMode = !!manual;
    trackGame('start');
    clearAllPenalties();
    game = X.createGame(players);
    game.ownerSkipped = skipOwnerNext; skipOwnerNext = false;
    undoStack = []; moveLog = players.map(function () { return []; });
    $('setup').classList.add('hidden'); $('game').classList.remove('hidden'); $('overModal').classList.add('hidden');
    paintCamo($('game'));
    $('hintBtn').classList.toggle('hidden', !exactReady || manualMode || !settings.advice);
    document.querySelector('.sheet').classList.remove('hidden');   // reuse the standard tile board
    $('expBoard').classList.add('hidden');
    $('expReserve').classList.add('hidden');
    setDockUI(manualMode);
    expBeginTurn();
  }
  function resumeExpGame(snap) {
    expMode = true; netMode = false; manualMode = false;
    var players = snap.players.map(function (sp) {
      var pl = G.createPlayer(sp.name, sp.color, sp.isAI);
      pl.gender = sp.gender || 'm'; pl.owner = !!sp.owner; pl.ribbons = sp.ribbons || RIBBON_COLORS; pl.scores = sp.scores || {};
      if (!sp.isAI) { pl.selectKeep = (typeof sp.selectKeep === 'boolean') ? sp.selectKeep : !!settings.selectKeep; pl.diceBatch = (typeof sp.diceBatch === 'boolean') ? sp.diceBatch : !!settings.newDiceBatch; }
      if (sp.isAI && sp.personaId) pl.persona = G.personaById(sp.personaId);
      return pl;
    });
    game = X.createGame(players);
    game.current = snap.current || 0; game.round = snap.round || 1; game.ownerSkipped = !!snap.ownerSkipped;
    undoStack = []; viewingHistory = false; moveLog = snap.moveLog || players.map(function () { return []; });
    $('setup').classList.add('hidden'); $('game').classList.remove('hidden'); $('overModal').classList.add('hidden');
    paintCamo($('game'));
    $('hintBtn').classList.toggle('hidden', !exactReady || !settings.advice);
    document.querySelector('.sheet').classList.remove('hidden'); $('expBoard').classList.add('hidden'); $('expReserve').classList.add('hidden');
    setDockUI(false);
    expBeginTurn();
  }
  function expBeginTurn() {
    locked = false; rerolledAll = false; diceNew = [false, false, false, false, false]; diceGen = []; rollNo = 0;
    hintsOn = false; $('hintBtn').classList.remove('on'); $('hintBtn').classList.toggle('hidden', !exactReady || !settings.advice);  // hints need the exact table AND the advice toggle
    clearRoast();
    var p = G.currentPlayer(game);
    if (!netMode) saveResume();
    document.documentElement.style.setProperty('--pc', p.color);
    selected = [false, false, false, false, false];
    if (manualMode) {                          // ОТЧЕТ: tap the five dice in, then pick a row
      manualCounts = [0, 0, 0, 0, 0, 0, 0]; awaitingRoll = false; throwsLeft = 0; dice = []; curLog = null;
      expRenderAll();
    } else if (p.isAI) {
      awaitingRoll = false; throwsLeft = ROLLS - 1;
      dice = G.rollAll(); sortDice();
      rollNo = 1; diceGen = dice.map(function () { return 1; });
      curLog = expStartLog(p);
      expRenderAll(); shakeDice();
      expRunAiTurn();
    } else {
      awaitingRoll = true; throwsLeft = ROLLS - 1; dice = []; curLog = null;
      expRenderAll();
    }
  }
  // per-turn move log for skill/luck analysis (mask + upper-subtotal at turn start)
  function expStartLog(p) { return exactReady ? { mask: EVX.maskOfScores(p.scores), up: G.upperStateExp(p.scores).subtotal, rolls: [dice.slice()], keeps: [] } : null; }
  function expLogReroll(rr) { if (curLog) { curLog.keeps.push(rr.map(function (x) { return !x; })); curLog.rolls.push(dice.slice()); } }
  function expFirstRoll() {
    if (!awaitingRoll || locked) return;
    if (tut && !tutGate('roll')) return;
    awaitingRoll = false; dice = (tut && tut.dice) ? tut.dice.slice() : G.rollAll(); sortDice();
    rollNo = 1; diceGen = dice.map(function () { return 1; });
    curLog = expStartLog(G.currentPlayer(game));
    clearRoast(); expRenderAll(); shakeDice();
    if (tut) tutEvent('roll');
  }
  function expHumanFire() {
    if (awaitingRoll) { expFirstRoll(); return; }   // first throw via the ХВЪРЛИ! button
    if (aiBusy || locked || throwsLeft <= 0) return;
    if (tut) { tutReroll(); return; }               // tutorial: scripted reroll
    var rr = rerollMask();
    if (!rr.some(Boolean)) return;
    if (rr.every(Boolean)) rerolledAll = true;
    applyReroll(rr);
    expLogReroll(rr);
    selected = [false, false, false, false, false];
    throwsLeft--;
    expRenderAll(); shakeDice();
  }
  function expCommit(key, value) {
    var p = G.currentPlayer(game);
    if (aiBusy || locked || p.isAI || awaitingRoll || dice.length !== G.DICE_COUNT) return;
    if (!X.canPlay(p, key)) return;
    if (tut && !tutCommitOk(key)) { tutNudge(); return; }
    if (manualMode && !netMode) {
      // local ОПА can rewind this
      undoStack.push({ t: 'commit', playerIdx: game.current, key: key, prevRound: game.round, counts: manualCounts.slice() });
    }
    // build the turn-log entry BEFORE assigning the score (mask = filled categories before this pick),
    // and record it locally for net games too (it used to be skipped) so history is complete here as well
    var expEnt = null;
    if (manualMode) { if (exactReady) expEnt = { mask: EVX.maskOfScores(p.scores), up: G.upperStateExp(p.scores).subtotal, dice: dice.slice(), category: key, manual: true }; }
    else if (curLog) { curLog.category = key; expEnt = curLog; curLog = null; }
    if (expEnt) moveLog[game.current].push(expEnt);
    X.assignScore(p, key, dice, value);          // value omitted → the row's score for the dice
    var committed = p.scores[key];
    // ---- net minus (manual / отчет): free-for-all — broadcast my entry, then reset for my next category ----
    if (netMode && manualMode) {
      flashTile(key);
      if (net) net.submitMove({ category: catIndexOf(key), score: committed, rolls: [dice.slice()], keeps: [], log: expEnt ? JSON.stringify(expEnt) : '' });
      locked = true; renderAll();
      setTimeout(beginManualEntry, END_DELAY);
      return;
    }
    // ---- net minus (regular): broadcast my completed turn; the host's STATE + next GRANT drive the rest ----
    if (netMode && !manualMode) {
      if (tut) tutEvent('commit');
      var log = expEnt;
      locked = true; renderAll(); flashTile(key); $('fire').disabled = true;
      netSendAct({ commit: true, category: catIndexOf(key), value: committed });   // spectators see the category go in
      var mv = { category: catIndexOf(key), score: committed, rolls: log ? log.rolls : [dice.slice()], keeps: log ? log.keeps : [], log: log ? JSON.stringify(log) : '' };
      if (netAiActiveId != null) { var aid = netAiActiveId; netAiActiveId = null; setTimeout(function () { if (net) net.submitMoveFor(aid, mv); }, NET_HANDOVER_DELAY); }
      else { netSay('🔊 Изпращам хода…'); setTimeout(function () { if (net) net.submitMove(mv); }, NET_HANDOVER_DELAY); }
      return;
    }
    if (tut) tutEvent('commit');
    locked = true; expRenderAll(); $('fire').disabled = true;
    // floor-flop shame for a forfeited combo (number rows use signed deviations — no roast there)
    var delay = END_DELAY;
    if (!manualMode && G.UPPER_KEYS.indexOf(key) < 0 && G.isFloorFlop(key, committed) && showRoast(key, committed)) delay = ROAST_MS + 250;
    turnTimer = setTimeout(expEndTurn, delay);
  }
  function expEndTurn() {
    if (X.isGameOver(game)) { expEndGame(); return; }
    X.nextTurn(game);
    if (tut) { while (game.players[game.current].isAI) X.nextTurn(game); }   // tutorial: the opponent never plays
    expBeginTurn();
  }
  function expRunAiTurn() { aiBusy = true; expRenderFire(); setTimeout(expAiStep, AI_DELAY); }

  // ----- EXACT penalty-aware evaluator (reuses the engine reroll DP, threading the upper subtotal) -----
  function expStageUp(prev) {
    var out = new Float64Array(EVX.NMS);
    for (var d = 0; d < EVX.NMS; d++) { var ks = EVX.KEEPS[d], b = -Infinity; for (var k = 0; k < ks.length; k++) { var e = EVX.dot(ks[k], prev); if (e > b) b = e; } out[d] = b; }
    return out;
  }
  function expCellValue(mask, up, i, dice) {
    var key = EVX.CATS[i].key, imm = G.scoreForExp(key, dice), isUp = G.UPPER_KEYS.indexOf(key) >= 0;
    var child = mask | (1 << i), childUp = up + (isUp ? imm : 0), cont;
    if (expUpperComplete(child)) cont = EVX.vstar(child) + (childUp < 0 ? G.UPPER_PENALTY : 0);
    else cont = vstarExp(child, childUp);
    return imm + cont;
  }
  function expV0M(mask, up) {
    var v0 = new Float64Array(EVX.NMS);
    for (var d = 0; d < EVX.NMS; d++) {
      var dice = EVX.MULTISETS[d], best = -Infinity;
      for (var i = 0; i < EVX.NCAT; i++) { if (mask & (1 << i)) continue; var v = expCellValue(mask, up, i, dice); if (v > best) best = v; }
      v0[d] = best;
    }
    return v0;
  }
  function expV0(scores) { return expV0M(EVX.maskOfScores(scores), G.upperStateExp(scores).subtotal); }
  function expExpectRoll(vec) { var s = 0; for (var d = 0; d < EVX.NMS; d++) s += EVX.ROLL_PROB[d] * vec[d]; return s; }

  // ----- full per-game analysis (mirrors EV.analyzeTurn/analyzeGame, threading the upper subtotal,
  //       so experimental games yield the SAME shape the standard summary/dossier consume) -----
  var EXP_EPS = 0.05, EXP_SEV = { major: 3, fatal: 8 };
  function expSeverityOf(cost) { var c = -cost; return c >= EXP_SEV.fatal ? 'fatal' : c >= EXP_SEV.major ? 'major' : 'minor'; }
  function expStageOf(ti) { return ti < 5 ? 'early' : ti < 10 ? 'mid' : 'late'; }
  function expAvg(a) { if (!a.length) return 0; var s = 0; a.forEach(function (x) { s += x; }); return s / a.length; }
  function analyzeTurnExp(t) {
    var mask = t.mask, up = t.up, rolls = t.rolls, keeps = t.keeps || [], R = rolls.length;
    var v0 = expV0M(mask, up), v1 = expStageUp(v0), v2 = expStageUp(v1), arr = [v0, v1, v2];
    var stateVal = expExpectRoll(v2);
    function nodeVal(dice, r) { return arr[r][EVX.idxOfDice(dice)]; }
    function keepVal(dice, r, kb) { var c = [0, 0, 0, 0, 0, 0, 0]; for (var i = 0; i < dice.length; i++) if (kb[i]) c[dice[i]]++; return EVX.dot(EVX.keepResult(c), arr[r - 1]); }
    function bestKeepAt(dice, r) {
      var ks = EVX.KEEPS[EVX.idxOfDice(dice)], best = null, bv = -Infinity, second = -Infinity;
      for (var k = 0; k < ks.length; k++) { var e = EVX.dot(ks[k], arr[r - 1]); if (e > bv) { second = bv; bv = e; best = ks[k]; } else if (e > second) second = e; }
      return { keep: EVX.keepPositions(dice, best.keptCounts), ev: bv, second: second };
    }
    var luck = 0, skill = 0, decisions = [];
    var firstLuck = nodeVal(rolls[0], 2) - stateVal; luck += firstLuck;
    for (var i = 0; i < keeps.length; i++) {
      var rl = 2 - i, node = nodeVal(rolls[i], rl), chosenEV = keepVal(rolls[i], rl, keeps[i]), bk = bestKeepAt(rolls[i], rl);
      skill += chosenEV - node;
      decisions.push({ type: 'keep', cost: chosenEV - node, chosenEV: chosenEV, optimalEV: node, margin: node - bk.second, chosen: keeps[i], optimal: bk.keep });
      luck += nodeVal(rolls[i + 1], rl - 1) - chosenEV;
    }
    var last = rolls[R - 1], cats = [];
    for (var c = 0; c < EVX.NCAT; c++) { if (mask & (1 << c)) continue; var key = EVX.CATS[c].key; cats.push({ key: key, immediate: G.scoreForExp(key, last), ev: expCellValue(mask, up, c, last) }); }
    cats.sort(function (a, b) { return b.ev - a.ev; });
    var nodeVal0 = cats[0].ev, chosen = cats.filter(function (c) { return c.key === t.category; })[0];
    var secondCat = cats.length > 1 ? cats[1].ev : cats[0].ev;
    skill += chosen.ev - nodeVal0;
    decisions.push({ type: 'category', cost: chosen.ev - nodeVal0, chosenEV: chosen.ev, optimalEV: nodeVal0, margin: cats[0].ev - secondCat, chosenKey: t.category, optimalKey: cats[0].key });
    var anyPositive = cats.some(function (c) { return c.immediate > 0; });
    return { luck: luck, skill: skill, decisions: decisions, firstLuck: firstLuck, rerollLuck: luck - firstLuck, score: chosen.immediate, forcedZero: !anyPositive, finalDice: last };
  }
  function expAggregate(decisions, turnDetails) {
    var EPS = EXP_EPS, optimalCount = decisions.filter(function (d) { return d.cost > -EPS; }).length;
    var blunder = null, sharpest = null;
    decisions.forEach(function (d) { if (!blunder || d.cost < blunder.cost) blunder = d; if (d.cost > -EPS && (!sharpest || d.margin > sharpest.margin)) sharpest = d; });
    var sev = { minor: 0, major: 0, fatal: 0 }, mistakes = { keep: 0, category: 0 }, costs = { keep: 0, category: 0 }, counts = { keep: 0, category: 0 };
    decisions.forEach(function (d) { counts[d.type]++; costs[d.type] += d.cost; if (d.cost < -EPS) { sev[expSeverityOf(d.cost)]++; mistakes[d.type]++; } });
    var topMoves = decisions.filter(function (d) { return d.cost > -EPS && d.margin > 0.5; }).sort(function (a, b) { return b.margin - a.margin; }).slice(0, 3);
    var stages = { early: { skill: 0, luck: 0, n: 0 }, mid: { skill: 0, luck: 0, n: 0 }, late: { skill: 0, luck: 0, n: 0 } };
    turnDetails.forEach(function (td) { var s = stages[expStageOf(td.turn)]; s.skill += td.skill; s.luck += (td.luck || 0); s.n++; });
    var zeroOuts = { total: 0, forced: 0, unforced: 0 };
    turnDetails.forEach(function (td) { if (td.score === 0) { zeroOuts.total++; td.forcedZero ? zeroOuts.forced++ : zeroOuts.unforced++; } });
    var byCategory = {};
    turnDetails.forEach(function (td) { byCategory[td.category] = { category: td.category, score: td.score, leak: -td.skill, luck: (typeof td.luck === 'number' ? td.luck : null), optimal: td.skill > -EPS }; });
    return { decisions: decisions, nDecisions: decisions.length, turns: turnDetails,
      accuracy: decisions.length ? optimalCount / decisions.length : 1, blunder: blunder, sharpest: sharpest, topMoves: topMoves,
      severity: sev, mistakes: mistakes, leak: costs, leakCounts: counts, stages: stages, zeroOuts: zeroOuts, byCategory: byCategory };
  }
  function analyzeGameExp(turns) {
    if (!exactReady || !turns || !turns.length) return null;
    var luck = 0, skill = 0, decisions = [], turnDetails = [];
    turns.forEach(function (t, ti) {
      var a; try { a = analyzeTurnExp(t); } catch (e) { return; }
      luck += a.luck; skill += a.skill;
      a.decisions.forEach(function (d) { d.turnCategory = t.category; d.turn = ti; decisions.push(d); });
      turnDetails.push({ turn: ti, category: t.category, score: a.score, luck: a.luck, skill: a.skill, firstLuck: a.firstLuck, rerollLuck: a.rerollLuck, forcedZero: a.forcedZero, finalDice: a.finalDice, nRolls: t.rolls.length, decisions: a.decisions });
    });
    if (!turnDetails.length) return null;
    var out = expAggregate(decisions, turnDetails);
    out.par = window.GeneralEVExactExp ? window.GeneralEVExactExp.par : 143.41;
    out.luck = luck; out.skill = skill; out.projectedFinal = out.par + luck + skill;
    out.avgLostPerDecision = decisions.length ? -skill / decisions.length : 0;
    out.avgLostPerTurn = turns.length ? -skill / turns.length : 0;
    out.luckFirst = expAvg(turnDetails.map(function (td) { return td.firstLuck; })) * turnDetails.length;
    out.luckRerolls = out.luck - out.luckFirst;
    out.clutch = out.stages.late.luck;
    return out;
  }
  // manual (ОТЧЕТ) analysis: only the final dice + the row pick are known → category-only, no luck
  function analyzeManualGameExp(turns) {
    if (!exactReady || !turns || !turns.length) return null;
    var decisions = [], turnDetails = [], skill = 0;
    turns.forEach(function (t, ti) {
      var cats = [];
      for (var c = 0; c < EVX.NCAT; c++) { if (t.mask & (1 << c)) continue; var key = EVX.CATS[c].key; cats.push({ key: key, immediate: G.scoreForExp(key, t.dice), ev: expCellValue(t.mask, t.up, c, t.dice) }); }
      cats.sort(function (a, b) { return b.ev - a.ev; });
      var chosen = cats.filter(function (c) { return c.key === t.category; })[0], second = cats.length > 1 ? cats[1].ev : cats[0].ev, cost = chosen.ev - cats[0].ev;
      skill += cost;
      var dec = { type: 'category', turn: ti, cost: cost, chosenEV: chosen.ev, optimalEV: cats[0].ev, margin: cats[0].ev - second, chosenKey: t.category, optimalKey: cats[0].key, turnCategory: t.category };
      decisions.push(dec);
      turnDetails.push({ turn: ti, category: t.category, score: chosen.immediate, skill: cost, forcedZero: !cats.some(function (c) { return c.immediate > 0; }), finalDice: t.dice, decisions: [dec] });
    });
    var out = expAggregate(decisions, turnDetails);
    out.manual = true; out.skill = skill; out.par = window.GeneralEVExactExp ? window.GeneralEVExactExp.par : 143.41;
    out.avgLostPerTurn = turns.length ? -skill / turns.length : 0;
    return out;
  }

  // ----- live hints (Щабът съветва), exact-EV backed -----
  var EXP_LABEL = {}; if (X) X.CATS.forEach(function (c) { EXP_LABEL[c.key] = c.label; });
  function expKeepValue(scores, dice, rollsLeft, keepBools) {
    var v0 = expV0(scores), arr = [v0]; for (var r = 1; r <= rollsLeft; r++) arr.push(expStageUp(arr[r - 1]));
    var c = [0, 0, 0, 0, 0, 0, 0]; for (var i = 0; i < dice.length; i++) if (keepBools[i]) c[dice[i]]++;
    return EVX.dot(EVX.keepResult(c), arr[rollsLeft - 1]);
  }
  function expRenderHint() {
    var line = $('hintLine'), p = G.currentPlayer(game);
    var show = hintsOn && exactReady && !p.isAI && !locked && !awaitingRoll && dice.length === G.DICE_COUNT;
    if (!show) { line.classList.add('hidden'); return; }
    var head, alts;
    if (throwsLeft > 0) {
      head = 'Щабът съветва:';
      var ranked = X.availableKeys(p).map(function (key) {
        var keep = X.keepFor(key, dice);
        return { key: key, keep: keep, ev: expKeepValue(p.scores, dice, throwsLeft, keep) };
      }).sort(function (a, b) { return b.ev - a.ev; });
      var sigSeen = {}, opts = [];
      ranked.forEach(function (o) { if (opts.length >= 3) return; var sig = o.keep.map(function (b) { return b ? 1 : 0; }).join(''); if (sigSeen[sig]) return; sigSeen[sig] = 1; opts.push(o); });
      alts = opts.map(function (o) {
        var kept = dice.filter(function (v, j) { return o.keep[j]; }), tname = EXP_LABEL[o.key] || o.key;
        if (kept.length === G.DICE_COUNT) return '<span class="kr">спри · отчети <b>' + esc(tname) + '</b></span>';
        var dd = kept.length ? '<span class="krd">' + kept.map(hintDie).join('') + '</span>' : '<span class="kr-none">нищо</span>';
        return '<span class="kr">дръж ' + dd + ' · търсиш <b>' + esc(tname) + '</b></span>';
      }).join('');
    } else {
      head = 'Щабът съветва да отчетеш:';
      alts = expRankCategories(p.scores, dice).slice(0, 3).map(function (c) { return '<span class="kr"><b>' + esc(EXP_LABEL[c.key] || c.key) + '</b></span>'; }).join('');
    }
    line.innerHTML = '<div class="hh">' + esc(head) + '</div><div class="krs">' + alts + '</div>';
    line.classList.remove('hidden');
  }
  function expRankCategories(scores, dice) {
    var mask = EVX.maskOfScores(scores), up = G.upperStateExp(scores).subtotal, cats = [];
    for (var i = 0; i < EVX.NCAT; i++) { if (mask & (1 << i)) continue; var key = EVX.CATS[i].key; cats.push({ key: key, immediate: G.scoreForExp(key, dice), ev: expCellValue(mask, up, i, dice) }); }
    cats.sort(function (a, b) { return b.ev - a.ev; });
    return cats;
  }
  function expRankKeeps(scores, dice, rollsLeft) {
    var v0 = expV0(scores), arr = [v0]; for (var r = 1; r <= rollsLeft; r++) arr.push(expStageUp(arr[r - 1]));
    var next = arr[rollsLeft - 1], dIdx = EVX.idxOfDice(dice), keeps = EVX.KEEPS[dIdx], ranked = [];
    for (var k = 0; k < keeps.length; k++) ranked.push({ keep: EVX.keepPositions(dice, keeps[k].keptCounts), ev: EVX.dot(keeps[k], next) });
    ranked.sort(function (a, b) { return b.ev - a.ev; });
    return ranked;
  }
  // persona-respecting picks over the EXACT rankings (mirrors EV.botCategory/botKeep)
  function expBotCategory(scores, dice, policy, rng) {
    if (policy.type === 'greedy' || policy.type === 'random') return X.aiChooseKey({ scores: scores }, dice);
    var ranked = expRankCategories(scores, dice);
    if (policy.type === 'optimal') return ranked[0].key;
    var positive = ranked.filter(function (r) { return r.immediate > 0; }), pool = positive.length ? positive : ranked;
    if (policy.type === 'epsilon') { var eps = policy.epsilon == null ? 0.25 : policy.epsilon; if ((rng || Math.random)() < eps) return pool[Math.floor((rng || Math.random)() * pool.length)].key; return pool[0].key; }
    return EVX.softmaxPick(pool, function (a) { return a.ev; }, policy.tau, rng).key;
  }
  function expBotKeep(scores, dice, rollsLeft, policy, rng) {
    rng = rng || Math.random;
    if (policy.type === 'greedy') return G.aiChooseHolds(dice);
    if (policy.type === 'random') { var all = rollsLeft === 2 ? false : rng() < 0.5; return dice.map(function () { return all; }); }
    var ranked = expRankKeeps(scores, dice, rollsLeft);
    if (policy.type === 'epsilon') { var eps = policy.epsilon == null ? 0.25 : policy.epsilon; if (rng() < eps) return ranked[Math.floor(rng() * ranked.length)].keep; return ranked[0].keep; }
    return EVX.softmaxPick(ranked, function (a) { return a.ev; }, policy.type === 'optimal' ? 0 : policy.tau, rng).keep;
  }

  function expAiKeeps(p) {
    if (exactReady && p.persona) return expBotKeep(p.scores, dice, throwsLeft, p.persona.policy, Math.random);
    if (evxReady && p.persona) return EVX.botKeep(p.scores, dice, throwsLeft, p.persona.policy, Math.random);
    return X.aiKeeps(p, dice);
  }
  function expAiStep() {
    var p = G.currentPlayer(game);
    if (throwsLeft > 0) {
      var holds = expAiKeeps(p);
      selected = activeKeep() ? holds.slice() : holds.map(function (h) { return !h; });
      var rr = rerollMask();
      if (rr.some(Boolean)) {
        expRenderDice();
        setTimeout(function () {
          applyReroll(rr); expLogReroll(rr); selected = [false, false, false, false, false]; throwsLeft--;
          expRenderAll(); shakeDice();
          setTimeout(throwsLeft > 0 ? expAiStep : expAiFinish, AI_DELAY);
        }, AI_DELAY * 0.65);
        return;
      }
    }
    setTimeout(expAiFinish, AI_DELAY);
  }
  // Penalty-aware 1-ply row choice: immediate score + the shipped (penalty-free)
  // continuation value, minus an EXACT −50 whenever this fill LOCKS a negative
  // number part (even with best-case future upper rolls). Keeps the bot off the cliff.
  function expChooseKeyEV(p, dice) {
    var sc = p.scores, mask = EVX.maskOfScores(sc), upNow = G.upperStateExp(sc).subtotal;
    var best = null, bv = -Infinity;
    X.availableKeys(p).forEach(function (key) {
      var imm = G.scoreForExp(key, dice), cont = EVX.vstar(mask | EVX.catBit(key)), pen = 0;
      var isUpper = G.UPPER_KEYS.indexOf(key) >= 0, upAfter = upNow + (isUpper ? imm : 0), maxFuture = 0;
      G.UPPER_KEYS.forEach(function (k, fi) { if (k !== key && typeof sc[k] !== 'number') maxFuture += 2 * (fi + 1); });
      if (upAfter + maxFuture < 0) pen = G.UPPER_PENALTY;
      var val = imm + cont + pen;
      if (val > bv) { bv = val; best = key; }
    });
    return best;
  }
  function expAiFinish() {
    var p = G.currentPlayer(game);
    var key = (exactReady && p.persona) ? expBotCategory(p.scores, dice, p.persona.policy, Math.random)
            : (evxReady && p.persona) ? expChooseKeyEV(p, dice) : X.aiChooseKey(p, dice);
    aiBusy = false;
    if (curLog) { curLog.category = key; moveLog[game.current].push(curLog); curLog = null; }
    X.assignScore(p, key, dice);
    locked = true; expRenderAll(); $('fire').disabled = true;
    turnTimer = setTimeout(expEndTurn, AI_VIEW_DELAY);
  }

  // ----- experimental rendering -----
  function expRenderAll() {
    expRenderHeader(); expRenderPills(); expRenderBoard();
    if (manualMode) { renderManualDock(); $('undoBottom').disabled = undoStack.length === 0; syncBottomPad(); return; }
    expRenderDice(); expRenderFire(); expRenderHint(); syncBottomPad();
  }
  function expRenderHeader() {
    var p = G.currentPlayer(game);
    // constant 2-line name: first two words on line 1, the rest + persona on line 2
    var words = esc(p.name).split(/\s+/);
    var l1 = (isOwnerP(p) ? ownerTokenHTML(true) : '') + words.slice(0, 2).join(' ');
    var rest = words.slice(2).join(' ');
    var persona = (p.isAI && p.persona) ? '<span class="pn-persona">⚙ ' + esc(p.persona.name) + '</span>' : (p.isAI ? '<span class="pn-persona">AI</span>' : '');
    var word2 = rest ? '<span class="pn-a">' + rest + '</span>' : '';   // spilled word keeps the full name style
    var line2 = (rest || persona) ? word2 + (rest && persona ? ' ' : '') + persona : '&nbsp;';
    $('curName').innerHTML = '<span class="pn2"><span class="pn-a">' + l1 + '</span><span class="pn-line2">' + line2 + '</span></span>';
    $('curPersona').classList.add('hidden'); $('curRibbons').innerHTML = '';   // persona inline; no ribbons
    $('curTotal').textContent = X.total(p);
    $('curNumPart').classList.add('hidden');   // number-part summary now sits between the board sections
    var filled = X.filledCount(p.scores);
    $('curRound').innerHTML = Math.min(filled + 1, EXP_CELLS) + '<span class="rsub">/' + EXP_CELLS + '</span>';
  }
  function expRenderPills() {
    $('pillWrap').innerHTML = game.players.map(pillHTML).join('');   // total() is ruleset-aware → X.total in exp mode
    $('pillWrap').querySelectorAll('.ppill').forEach(function (b) { b.onclick = function () { expPeek(+b.getAttribute('data-i')); }; });
  }
  function expPeek(i) {
    var p = game.players[i];
    $('peekTitle').innerHTML = (isOwnerP(p) ? ownerTokenHTML(true) : '') + esc(p.name) + (p.isAI && p.persona ? ' <span class="badge-ai">' + esc(p.persona.name) + '</span>' : '');
    $('peekBody').innerHTML = expMiniBoard(p);
    $('peekTotal').textContent = X.total(p);
    $('peekModal').classList.remove('hidden');
    if (tut) tutEvent('peek');
  }
  // experimental mini cell-board (peek / summary recap) — same look as the standard miniBoard,
  // with the signed number part (colour by value), the number-part bar, and фул хаус spanning two.
  function expMiniBoard(p) {
    var sc = p.scores;
    function tile(c, up) {
      var has = typeof sc[c.key] === 'number', v = sc[c.key];
      var sign = up && has ? (v > 0 ? ' pos' : v < 0 ? ' neg' : ' zero') : '';
      var span = (!up && c.key === 'fullHouse') ? ' fullspan' : '';
      return '<div class="mtile ' + (up ? 'up' : 'low') + (has ? '' : ' empty') + span + '"><span class="mlab">' + esc(c.label) + '</span><span class="mval' + sign + '">' + (has ? v : '–') + '</span></div>';
    }
    var up = G.CATEGORIES_EXP.filter(function (c) { return c.group === 'upper'; }).map(function (c) { return tile(c, true); }).join('');
    var low = G.CATEGORIES_EXP.filter(function (c) { return c.group === 'lower'; }).map(function (c) { return tile(c, false); }).join('');
    var st = G.upperStateExp(sc), Xv = st.contribution, xcls = Xv > 0 ? 'pos' : Xv < 0 ? 'neg' : 'zero';
    var numbar = '<div class="expnumbar"><span class="np-x ' + xcls + '">' + (Xv > 0 ? '+' : '') + Xv + '</span><span class="np-unit">т.</span></div>';
    return '<div class="miniboard"><div class="upper">' + up + '</div>' + numbar + '<div class="lower">' + low + '</div></div>';
  }
  // the player's single card drawn with the STANDARD tile board (+ the два чифта tile),
  // plus a number-part status bar (running Σ and the −50 risk).
  function expRenderBoard() {
    var p = G.currentPlayer(game), sc = p.scores;
    var canScore = !p.isAI && !locked && !awaitingRoll && dice.length === G.DICE_COUNT;
    var watchPrev = netWatching() && dice.length === G.DICE_COUNT, showPrev = canScore || watchPrev;   // spectators see read-only previews
    // ---- number part (deviation tiles) ----
    $('boardUpper').innerHTML = '';
    G.CATEGORIES_EXP.filter(function (c) { return c.group === 'upper'; }).forEach(function (c) {
      var key = c.key, done = typeof sc[key] === 'number', open = canScore && !done, prev = showPrev && !done;
      var dev = done ? sc[key] : (showPrev ? G.scoreForExp(key, dice) : null);
      var val = done ? sc[key] : (prev ? dev : null);
      var sign = val == null ? '' : (val > 0 ? ' pos' : val < 0 ? ' neg' : ' zero');   // colour the number by value
      var el = document.createElement('button');
      el.className = 'tile up' + (done ? ' done' : '');
      var pts = done ? sc[key] : (prev ? (dev > 0 ? '+' + dev : dev) : '·');
      el.innerHTML = '<span class="face-n">' + c.label + '</span><span class="pts' + (prev ? ' upchip' : '') + sign + '">' + pts + '</span>';
      if (open) el.onclick = function () { expCommit(key); };   // number rows take their (signed) deviation
      $('boardUpper').appendChild(el);
    });
    // ---- combinations (sum scoring, incl. два чифта) ----
    $('boardLower').innerHTML = '';
    G.CATEGORIES_EXP.filter(function (c) { return c.group === 'lower'; }).forEach(function (c) {
      var key = c.key, done = typeof sc[key] === 'number';
      var row = document.createElement('div');
      row.className = 'tile low' + (done ? ' done' : '') + (done && sc[key] === 0 ? ' void' : '') + (key === 'fullHouse' ? ' fullspan' : '');
      var head = '<span class="cname">' + c.label + '</span>';
      if (done) { row.innerHTML = head + '<span class="lval">' + sc[key] + '</span>'; }
      else {
        row.innerHTML = head + '<span class="acts"></span>';
        var acts = row.querySelector('.acts');
        if (showPrev) {
          var v = G.scoreForExp(key, dice);
          if (v > 0) { var chip = document.createElement('button'); chip.className = 'chip'; chip.textContent = v; if (canScore) chip.onclick = function (e) { e.stopPropagation(); expCommit(key, v); }; else chip.disabled = true; acts.appendChild(chip); }
          var x = document.createElement('button'); x.className = 'x'; x.textContent = '×'; x.setAttribute('aria-label', 'откажи се'); if (canScore) x.onclick = function (e) { e.stopPropagation(); expCommit(key, 0); }; else x.disabled = true; acts.appendChild(x);
          if (canScore) { row.style.cursor = 'pointer'; row.onclick = function () { v > 0 ? expCommit(key, v) : expCommit(key, 0); }; }
        }
      }
      $('boardLower').appendChild(row);
    });
    // number-part points-so-far BETWEEN the two sections: ±X (red/gold/green)
    var st = G.upperStateExp(sc), Xv = st.contribution, xcls = Xv > 0 ? 'pos' : Xv < 0 ? 'neg' : 'zero';
    $('expNumBar').className = 'expnumbar';
    $('expNumBar').innerHTML = '<span class="np-x np-tap ' + xcls + '">' + (Xv > 0 ? '+' : '') + Xv + '</span><span class="np-cap">точки</span>';
    var npx = $('expNumBar').querySelector('.np-x');
    if (npx) npx.onclick = function (e) { e.stopPropagation(); showNumPartTip(npx, st); };
  }
  // explainer for the minus number-part total: must finish 0+ or it takes a flat −50 (on top of the minus)
  function showNumPartTip(anchor, st) {
    var b = $('numPartTip');
    if (!b.classList.contains('hidden')) { b.classList.add('hidden'); return; }
    var sv = function (n) { return (n < 0 ? '−' : (n > 0 ? '+' : '')) + Math.abs(n); };
    var html = '<div class="kt-hd">Числова част (горна редица)</div>'
      + '<div class="np-tip-txt">Сборът трябва да е <b>0 или повече</b>. Ако завърши на минус — <b>−50 точки</b> отгоре.</div>';
    if (st.penalised) html += '<div class="np-tip-pen">Сборът е <b>' + sv(st.subtotal) + '</b>, значи общо <b>' + sv(st.subtotal) + ' − 50 = ' + sv(st.contribution) + ' т.</b></div>';
    b.innerHTML = html; b.classList.remove('hidden');
    var r = anchor.getBoundingClientRect();
    b.style.left = Math.min(Math.max(8, r.left + r.width / 2 - b.offsetWidth / 2), window.innerWidth - b.offsetWidth - 8) + 'px';
    b.style.top = (r.bottom + 8 + b.offsetHeight < window.innerHeight - 8 ? r.bottom + 8 : Math.max(8, r.top - b.offsetHeight - 8)) + 'px';
  }
  document.addEventListener('click', function (e) {
    var b = $('numPartTip');
    if (b && !b.classList.contains('hidden') && !b.contains(e.target) && !(e.target.classList && e.target.classList.contains('np-tap'))) b.classList.add('hidden');
  });
  function expRenderDice() {
    var p = G.currentPlayer(game);
    var box = $('dice'); box.innerHTML = '';
    if (awaitingRoll) {
      for (var k = 0; k < G.DICE_COUNT; k++) {
        var g = document.createElement('button'); g.className = 'die preroll'; g.disabled = true; g.setAttribute('aria-hidden', 'true'); box.appendChild(g);
      }
      var td = ''; for (var q = 0; q < ROLLS - 1; q++) td += '<span class="tdot on"></span>'; $('throws').innerHTML = td; return;
    }
    var interactive = !p.isAI && !locked && throwsLeft > 0;
    var batchMode = activeBatch() && diceGen.length === dice.length;   // group by roll instead of accenting
    dice.forEach(function (v, i) {
      if (batchMode && i > 0 && diceGen[i] !== diceGen[i - 1]) {
        var sep = document.createElement('span'); sep.className = 'die-sep'; sep.setAttribute('aria-hidden', 'true'); box.appendChild(sep);
      }
      var b = document.createElement('button');
      var sel = selected[i], keepMode = activeKeep(), fresh = !batchMode && diceNew[i];
      b.className = 'die' + (sel ? ' sel' + (keepMode ? ' keep' : '') : '') + (fresh ? ' fresh' : '');
      b.disabled = !interactive; b.setAttribute('data-i', i);
      b.innerHTML = pipFace(v) + (sel ? '<span class="reticle">' + (keepMode ? '✓' : '✕') + '</span>' : '');
      if (interactive) b.onclick = function () { toggleSelect(i); };
      box.appendChild(b);
    });
    var t = ''; for (var r = 0; r < ROLLS - 1; r++) t += '<span class="tdot' + (r < throwsLeft ? ' on' : '') + '"></span>';
    $('throws').innerHTML = t;
  }
  function expRenderFire() {
    $('fire').classList.remove('muted');   // clear leftover spectator styling (e.g. after a net minus game)
    syncRollAll();
    var p = G.currentPlayer(game);
    if (awaitingRoll) {
      $('bottombar').classList.add('preroll');
      $('rollHint').classList.add('hidden'); $('aiThinking').classList.add('hidden'); $('fireQ').classList.add('hidden');
      var fa = $('fire'); fa.classList.remove('hidden'); fa.disabled = false; $('fireTxt').textContent = 'ХВЪРЛИ!'; return;
    }
    $('bottombar').classList.remove('preroll');
    $('rollHint').classList.add('hidden');
    var fire = $('fire'), think = $('aiThinking');
    if (p.isAI) { fire.classList.add('hidden'); $('fireQ').classList.add('hidden'); think.classList.toggle('hidden', !aiBusy); return; }
    think.classList.add('hidden'); fire.classList.remove('hidden'); $('fireQ').classList.remove('hidden');
    var keep = activeKeep(), someSel = selected.some(Boolean), txt;
    if (locked) { txt = '…'; fire.disabled = true; }
    else if (throwsLeft <= 0) { txt = 'ИЗБЕРИ КОМБИНАЦИЯ!'; fire.disabled = true; }
    else if (!someSel) { txt = 'ИЗБЕРИ ЗАРОВЕ'; fire.disabled = true; }
    else { txt = keep ? 'ДРЪЖ!' : 'ХВЪРЛИ!'; fire.disabled = false; }
    $('fireTxt').textContent = txt;
  }
  function expEndGame() {
    locked = true;
    if (!viewingHistory) { archiveExpGame(); clearResume(); trackGame('finish'); if (netMode) netActiveClear(); }
    showGameOver(X.ranking(game)[0].player);   // same end screen as standard, sourced from the exp ruleset
  }
  function archiveExpGame() {
    var players = game.players.map(function (p) {
      return { name: p.name, color: p.color, isAI: !!p.isAI, owner: !!p.owner, gender: p.gender || 'm',
               personaId: p.persona ? p.persona.id : null, ribbons: p.ribbons || [], scores: p.scores, pts: G.playerTotalExp(p) };
    });
    archiveGame({ id: 'g' + Date.now() + '_' + Math.floor(Math.random() * 1e4), ts: Date.now(),
      ruleset: 'experimental', manualMode: manualMode, ownerSkipped: !!game.ownerSkipped, net: !!netMode, players: players, moveLog: moveLog });
  }
