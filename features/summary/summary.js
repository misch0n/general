'use strict';
// End game: tie-break, award ceremony, skill/luck explainers, keep-pattern metrics.
  // ---------- end game + tie-break ----------
  // serialise a finished game so the archive can reproduce its summary exactly
  function saveCurrentGame() {
    if (!game || !game.players || !game.players.length) return;
    archiveGame({
      id: 'g' + Date.now() + '_' + Math.floor(Math.random() * 1e4),
      ts: Date.now(),
      ruleset: (game && game.ruleset) || 'standard',   // net minus games archive as experimental → correct history totals
      manualMode: manualMode,
      ownerSkipped: !!(game && game.ownerSkipped),
      ownerNamed: !!(settings.useOwnerName && settings.ownerName.trim()),
      selectKeep: !!settings.selectKeep,   // the dice-selection flavour this game was played in
      net: !!netMode,                       // local vs network game (drives the history marker)
      players: serializePlayers(),
      moveLog: moveLog,
    });
  }
  function endGame() {
    if (!viewingHistory) { saveCurrentGame(); clearResume(); trackGame('finish'); if (netMode) netActiveClear(); }   // archive + drop resume + clear rejoin
    // dropped/incomplete players can't win or place — rank only those who finished
    var pool = game.players.filter(function (p) { return !isExcluded(p); });
    if (!pool.length) pool = game.players.slice();
    var top = Math.max.apply(null, pool.map(total)); // ranking includes the bonus
    var tied = pool.filter(function (p) { return total(p) === top; });
    // network games skip the local dice tie-break (no shared RNG); pick a top scorer
    if (tied.length > 1 && !netMode) startTieBreak(tied, showGameOver); else showGameOver(tied[0]);
  }

  var tieState = null;
  function startTieBreak(tied, done) {
    tieState = { tied: tied, rolls: null, done: done };
    $('tieTitle').textContent = 'РАВЕНСТВО!';
    renderTie();
    $('tieModal').classList.remove('hidden');
  }
  function renderTie() {
    $('tieBody').innerHTML = tieState.tied.map(function (p, i) {
      var roll = tieState.rolls ? tieState.rolls[i] : null;
      var win = tieState.rolls && roll === Math.max.apply(null, tieState.rolls);
      var die = roll ? '<div class="tiedie">' + pipFace(roll) + '</div>' : '<div class="tiedie empty">?</div>';
      return '<div class="tierow' + (win ? ' win' : '') + '"><span class="pdot" style="width:18px;height:18px;border-radius:50%;background:' + p.color + '"></span>'
        + '<span class="nm">' + esc(p.name) + '</span>' + die + '</div>';
    }).join('');
  }
  $('tieRoll').onclick = function () {
    if (!tieState) return;
    tieState.rolls = tieState.tied.map(function () { return G.rollDie(); });
    renderTie();
    var max = Math.max.apply(null, tieState.rolls);
    var winners = tieState.tied.filter(function (p, i) { return tieState.rolls[i] === max; });
    if (winners.length === 1) {
      var done = tieState.done, w = winners[0];
      setTimeout(function () { $('tieModal').classList.add('hidden'); tieState = null; done(w); }, 1000);
    } else {
      setTimeout(function () { tieState.tied = winners; tieState.rolls = null; $('tieTitle').textContent = 'ПАК РАВЕНСТВО!'; renderTie(); }, 1000);
    }
  };

  var CAT_LABEL = {}, CAT_BY_KEY = {};
  G.CATEGORIES.forEach(function (c) { CAT_LABEL[c.key] = c.label; CAT_BY_KEY[c.key] = c; });
  var CAT_LABEL_EXP = {}; if (G.CATEGORIES_EXP) G.CATEGORIES_EXP.forEach(function (c) { CAT_LABEL_EXP[c.key] = c.label; });
  function catLabelOf(key, rs) { return (rs === 'experimental' ? CAT_LABEL_EXP : CAT_LABEL)[key] || key; }
  // fixed-value combos: every player who fills them scores the same — there's no real
  // "record" to hold, so the category board never tints them in a player's colour
  var FIXED_VALUE_CATS = { smallStraight: 1, largeStraight: 1 };
  // the end-game summary is shared between rulesets; these resolve by the active game's ruleset
  function sumExp() { return !!(game && game.ruleset === 'experimental'); }
  function sumCats() { return sumExp() ? G.CATEGORIES_EXP : G.CATEGORIES; }
  function sumLabel(k) { return catLabelOf(k, sumExp() ? 'experimental' : 'standard'); }
  // a network player who dropped and never finished their board: excluded from rankings/stats,
  // shown greyed at the very bottom of the standings with no per-player summary.
  function netComplete(p) { var cs = sumCats(); for (var i = 0; i < cs.length; i++) if (!G.isCategoryFilled(p, cs[i].key)) return false; return true; }
  function isExcluded(p) { return netMode && !netComplete(p); }

  function showGameOver(winner) {
    // completed contenders ranked by points; dropped/incomplete players appended, greyed, at the bottom
    var others = game.players.filter(function (p) { return p !== winner && !isExcluded(p); })
      .sort(function (a, b) { return total(b) - total(a); });
    var excluded = game.players.filter(function (p) { return p !== winner && isExcluded(p); });   // never duplicate the winner
    var ordered = [winner].concat(others).concat(excluded);
    var analysisByPlayer = {};
    game.players.forEach(function (p, idx) {
      if (isExcluded(p)) { analysisByPlayer[idx] = null; return; }    // no summary for a dropped/incomplete boец
      // manual games are analysed too — category decisions only (dice rolls unseen)
      var ready = sumExp() ? exactReady : evReady;
      var log = moveLog[idx];
      // remote (networked) players carry only fill order, no dice — good enough for the points chart
      // but not for EV skill/luck analysis, so leave their analysis null
      var analysable = log && log.length && !log[0].remote;
      analysisByPlayer[idx] = (ready && analysable)
        ? (sumExp() ? (manualMode ? analyzeManualGameExp(log) : analyzeGameExp(log))
                    : (manualMode ? EV.analyzeManualGame(log) : EV.analyzeGame(log)))
        : null;
    });
    var anyAnalysis = Object.keys(analysisByPlayer).some(function (k) { return analysisByPlayer[k]; });
    dossierCtx = null; currentHistRec = null; // live game (history re-sets after)
    // sel = -1: nobody expanded by default (tap a player to reveal details); chartOpen: graph expanded
    summary = { winner: winner, ordered: ordered, ana: analysisByPlayer, tab: 'stand', sel: -1, chartOpen: true };
    summary.meta = computeSummaryMeta();   // §1 winner/skill/luck leaders + category board

    // luck has meaning only for dice games; the category board needs only scores
    var luckable = !manualMode && anyAnalysis;
    $('tabSkill').classList.toggle('hidden', !anyAnalysis);
    $('tabStand').classList.toggle('hidden', !anyAnalysis);
    $('tabLuck').classList.toggle('hidden', !luckable);
    $('tabCats').classList.toggle('hidden', false);
    $('overUndo').classList.toggle('hidden', !manualMode || !undoStack.length);
    renderWinHeadline();   // WD-01 + WD-03 + WD-05 verdict
    renderWinBadges();     // WD-04 badges

    // bet stakes — gated by its own Облози toggle
    if (settings.bets) {
      var msgs = '<div class="bet kept">🎖 ' + esc(winner.name) + ' запази ' + esc(winner.bet || 'облога') + '</div>';
      others.forEach(function (p) { msgs += '<div class="bet lost">☠ ' + esc(p.name) + ' загуби ' + esc(p.bet || 'облога') + '</div>'; });
      $('betMsgs').innerHTML = msgs;
    } else $('betMsgs').innerHTML = '';

    renderSummary(); // also paints the progress chart
    setOverTitle();  // live game → plain title (history overrides right after)
    $('overModal').classList.remove('hidden');
  }
  // the over-modal heading: plain for a live game; editable (box + pencil) with a
  // date/time subline when reviewing an archived battle
  function setOverTitle() {
    var rec = viewingHistory ? currentHistRec : null;
    var head = $('overHead'), title = $('overTitle'), sub = $('overSubdate');
    var mode = (rec ? rec.manualMode : manualMode) ? 'отчет' : 'игра';   // manual vs regular
    if (!rec) {
      head.classList.remove('editable');
      title.textContent = '🏆 Край на битката'; title.onclick = null;
      sub.textContent = mode; sub.classList.remove('hidden');
      renderMpResult();
      return;
    }
    // history: the title doubles as a rename box on tap (no pencil — the box itself implies it)
    head.classList.add('editable');
    title.textContent = rec.name || 'Край на битката';
    sub.textContent = fmtDate(rec.ts) + ' · ' + fmtTime(rec.ts) + ' · ' + mode; sub.classList.remove('hidden');
    title.onclick = function () { startRename(rec); };
    renderMpResult();
  }
  // which archived record the current summary is annotating (history vs the just-finished game)
  function summaryRec() { return viewingHistory ? currentHistRec : lastGameRec; }
  function setMpResult(val) {
    var rec = summaryRec(); if (!rec) return;
    rec.mpResult = val;
    var arr = loadHistory(), r = arr.filter(function (x) { return x.id === rec.id; })[0];
    if (r) { r.mpResult = val; persistHistory(arr); }
    renderMpResult();
  }
  // manual games: a control to declare it was multiplayer + the owner's placement (else it's
  // unranked and won't count toward victories / win-rate)
  function renderMpResult() {
    var rec = summaryRec(), show = !!(rec && rec.manualMode);
    $('mpResultBox').classList.toggle('hidden', !show);
    if (!show) return;
    var mp = rec.mpResult, cur = mp ? (mp.solo ? 'solo' : (typeof mp.place === 'number' ? String(mp.place > 4 ? 4 : mp.place) : '')) : '';
    $('mpResultBox').querySelectorAll('.mpr-opt').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-mp') === cur); });
  }
  $('mpResultBox').querySelectorAll('.mpr-opt').forEach(function (b) {
    b.onclick = function () { var v = b.getAttribute('data-mp'); setMpResult(v === 'solo' ? { solo: true } : { place: +v }); };
  });
  function startRename(rec) {
    var title = $('overTitle');
    if ($('overHead').querySelector('.titlerename')) return;   // already editing
    var input = document.createElement('input');
    input.type = 'text'; input.className = 'titlerename'; input.maxLength = 48;
    input.value = rec.name || ''; input.placeholder = 'Име на битката…';
    title.style.display = 'none';
    title.parentNode.insertBefore(input, title);
    input.focus(); input.select();
    var done = false;
    function commit(save) {
      if (done) return; done = true;
      if (save) renameGame(rec, input.value);
      input.remove(); title.style.display = '';
      setOverTitle();
    }
    input.onkeydown = function (e) { if (e.key === 'Enter') commit(true); else if (e.key === 'Escape') commit(false); };
    input.onblur = function () { commit(true); };
  }
  // persist a battle's custom name (empty clears it back to the date)
  function renameGame(rec, raw) {
    var name = (raw || '').trim().slice(0, 48);
    rec.name = name || undefined;
    var arr = loadHistory(), r = arr.filter(function (x) { return x.id === rec.id; })[0];
    if (r) { if (name) r.name = name; else delete r.name; persistHistory(arr); }
  }

  // (share-as-image, the report-help ? window, and the export/back summary buttons were removed)

  $('tabStand').onclick = function () { if (summary) { summary.tab = 'stand'; renderSummary(); } };
  $('tabSkill').onclick = function () { if (summary) { summary.tab = 'skill'; renderSummary(); } };
  $('tabLuck').onclick = function () { if (summary) { summary.tab = 'luck'; renderSummary(); } };
  $('tabCats').onclick = function () { if (summary) { summary.tab = 'cats'; renderSummary(); } };

  // ---- §1 shared award metadata: points winner, skill leader, luck champ, category board ----
  function computeSummaryMeta() {
    var players = game.players, ana = summary.ana, pts = players.map(function (p) { return total(p); });
    var live = players.map(function (p) { return !isExcluded(p); }), liveN = live.filter(Boolean).length || players.length;
    var winIdx = -1; for (var i = 0; i < players.length; i++) if (live[i] && (winIdx < 0 || pts[i] > pts[winIdx])) winIdx = i;
    if (winIdx < 0) winIdx = 0;
    // skill leader = fewest POINTS lost to suboptimal decisions (EV-skill, higher = better),
    // ties broken by optimal-decision %. This is the SAME quantity the margin split (умение)
    // uses, so the 🎯 badge, the verdict and the headline can never disagree (mistakes are
    // weighed by how costly they were, not just how often — a rare but huge blunder counts).
    var skillIdx = -1;
    players.forEach(function (p, i) {
      if (!ana[i]) return;
      if (skillIdx < 0) { skillIdx = i; return; }
      var a = ana[i], b = ana[skillIdx];
      if (a.skill > b.skill + 1e-9 || (Math.abs(a.skill - b.skill) < 1e-9 && a.accuracy > b.accuracy)) skillIdx = i;
    });
    // luck champ: highest luck among dice-mode analysed
    var luckIdx = -1;
    players.forEach(function (p, i) {
      if (!ana[i] || ana[i].manual || typeof ana[i].luck !== 'number') return;
      if (luckIdx < 0 || ana[i].luck > ana[luckIdx].luck) luckIdx = i;
    });
    // §1.5 category board: reduce scores across players → hit fraction + record holder.
    // A holder colours the cell only for a UNIQUE top score in a variable-value category;
    // fixed-value combos (kentas) and tied tops have no real record → left neutral.
    var board = sumCats().map(function (c) {
      var hit = 0, recVal = -1, recPi = -1, recTies = 0;
      players.forEach(function (p, i) {
        if (!live[i]) return;                        // dropped/incomplete players don't count toward records
        var v = p.scores[c.key];
        if (typeof v !== 'number') return;
        if (v > 0) hit++;
        if (v > recVal) { recVal = v; recPi = i; recTies = 1; }
        else if (v === recVal && v > 0) recTies++;
      });
      var holder = (recVal > 0 && recTies === 1 && !FIXED_VALUE_CATS[c.key]) ? recPi : -1;
      return { key: c.key, label: c.label, hit: hit, n: liveN, recVal: recVal, recPi: holder };
    });
    var recCount = players.map(function () { return 0; });
    board.forEach(function (b) { if (b.recPi >= 0) recCount[b.recPi]++; });
    var masterIdx = -1; recCount.forEach(function (c, i) { if (c > 0 && (masterIdx < 0 || c > recCount[masterIdx])) masterIdx = i; });
    return { winIdx: winIdx, skillIdx: skillIdx, luckIdx: luckIdx, board: board, recCount: recCount, masterIdx: masterIdx, pts: pts };
  }

  // §1.1 WD-01 hero line + §1.4 WD-03 margin split + §1.2 WD-05/06/08 verdict
  function renderWinHeadline() {
    var m = summary.meta, players = game.players, ana = summary.ana, P = players[m.winIdx];
    var runnerUp = summary.ordered[1] ? game.players.indexOf(summary.ordered[1]) : -1;
    var margin = runnerUp >= 0 ? m.pts[m.winIdx] - m.pts[runnerUp] : 0;
    // hero on two lines: winner's name, then the score it won with
    var html = '<div class="wh-name" style="color:' + P.color + '">' + esc(P.name) + '</div>'
      + '<div class="wh-won">спечели с <b>' + m.pts[m.winIdx] + '</b> точки</div>';

    // WD-03: split the margin against the runner-up so the parts sum to it
    var split = (runnerUp >= 0 && ana[m.winIdx] && ana[runnerUp]) ? EV.marginSplit(ana[m.winIdx], ana[runnerUp], margin) : null;
    if (split && margin > 0) {
      var parts = '<b class="' + (split.skill >= 0 ? 'np' : 'nn') + '">' + signed(split.skill) + 'т умение</b>';
      if (split.luck != null) parts += ' / <b class="' + (split.luck >= 0 ? 'np' : 'nn') + '">' + signed(split.luck) + 'т късмет</b>';
      html += '<div class="wh-split">' + parts + '</div>';
    }

    // WD-05/06/08: verdict, anchored on the field's skill leader
    var verdict = verdictFor(m, ana, margin, runnerUp);
    if (verdict) html += '<div class="wh-verdict ' + verdict.cls + '"><b>' + verdict.title + '</b>' + (verdict.sub ? ' — ' + verdict.sub : '') + '</div>';
    $('winHeadline').innerHTML = html;
  }

  function verdictFor(m, ana, margin, runnerUp) {
    if (m.skillIdx < 0 || !ana[m.winIdx]) return null;
    var players = game.players, W = m.winIdx, S = m.skillIdx;
    // field luck average over the OTHER analysed dice players (for the "luckier than field" test)
    function fieldLuckAvg(exclude) {
      var s = 0, k = 0;
      players.forEach(function (p, i) { if (i !== exclude && ana[i] && !ana[i].manual && typeof ana[i].luck === 'number') { s += ana[i].luck; k++; } });
      return k ? s / k : null;
    }
    var manual = !!ana[W].manual;
    if (W === S) {
      if (manual) return { cls: 'v-earned', title: 'Заслужена победа', sub: 'реши умението' };
      var fla = fieldLuckAvg(W), wl = ana[W].luck;
      if (fla != null && wl > fla + 2) return { cls: 'v-total', title: 'Тотална победа', sub: 'надигра ги и късметът беше с теб' };
      if (fla != null && wl < fla - 2) return { cls: 'v-earned', title: 'Заслужена победа', sub: 'надигра ги въпреки късмета' };
      return { cls: 'v-earned', title: 'Заслужена победа', sub: 'реши умението' };
    }
    // winner is NOT the skill leader → luck decided it
    var Sname = esc(players[S].name);
    if (manual) return { cls: 'v-lucky', title: 'Късметлийска победа', sub: esc(players[W].name) + ' спечели, но ' + Sname + ' игра по-точно' };
    var sp = EV.marginSplit(ana[W], ana[S], m.pts[W] - m.pts[S]);  // WD-06: quote the overturning luck
    var lq = sp && sp.luck != null && sp.luck > 0 ? ' — <b class="np">+' + sp.luck + ' т. късмет</b> обърнаха мача' : '';
    return { cls: 'v-lucky', title: 'Късметлийска победа', sub: esc(players[W].name) + ' спечели, но ' + Sname + ' го надигра' + lq };
  }

  // §1.3 WD-04 badges (small accents): Победител (points) · Тактик (skill) ·
  // Късметлия (luckiest) · Майстор на категориите (most category records)
  // tap any medal for how it's earned. The Победител medal is dropped — it's already
  // obvious who won from the headline.
  var MEDAL_EXPL = {
    tac: '<b>🎯 Тактик</b> — на играча, чиито решения струваха <b>най-малко изпуснати точки</b> (умение). Брои се цената на грешките, не просто колко хода са оптимални.',
    luck: '<b>🍀 Късметлия</b> — на когото <b>заровете услужиха най-много</b>: най-висок сбор късмет спрямо очакваното.',
    mas: '<b>📋 Майстор на категориите</b> — който държи <b>най-високия резултат в най-много категории</b> на дъската.'
  };
  function renderWinBadges() {
    var m = summary.meta, players = game.players, b = [];
    // the badge face carries ONLY the medal title; the box is tinted in the holder's
    // colour, and the explainer (tap) names the holding player
    function badge(cls, pl, icon, role, medal) {
      b.push('<button type="button" class="wbadge ' + cls + '" style="--c:' + pl.color + ';background:' + rgba(pl.color, 0.22) + '" data-medal="' + medal + '" aria-label="' + role + ' — ' + esc(pl.name) + ', как се присъжда">'
        + '<span class="wb-title">' + icon + ' ' + role + '</span></button>');
    }
    if (m.skillIdx >= 0) badge('b-tac', players[m.skillIdx], '🎯', 'Тактик', 'tac');
    if (m.luckIdx >= 0 && players.length > 1) badge('b-luck', players[m.luckIdx], '🍀', 'Късметлия', 'luck');
    if (m.masterIdx >= 0 && m.recCount[m.masterIdx] >= 2) badge('b-mas', players[m.masterIdx], '📋', 'Майстор', 'mas');
    $('winBadges').innerHTML = b.join('');
    // the explainer adds a line naming the holder (records count for the Майстор)
    function tipFor(medal) {
      var pl, extra = '';
      if (medal === 'tac') pl = players[m.skillIdx];
      else if (medal === 'luck') pl = players[m.luckIdx];
      else if (medal === 'mas') { pl = players[m.masterIdx]; extra = ' · ' + m.recCount[m.masterIdx] + ' рекорда'; }
      var who = pl ? '<div class="mt-holder">Държи: <b style="color:' + pl.color + '">' + esc(pl.name) + '</b>' + extra + '</div>' : '';
      return MEDAL_EXPL[medal] + who;
    }
    $('winBadges').querySelectorAll('.wbadge').forEach(function (el) {
      el.onclick = function (e) { e.stopPropagation(); showMedalTip(el, tipFor(el.getAttribute('data-medal'))); };
    });
  }
  function showMedalTip(anchor, html) {
    var g = $('medalTip'); if (!g.classList.contains('hidden') && g._for === anchor) { g.classList.add('hidden'); return; }
    g._for = anchor; g.innerHTML = html; g.classList.remove('hidden');
    var r = anchor.getBoundingClientRect();
    g.style.left = Math.min(Math.max(8, r.left + r.width / 2 - g.offsetWidth / 2), window.innerWidth - g.offsetWidth - 8) + 'px';
    var below = r.bottom + 8;
    g.style.top = (below + g.offsetHeight < window.innerHeight - 8 ? below : Math.max(8, r.top - g.offsetHeight - 8)) + 'px';
  }
  $('medalTip').onclick = function () { $('medalTip').classList.add('hidden'); };
  // tap the win/lose ratio bar → a small temporary bubble with the exact rates
  var winTipTimer = null;
  function showWinTip(el) {
    var g = $('medalTip'); g._for = null;   // always (re)show, never toggle off
    showMedalTip(el, '<span style="color:rgba(138,162,108,1)">●</span> <b>' + el.getAttribute('data-win') + '%</b> победи'
      + ' &nbsp; <span style="color:rgba(176,104,90,1)">●</span> <b>' + el.getAttribute('data-lose') + '%</b> загуби');
    clearTimeout(winTipTimer);
    winTipTimer = setTimeout(function () { if ($('medalTip')._for === el) $('medalTip').classList.add('hidden'); }, 2400);
  }
  // tap any underlined term (section label / EV reference) → a dismissible „how to read it" bubble
  document.addEventListener('click', function (e) {
    var t = e.target.closest && e.target.closest('.xterm'); if (!t) return;
    e.stopPropagation();
    var html = EXPLAIN[t.getAttribute('data-x')];
    if (html) showMedalTip(t, html);
  });

  function renderSummary() {
    var n = game.players.length, m = summary.meta, tab = summary.tab, ana = summary.ana, idx = function (p) { return game.players.indexOf(p); };
    ['stand', 'skill', 'luck', 'cats'].forEach(function (t) {
      $('tab' + t.charAt(0).toUpperCase() + t.slice(1)).classList.toggle('on', tab === t);
    });
    // EVERY tab keeps the player rows (so details are reachable anywhere); the top
    // visual changes: a chart for stand/skill/luck, the category board for cats.
    $('progressChart').classList.toggle('hidden', tab === 'cats');
    $('catBoard').classList.toggle('hidden', tab !== 'cats');
    $('ranks').classList.remove('hidden');

    var luckOf = function (pi) { return ana[pi] && typeof ana[pi].luck === 'number' && !ana[pi].manual ? ana[pi].luck : -1e9; };
    var rows = summary.ordered.slice();       // points order by default
    if (tab === 'skill') rows.sort(function (a, b) { return ((ana[idx(b)] ? ana[idx(b)].accuracy : -1) - (ana[idx(a)] ? ana[idx(a)].accuracy : -1)); });
    else if (tab === 'luck') rows.sort(function (a, b) { return luckOf(idx(b)) - luckOf(idx(a)); });   // luckiest first
    else if (tab === 'cats') rows.sort(function (a, b) { return m.recCount[idx(b)] - m.recCount[idx(a)]; });

    // rows are collapsed by default; the tapped player's full report is injected
    // right after their own row (so details sit *between* players)
    var contenderN = rows.filter(function (p) { return !isExcluded(p); }).length || n, rankPos = 0;
    $('ranks').innerHTML = rows.map(function (p, i) {
      var pi = idx(p), a = ana[pi], excl = isExcluded(p), expanded = pi === summary.sel, sub = '', val;
      // each tab ranks independently: the rank TITLE is assigned by the player's POSITION
      // in THIS tab's sequence — top row → Генерал, then the next lower title, and so on.
      // dropped/incomplete players get no title and sit at the bottom, outside the ranking.
      var badge = excl ? '✕' : G.rankForPlacement(rankPos++, contenderN);
      if (excl) {
        val = '📵';
        sub = '<div class="persub">разпадна се — извън класирането</div>';
      } else if (tab === 'skill') {
        val = a ? Math.round(a.accuracy * 100) + '%' : '–';
      } else if (tab === 'luck') {
        var lk = a && typeof a.luck === 'number' && !a.manual ? Math.round(a.luck) : null;
        val = lk != null ? '<b class="' + (lk >= 0 ? 'np' : 'nn') + '">' + signed(lk) + '</b>' : '–';   // luck points only
      } else if (tab === 'cats') {
        val = m.recCount[pi];                              // record count — no second line
      } else { // stand
        var bonusTag = p.bonus ? ' · +' + p.bonus + ' аванс' : '';
        var subStand = (p.isAI && p.persona ? '⚙ ' + esc(p.persona.name) : '') + bonusTag;
        if (subStand.trim()) sub = '<div class="persub">' + subStand + '</div>';
        val = total(p);
      }
      // the colour-coded rank title leads the row; the player's name follows (names are
      // crucial to read a ranking), then the metric value for this tab
      var row = '<div class="rankrow' + (i === 0 && !excl ? ' first' : '') + (expanded ? ' picked' : '') + (a && !excl ? '' : ' nodata') + (excl ? ' excluded' : '') + '" data-pi="' + pi + '">'
        + '<span class="rkbadge" style="color:' + p.color + ';border-color:' + p.color + '">' + esc(badge) + '</span>'
        + '<span class="nm">' + esc(p.name) + sub + '</span>'
        + '<span class="tt">' + val + '</span>'
        + (a && !excl ? '<span class="rkcaret' + (expanded ? ' open' : '') + '"></span>' : '') + '</div>';
      if (expanded && a && !excl) row += '<div class="evinline">' + renderReport(pi) + '</div>';
      return row;
    }).join('');
    $('ranks').querySelectorAll('.rankrow').forEach(function (r) {
      r.onclick = function () {
        var pi = +r.getAttribute('data-pi');
        if (!summary.ana[pi]) return;                       // no analysis → nothing to expand
        summary.sel = (summary.sel === pi ? -1 : pi);       // tap again to collapse
        renderSummary();
      };
    });
    // tap a turn rating → a small bubble with a tailored coach note for that turn
    // tap a turn row → fold its dice line in/out (the EV terms + quality thumb keep their own taps)
    $('ranks').querySelectorAll('.evtrow.clik').forEach(function (row) {
      row.onclick = function (e) {
        if (e.target.closest && e.target.closest('.xterm, .qicon')) return;
        var d = row.nextElementSibling; if (d && d.classList.contains('evrolls')) d.classList.toggle('collapsed');
      };
    });
    $('ranks').querySelectorAll('.qicon').forEach(function (b) {
      b.onclick = function (e) {
        e.stopPropagation();   // its own coach note; don't fold the row
        var qpi = +b.getAttribute('data-pi'), qt = +b.getAttribute('data-turn');
        var ana = summary.ana[qpi]; if (!ana || !ana.turns || !ana.turns[qt]) return;
        showMedalTip(b, turnComment(qpi, ana.turns[qt], ana));
      };
    });
    if (tab === 'cats') renderCatBoard(); else renderProgressChart();
  }

  // hex → rgba string (for tinting a cell in a player's colour)
  function rgba(hex, a) {
    var h = String(hex).replace('#', '');
    if (h.length === 3) h = h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2);
    var n = parseInt(h, 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }
  // §1.5 DA-08 (match) — category board on the in-game scoreboard layout: each cell
  // shows the % of players who scored it (top row) and the highest result (bottom),
  // and is tinted in the colour of the player who holds that record.
  function renderCatBoard() {
    var m = summary.meta, players = game.players, byKey = {};
    var hl = summary && summary.sel >= 0 ? summary.sel : -1;   // expanded player → mute the rest, like the chart
    m.board.forEach(function (b) { byKey[b.key] = b; });
    function tile(c) {
      var b = byKey[c.key], holder = b.recPi >= 0 ? players[b.recPi] : null;
      var pct = Math.round(100 * b.hit / b.n), hi = b.recVal >= 0 ? b.recVal + 'т.' : '–';
      var muted = holder && hl >= 0 && b.recPi !== hl;
      var style = holder && !muted ? ' style="background:' + rgba(holder.color, 0.26) + ';border-color:' + holder.color + '"' : '';
      var empty = b.recVal <= 0;                                 // nobody scored → dim; scored-but-no-holder stays neutral
      var span = (sumExp() && c.key === 'fullHouse') ? ' fullspan' : '';   // match the minus board: фул хаус spans a full row
      return '<div class="cgtile' + (empty ? ' none' : '') + (muted ? ' dim' : '') + span + '"' + style + '>'
        + '<span class="cg-lab">' + esc(c.label) + '</span>'
        + '<span class="cg-pct">' + pct + '%</span>'
        + '<span class="cg-rec">' + hi + '</span></div>';
    }
    var up = sumCats().filter(function (c) { return c.group === 'upper'; }).map(tile).join('');
    var low = sumCats().filter(function (c) { return c.group === 'lower'; }).map(tile).join('');
    // minus ruleset: a line under the number part — % who finished it at 0+ and the
    // best/worst number-part totals, each boxed in that player's colour (like the cells)
    var upLine = '';
    if (sumExp()) {
      var subs = players.map(function (p) { return G.upperStateExp(p.scores).subtotal; });
      var tots = players.map(function (p) { return G.upperStateExp(p.scores).contribution; });   // upper total incl. the −50 if negative
      var cleared = subs.filter(function (s) { return s >= 0; }).length;
      var pctUp = Math.round(100 * cleared / players.length);
      var hiPi = 0, loPi = 0;
      subs.forEach(function (s, i) { if (s > subs[hiPi]) hiPi = i; if (s < subs[loPi]) loPi = i; });
      var signv = function (v) { return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v); };
      var box = function (v, c) { return '<span class="cbu-box" style="background:' + rgba(c, 0.26) + ';border-color:' + c + '">' + signv(v) + '</span>'; };
      upLine = '<div class="cb-upline"><span class="cbu-txt"><b>' + pctUp + '%</b> с 0 или повече</span>'
        + '<span class="cbu-ar">▲</span>' + box(tots[hiPi], players[hiPi].color)
        + '<span class="cbu-ar">▼</span>' + box(tots[loPi], players[loPi].color) + '</div>';
    }
    var master = m.masterIdx >= 0 && m.recCount[m.masterIdx] >= 2
      ? '<div class="cb-master">📋 Майстор на категориите: <b style="color:' + players[m.masterIdx].color + '">' + esc(players[m.masterIdx].name) + '</b> · ' + m.recCount[m.masterIdx] + ' рекорда</div>' : '';
    var open = !summary || summary.catOpen !== false;   // collapsible; open by default
    $('catBoard').innerHTML = '<div class="catfold' + (open ? ' open' : '') + '">'
      + '<div class="catfold-bar"><span class="cf-lab">Категории</span><span class="cf-caret"></span></div>'
      + '<div class="catgrid-wrap' + (open ? '' : ' hidden') + '">'
      + '<div class="cb-legend">всяка клетка: <b>% вкарали</b> · <b>най-висок резултат</b> · цвят = рекордьорът</div>'
      + '<div class="miniboard catgrid"><div class="upper">' + up + '</div>' + upLine + '<div class="lower">' + low + '</div></div>' + master
      + '</div></div>';
    var fold = $('catBoard').querySelector('.catfold');
    fold.querySelector('.catfold-bar').onclick = function () {
      if (summary) summary.catOpen = !(summary.catOpen !== false);
      var o = summary.catOpen;
      fold.classList.toggle('open', o); fold.querySelector('.catgrid-wrap').classList.toggle('hidden', !o);
    };
  }

  // (the luck lens is now folded into the rows + the "Късмет по ходове" chart)

  // cumulative category points for player pi, round by round (starts at 0)
  function progressSeries(pi) {
    var log = moveLog[pi] || [], sc = game.players[pi].scores || {}, run = 0, pts = [0];
    if (log.length) {
      for (var r = 0; r < log.length; r++) { var v = sc[log[r].category]; run += (typeof v === 'number' ? v : 0); pts.push(run); }
    } else {
      // no move log (e.g. an older networked game saved only its scores) — fall back to the scored
      // categories in board order so the player still gets a progression line
      var cats = sumCats();
      for (var c = 0; c < cats.length; c++) { var sv = sc[cats[c].key]; if (typeof sv === 'number') { run += sv; pts.push(run); } }
    }
    return pts;
  }
  // §1.6 milestones for the highlighted player — tab-aware, good AND bad events
  // (points: big gains / Генерал / costly misses; skill: top move / blunders;
  // luck: lucky / unlucky turns). Only drawn when a single player is expanded.
  function milestonesFor(pi) {
    var a = summary.ana[pi], tab = summary.tab, out = [];
    if (tab === 'stand') {
      var log = moveLog[pi] || [], sc = game.players[pi].scores || {};
      for (var r = 0; r < log.length; r++) {
        var cat = log[r].category, v = (typeof sc[cat] === 'number' ? sc[cat] : 0), td = a && a.turns ? a.turns[r] : null;
        if (cat === 'general' && v > 0) out.push({ round: r + 1, label: '+' + v, good: true });
        else if (v >= 28) out.push({ round: r + 1, label: '+' + v, good: true });
        else if (v === 0 && td && td.skill <= -8) out.push({ round: r + 1, label: 'пропусна', good: false });  // costly forfeit
      }
    } else if (tab === 'skill' && a && a.turns) {
      a.turns.forEach(function (td) { if (td.skill <= -3) out.push({ round: td.turn + 1, label: '−' + (-td.skill).toFixed(1), good: false }); });   // blunder
      // (no „върхов" marker — a single sharp DECISION doesn't map onto the running optimal-%
      //  line, so it landed at confusing spots; the chart now flags only the costly slips)
    } else if (tab === 'luck' && a && a.turns && !a.manual) {
      a.turns.forEach(function (td) {
        if (td.luck >= 6) out.push({ round: td.turn + 1, label: '+' + Math.round(td.luck), good: true });
        else if (td.luck <= -6) out.push({ round: td.turn + 1, label: '' + Math.round(td.luck), good: false });
      });
    }
    return out;
  }
  // running optimal-play % for player pi over the turns (skill tab); starts at 100
  function optimalSeries(pi) {
    var a = summary.ana[pi]; if (!a || !a.turns) return [100];
    var opt = 0, tot = 0, pts = [100];
    a.turns.forEach(function (td) { tot++; if (td.skill >= -0.05) opt++; pts.push(Math.round(100 * opt / tot)); });
    return pts;
  }
  // cumulative luck for player pi over the turns (luck tab); can go negative
  function luckSeries(pi) {
    var a = summary.ana[pi]; if (!a || !a.turns || a.manual) return [0];
    var run = 0, pts = [0];
    a.turns.forEach(function (td) { run += (td.luck || 0); pts.push(run); });
    return pts;
  }
  // collapsible line chart. Points tab: running total. Skill tab: running optimal %.
  // Luck tab: cumulative luck (can dip negative). Each player in their colour; when
  // one is expanded below the others dim. No legend.
  function renderProgressChart() {
    var el = $('progressChart'); if (!el) return;
    var hl = summary && summary.sel >= 0 ? summary.sel : -1;
    var skillTab = summary && summary.tab === 'skill', luckTab = summary && summary.tab === 'luck';
    var series = game.players.map(function (p, i) { return { p: p, i: i, pts: luckTab ? luckSeries(i) : skillTab ? optimalSeries(i) : progressSeries(i) }; });
    var maxR = 0, yMin = 0, yMax = 0;
    series.forEach(function (s) { maxR = Math.max(maxR, s.pts.length - 1); s.pts.forEach(function (v) { if (v > yMax) yMax = v; if (v < yMin) yMin = v; }); });
    if (skillTab) { yMin = 0; yMax = 100; }
    if (luckTab && yMin === yMax) yMax = yMin + 1;
    if (maxR < 1 || (yMax <= yMin)) { el.innerHTML = ''; return; }
    var W = 320, H = 168, padL = 30, padR = 10, padT = 12, padB = 22, iw = W - padL - padR, ih = H - padT - padB, range = yMax - yMin;
    var x = function (r) { return padL + (maxR ? r / maxR * iw : 0); };
    var y = function (v) { return padT + ih - (v - yMin) / range * ih; };
    var suffix = skillTab ? '%' : '';
    var gvals = luckTab ? [yMax, 0, yMin] : [yMax, (yMin + yMax) / 2, yMin];
    var grid = '';
    gvals.forEach(function (gv) {
      var yy = y(gv);
      grid += '<line x1="' + padL + '" y1="' + yy + '" x2="' + (W - padR) + '" y2="' + yy + '" class="pc-grid' + (luckTab && gv === 0 ? ' zero' : '') + '"/>'
        + '<text x="' + (padL - 4) + '" y="' + (yy + 3) + '" class="pc-axis" text-anchor="end">' + (gv > 0 && luckTab ? '+' : '') + Math.round(gv) + suffix + '</text>';
    });
    // draw dimmed lines first, highlighted one last so it sits on top
    series.sort(function (a, b) { return (a.i === hl ? 1 : 0) - (b.i === hl ? 1 : 0); });
    var lines = series.map(function (s) {
      var muted = hl >= 0 && s.i !== hl;
      var poly = s.pts.map(function (v, r) { return x(r) + ',' + y(v); }).join(' ');
      var dots = muted ? '' : s.pts.map(function (v, r) { return '<circle cx="' + x(r) + '" cy="' + y(v) + '" r="2" fill="' + s.p.color + '"/>'; }).join('');
      return '<polyline points="' + poly + '" fill="none" stroke="' + s.p.color + '" stroke-width="' + (muted ? 1.8 : 2.4) + '" stroke-opacity="' + (muted ? 0.45 : 1) + '" stroke-linejoin="round" stroke-linecap="round"/>' + dots;
    }).join('');
    // §1.6 overlay: lead-change rings (points tab) + per-player milestones (good & bad)
    // for the highlighted player, tab-aware
    var overlay = '', byI = {}; series.forEach(function (s) { byI[s.i] = s; });
    if (!skillTab && !luckTab) {
      var prevLeader = -1;
      for (var r = 1; r <= maxR; r++) {
        var leader = -1, best = -Infinity;
        game.players.forEach(function (p, i) { var pp = byI[i].pts, v = pp[Math.min(r, pp.length - 1)]; if (v > best) { best = v; leader = i; } });
        if (leader >= 0 && prevLeader >= 0 && leader !== prevLeader && !(hl >= 0 && leader !== hl)) {
          var lp = byI[leader].pts;
          overlay += '<circle cx="' + x(r) + '" cy="' + y(lp[Math.min(r, lp.length - 1)]) + '" r="3.4" fill="none" stroke="' + game.players[leader].color + '" stroke-width="1.6"/>';
        }
        prevLeader = leader;
      }
    }
    if (hl >= 0 && byI[hl]) {
      var hp = byI[hl].pts;
      milestonesFor(hl).forEach(function (ms) {
        if (ms.round >= hp.length) return;
        var cx = x(ms.round), cy = y(hp[ms.round]), col = ms.good ? '#9bd17e' : '#e8807a', dy = ms.good ? -5 : 12;
        overlay += '<circle cx="' + cx + '" cy="' + cy + '" r="3.2" fill="' + col + '" stroke="#16160e" stroke-width="0.7"/>'
          + '<text x="' + cx + '" y="' + (cy + dy) + '" class="pc-swing" text-anchor="middle" fill="' + col + '">' + esc(ms.label) + '</text>';
      });
    }
    // x-axis turn ticks (1,2,3…) when there's room, else thinned out
    var ticks = '', per = iw / maxR, step = per >= 13 ? 1 : Math.ceil(13 / per);
    for (var tk = step; tk <= maxR; tk += step) ticks += '<text x="' + x(tk) + '" y="' + (H - 6) + '" class="pc-tick" text-anchor="middle">' + tk + '</text>';
    var xlab = ticks + '<text x="2" y="' + (H - 6) + '" class="pc-axis" text-anchor="start">ход</text>';
    var title = luckTab ? 'Късмет по ходове' : skillTab ? 'Умение по ходове' : 'Точки по ходове';
    var open = !summary || summary.chartOpen !== false;
    el.innerHTML = '<details class="pc-details"' + (open ? ' open' : '') + '><summary class="pc-title">' + title + '</summary>'
      + '<div class="pc-wrap"><svg viewBox="0 0 ' + W + ' ' + H + '" class="pc-svg" preserveAspectRatio="xMidYMid meet">'
      + grid + lines + overlay + '<g class="pc-scrub"></g>' + xlab + '</svg><div class="pc-readout hidden"></div></div></details>';
    var dt = el.querySelector('details'); if (dt) dt.addEventListener('toggle', function () { if (summary) summary.chartOpen = dt.open; });
    // drag-to-scrub: a vertical reader stepping turn by turn. Shows every player's
    // tally at that turn — or just the expanded player's when one is selected.
    var svg = el.querySelector('.pc-svg'), scrubG = el.querySelector('.pc-scrub'), readout = el.querySelector('.pc-readout');
    var vis = series.filter(function (s) { return hl < 0 || s.i === hl; });
    function turnAt(clientX) {
      var rc = svg.getBoundingClientRect(), sc = Math.min(rc.width / W, rc.height / H) || 1, ox = (rc.width - W * sc) / 2;
      var vbx = (clientX - rc.left - ox) / sc, rr = Math.round((vbx - padL) / iw * maxR);
      return Math.max(0, Math.min(maxR, rr));
    }
    function showScrub(clientX) {
      var rr = turnAt(clientX), sx = x(rr);
      var marks = '<line x1="' + sx + '" y1="' + padT + '" x2="' + sx + '" y2="' + (padT + ih) + '" class="pc-scrubline"/>';
      var rows = vis.map(function (s) { return { s: s, v: s.pts[Math.min(rr, s.pts.length - 1)] }; });
      rows.forEach(function (o) { marks += '<circle cx="' + sx + '" cy="' + y(o.v) + '" r="3.2" fill="' + o.s.p.color + '" stroke="#16160e" stroke-width="0.8"/>'; });
      scrubG.innerHTML = marks;
      readout.innerHTML = '<div class="pc-rd-hd">ход ' + rr + '</div>'
        + rows.sort(function (a, b) { return b.v - a.v; }).map(function (o) {
          return '<div class="pc-rd-row"><span class="pc-rd-dot" style="background:' + o.s.p.color + '"></span>'
            + '<span class="pc-rd-nm">' + esc(o.s.p.name) + '</span>'
            + '<span class="pc-rd-v">' + (luckTab && o.v > 0 ? '+' : '') + Math.round(o.v) + suffix + '</span></div>';
        }).join('');
      readout.classList.toggle('left', sx > W / 2);   // keep the panel clear of the cursor
      readout.classList.remove('hidden');
    }
    function hideScrub() { scrubG.innerHTML = ''; readout.classList.add('hidden'); }
    var scrubbing = false;
    svg.addEventListener('pointerdown', function (e) { scrubbing = true; try { svg.setPointerCapture(e.pointerId); } catch (x) {} showScrub(e.clientX); });
    svg.addEventListener('pointermove', function (e) { if (scrubbing) showScrub(e.clientX); });
    svg.addEventListener('pointerup', function () { scrubbing = false; hideScrub(); });
    svg.addEventListener('pointercancel', function () { scrubbing = false; hideScrub(); });
  }

  function signed(x, d) { return (x >= 0 ? '+' : '−') + Math.abs(x).toFixed(d == null ? 0 : d); }
  // signed delta vs a baseline, green when above / red when below (for dossier annotations)
  function deltaTag(v, d, unit) {
    var near = Math.abs(v) < (d ? Math.pow(10, -d) / 2 : 0.5);
    return '<b class="' + (near ? 'nu' : v > 0 ? 'np' : 'nn') + '">' + signed(v, d) + (unit ? ' ' + unit : '') + '</b>';
  }

  // ---- tappable explainer terms ----------------------------------------------
  // section labels (and EV references) carry a light underline and pop a „how to
  // read this" bubble on tap; the label→key map auto-tags every stat()/statRows()
  var TERM_KEY = {
    'Изтичане': 'leak', 'Избор на категория': 'leak', 'Раздели': 'razdeli', 'Издънки': 'sev',
    'Късмет': 'luck', 'Изнервяне': 'nerves', 'Спасения': 'bail', 'Нули': 'zero', 'По етапи': 'stages',
    'Чин': 'chin', 'Личен рекорд': 'pr', 'Генерали': 'generali', 'Постоянство': 'consist',
    'Развитие': 'razvitie', 'Най-голяма издънка': 'sev', 'Постижения': 'achievements',
    'Запис на хвърляне': 'throwkeep', 'Дръж / хвърли': 'chase',
  };
  var EXPLAIN = {
    ev: '<b>EV (очаквана стойност)</b> — средно колко точки носи едно решение при безброй повторения. Щабът сравнява хода ти с най-добрия възможен; разликата е „<b>загуба EV</b>“ — точките, оставени на масата. Така <span class="luck">късметът</span> (заровете) се отделя от <span class="skill">решенията</span> (какво направи с тях).',
    norma: '<b>Норма</b> — колко точки би вкарал перфектен играч средно. Целта, спрямо която се мери всичко.',
    luck: '<span class="luck"><b>Късмет</b></span> — колко ти дадоха или взеха заровете спрямо средното. Плюс = вървя ти, <b class="nn">минус</b> = прецакаха те. Средно е нула.',
    skill: '<span class="skill"><b>Решения</b></span> — точките, изпуснати заради неоптимални избори (винаги ≤ 0). По-близо до нула = по-чиста игра.',
    noluck: '<b>Без късмет</b> — резултат минус късмет: точките, които идват само от решенията ти.',
    acc: '<b>Оптимално %</b> — какъв дял от ходовете ти са били най-добрите възможни. Чинът отразява това.',
    leak: '<b>Изтичане</b> — точки EV, които изтичат при задържането на заровете и при избора на категория, и къде губиш повече.',
    razdeli: '<b>Раздели</b> — как се представи всяка половина на листа: <b>числа</b> (числовата част, ±; <b class="nn">−50</b> ако сборът ѝ е минус) и <b>комбинации</b>, плюс изтичането за всяка.',
    sev: '<b>Издънки</b> — грешките по тежест: дребни, сериозни и <b class="nn">фатални</b>. Една рядка едра грешка тежи повече от много дребни.',
    nerves: '<b>Изнервяне</b> — дали след гадно хвърляне играеш по-зле. Показва дали губиш самообладание под лош късмет.',
    bail: '<b>Спасения</b> — когато първото хвърляне счупи плана: колко добре превключваш към нов, вместо да се инатиш.',
    zero: '<b>Нули</b> — нулираните полета: общо, <b>принудени</b> (нищо не върви) и <b class="nn">по твоя вина</b>.',
    stages: '<b>По етапи</b> — средно изпуснати точки на ход в началото, средата и края на играта. Показва кога играеш най-слабо.',
    chin: '<b>Чин</b> — средният ти чин по умение през игрите, процентът победи и средното ти място.',
    pr: '<b>Личен рекорд</b> — най-добрият и най-лошият ти резултат, средният резултат и средният късмет през архива.',
    generali: '<b>Генерали</b> — в колко от битките си хвърлял Генерал (пет еднакви).',
    consist: '<b>Постоянство</b> — колко стабилни са резултатите и точността ти (± разсейване около средното).',
    razvitie: '<b>Развитие</b> — накъде върви точността ти през игрите: качваш ли се, спадаш или си стабилен.',
    achievements: '<b>Постижения</b> — категориите, в които най-често правиш върхови, оптимални ходове.',
    throwkeep: '<b>Запис на хвърляне</b> — на кое хвърляне записваш комбинацията: брой зарове = хвърлянето (едно = първо, две = второ, три = трето). Показва дали записваш бързо или гониш до последно.',
    chase: '<b>Дръж / хвърли</b> — за всяко число: горе (<span style="color:#9bd17e">зелено</span>) какъв дял от <b>задържаните</b> зарове е то, долу (<span style="color:#e0786f">червено</span>) какъв дял от <b>изхвърлените</b>. Издава какво гониш и какво изхвърляш.',
  };
  function xterm(label, key) { return '<span class="xterm" data-x="' + key + '">' + label + '</span>'; }
  function slbl(label, color) {
    var key = TERM_KEY[label];
    return '<span class="slbl' + (key ? ' xterm" data-x="' + key + '"' : '"') + ' style="color:' + color + '">' + label + ':</span>';
  }
  // a coloured stat line: laser-scannable label + body (body carries .np/.nn/.nu numbers)
  function stat(label, color, body) { return '<div class="evstat">' + slbl(label, color) + ' ' + body + '</div>'; }
  // same, but each item drops onto its own indented row
  function statRows(label, color, rows) {
    return '<div class="evstat">' + slbl(label, color)
      + '<div class="stlist">' + rows.map(function (r) { return '<div>' + r + '</div>'; }).join('') + '</div></div>';
  }
  function nSigned(v, d) { var s = signed(v, d); return '<b class="' + (v >= 0 ? 'np' : 'nn') + '">' + s + '</b>'; } // ±, green/red
  function nBad(v, d) { return '<b class="nn">' + (d != null ? v.toFixed(d) : v) + '</b>'; }                       // a loss (red)
  function nNeut(v) { return '<b class="nu">' + v + '</b>'; }                                                       // neutral (brass)

  // ---- keep-pattern metrics (dice games only; manual turns have no rolls/keeps) ----
  // throw-keep: of all turns, on which throw the player committed (1/2/3 rolls = no/1/2 rerolls).
  function throwKeepDist(logs) {
    var c = [0, 0, 0], n = 0;
    logs.forEach(function (log) { (log || []).forEach(function (t) {
      var rolls = t && t.rolls; if (!rolls || !rolls.length) return;
      c[Math.min(3, rolls.length) - 1]++; n++;
    }); });
    return n ? { pct: c.map(function (x) { return x / n * 100; }), n: n } : null;
  }
  // dice-keep „chase": the share of each face (1–6) among ALL dice HELD across rerolls.
  function diceKeepDist(logs) {
    var face = [0, 0, 0, 0, 0, 0, 0], total = 0;
    logs.forEach(function (log) { (log || []).forEach(function (t) {
      var rolls = t && t.rolls, keeps = t && t.keeps; if (!rolls || !keeps || !keeps.length) return;
      keeps.forEach(function (km, i) { var d = rolls[i] || []; for (var j = 0; j < 5; j++) if (km && km[j]) { var v = d[j]; if (v >= 1 && v <= 6) { face[v]++; total++; } } });
    }); });
    return total ? { pct: [1, 2, 3, 4, 5, 6].map(function (v) { return face[v] / total * 100; }), total: total } : null;
  }
  // dice-drop: the mirror of keep — the share of each face among ALL dice DISCARDED (re-thrown).
  function diceDropDist(logs) {
    var face = [0, 0, 0, 0, 0, 0, 0], total = 0;
    logs.forEach(function (log) { (log || []).forEach(function (t) {
      var rolls = t && t.rolls, keeps = t && t.keeps; if (!rolls || !keeps || !keeps.length) return;
      keeps.forEach(function (km, i) { var d = rolls[i] || []; for (var j = 0; j < 5; j++) if (km && !km[j]) { var v = d[j]; if (v >= 1 && v <= 6) { face[v]++; total++; } } });
    }); });
    return total ? { pct: [1, 2, 3, 4, 5, 6].map(function (v) { return face[v] / total * 100; }), total: total } : null;
  }
  function kddie(v) { return '<span class="kddie">' + pipFace(v) + '</span>'; }
  function diceRowHTML(vals) { return '<span class="thd">' + vals.map(kddie).join('') + '</span>'; }
  function throwKeepHTML(dist) {
    if (!dist) return '';
    // the throw is shown as that many dice (1 / two / three), not words
    return statRows('Запис на хвърляне', RC.throwk, [
      diceRowHTML([1]) + ' ' + nNeut(Math.round(dist.pct[0])) + '%',
      diceRowHTML([4, 5]) + ' ' + nNeut(Math.round(dist.pct[1])) + '%',
      diceRowHTML([6, 6, 6]) + ' ' + nNeut(Math.round(dist.pct[2])) + '%' ]);
  }
  // per face: kept % (green, above the die) and dropped % (red, below) — the chase profile
  function diceKeepHTML(keepDist, dropDist) {
    if (!keepDist && !dropDist) return '';
    var cells = [0, 1, 2, 3, 4, 5].map(function (i) {
      var k = keepDist ? Math.round(keepDist.pct[i]) : 0, d = dropDist ? Math.round(dropDist.pct[i]) : 0;
      return '<div class="kdcell"><span class="kdpct keep">' + k + '%</span>' + kddie(i + 1) + '<span class="kdpct drop">' + d + '%</span></div>';
    }).join('');
    return '<div class="evstat">' + slbl('Дръж / хвърли', RC.chase) + '<div class="keepdist">' + cells + '</div></div>';
  }

  // per-die generation for each roll: 1 on the first throw; a kept die keeps its generation,
  // a freshly-rolled die takes the current throw number (matched by value across rolls).
  function rollGens(rolls, keeps) {
    var gens = [rolls[0] ? rolls[0].map(function () { return 1; }) : []];
    for (var i = 1; i < rolls.length; i++) {
      var prev = rolls[i - 1] || [], km = keeps[i - 1] || [], pg = gens[i - 1] || [], pool = [];
      for (var j = 0; j < prev.length; j++) if (km[j]) pool.push({ v: prev[j], g: pg[j], used: false });
      gens.push((rolls[i] || []).map(function (v) {
        for (var k = 0; k < pool.length; k++) if (!pool[k].used && pool[k].v === v) { pool[k].used = true; return pool[k].g; }
        return i + 1;   // a die rolled fresh on this throw
      }));
    }
    return gens;
  }
  // compact render of a turn's 1–3 rolls. The KEPT dice are always highlighted; on each
  // non-final roll the dice carried forward (keeps[i]) light up, the rest grey out. The final
  // roll (and any single-roll turn) lights up in full — that's the committed hand — and the dice
  // that FORM the scored combo are drawn slightly bigger. „Split" groups each roll by generation
  // (oldest → newest, as the player saw them); „order" sorts every roll by value.
  function turnDiceHTML(pi, td, manual, collapsed) {
    var log = moveLog[pi] && moveLog[pi][td.turn];
    var seq = manual ? (log && log.dice ? [log.dice] : (td.finalDice ? [td.finalDice] : []))
                     : (log && log.rolls ? log.rolls : (td.finalDice ? [td.finalDice] : []));
    if (!seq.length) return '';
    var keeps = (log && log.keeps) || [];
    var batchMode = !!settings.newDiceBatch;   // order vs split — the owner's display preference
    var gens = batchMode ? rollGens(seq, keeps) : null;
    var finalDice = seq[seq.length - 1] || [];
    // the dice that build the scored combo (skip forfeits/0): a consumable multiset of values
    var comboVals = (td.score !== 0 && td.category && G.keepToward) ? (G.keepToward(td.category, finalDice) || []).slice() : null;
    var rolls = seq.map(function (d, i) {
      var last = i === seq.length - 1, km = last ? null : (keeps[i] || []), g = gens ? (gens[i] || []) : null;
      var arr = (d || []).map(function (v, j) { return { v: v, kept: km ? !!km[j] : true, gen: g ? g[j] : 1 }; });
      if (batchMode) arr.sort(function (x, y) { return (x.gen - y.gen) || (x.v - y.v); });   // split: by generation, then value
      else arr.sort(function (x, y) { return x.v - y.v; });                                   // order: by value
      var pool = last && comboVals ? comboVals.slice() : null;   // per-roll consumable copy
      var out = '', prevGen = null;
      arr.forEach(function (o) {
        if (batchMode && prevGen !== null && prevGen !== o.gen) out += '<span class="rdie-sep" aria-hidden="true"></span>';   // divider between generation groups
        var hl = last || o.kept;   // kept dice always highlighted; the final hand lights up in full
        var big = false;
        if (pool) { var k = pool.indexOf(o.v); if (k >= 0) { pool.splice(k, 1); big = true; } }   // a combo die on the final roll
        out += '<span class="rdie' + (hl ? ' kept' : '') + (big ? ' combo' : '') + '">' + o.v + '</span>';
        prevGen = o.gen;
      });
      return '<span class="rroll' + (last ? ' last' : '') + '">' + out + '</span>';
    }).join('<span class="rarrow">→</span>');
    return '<div class="evrolls' + (collapsed ? ' collapsed' : '') + '">' + rolls + '</div>';
  }
  // four-tier turn rating off the decision EV lost in the turn (skill ≤ 0)
  function turnQuality(skill) {
    if (skill >= -0.5) return { cls: 'q-great', tier: 'great' };   // essentially optimal
    if (skill >= -2)   return { cls: 'q-ok', tier: 'ok' };         // minor leak
    if (skill >= -5)   return { cls: 'q-bad', tier: 'bad' };       // a weak turn
    return { cls: 'q-blunder', tier: 'blunder' };                  // a real blunder
  }
  // CSS/SVG thumb glyph (theme-coloured); up = good, down = bad
  function thumbSVG(down) {
    return '<svg class="thumb" viewBox="0 0 24 24" aria-hidden="true"' + (down ? ' style="transform:scaleY(-1)"' : '') + '>'
      + '<path d="M2.5 10.2h3.4v9.3H2.5zM7.4 19.5v-9.1l3.3-5.2c.2-.3.6-.5 1-.4.8.1 1.4.9 1.2 1.7l-.8 3.6h5.2c1.2 0 2 1.1 1.7 2.2l-1.5 5.1c-.2.8-1 1.4-1.8 1.4z"/></svg>';
  }
  // touchable rating: 👍👍 great · 👍 ok · 👎 bad · 👎👎 blunder — tap pops a tailored coach note
  function qualityIcon(skill, pi, turn) {
    var tier = turnQuality(skill).tier, body, title;
    if (tier === 'great') { body = thumbSVG(false) + thumbSVG(false); title = 'върхов ход'; }
    else if (tier === 'ok') { body = thumbSVG(false); title = 'окей'; }
    else if (tier === 'bad') { body = thumbSVG(true); title = 'слаб ход'; }
    else { body = thumbSVG(true) + thumbSVG(true); title = 'издънка'; }
    return '<button type="button" class="qicon ' + tier + '" data-pi="' + pi + '" data-turn="' + turn + '"'
      + ' title="' + title + ' — докосни за съвет" aria-label="' + title + ', докосни за съвет">' + body + '</button>';
  }
  // a practical, growth-oriented note for one turn: what was better with these dice,
  // a flag for blind chasing / over-risk, or plain praise when there's nothing to fix
  function turnComment(pi, td, fa) {
    var tier = turnQuality(td.skill).tier;
    var worst = null;
    (td.decisions || []).forEach(function (d) { if (!worst || d.cost < worst.cost) worst = d; });
    var lost = worst ? (Math.round(-worst.cost * 10) / 10) : 0;
    // nothing material to fix → praise (call out good play through bad dice / a Генерал)
    if (!worst || worst.cost > -0.5) {
      if (!fa.manual && typeof td.luck === 'number' && td.luck < -4) return '👌 Лоши зарове, но изигра ги оптимално.';
      if (td.category === 'general' && td.score > 0) return '🎖 Генерал! Върхов ход.';
      return tier === 'great' ? '👌 Оптимален ход — нямаше по-добро с тези зарове.' : '👌 Почти оптимално — само дребни загуби.';
    }
    // costliest mistake was the category choice
    if (worst.type === 'category') {
      var chosenL = sumLabel(worst.chosenKey), optL = sumLabel(worst.optimalKey);
      if (td.score === 0 && !td.forcedZero)
        return '🎯 Нулира <b>' + esc(chosenL) + '</b> на сляпо — по-сигурно беше <b>' + esc(optL) + '</b> (−' + lost + ' т.).';
      if (worst.chosenKey !== worst.optimalKey)
        return '🎯 По-добре играй <b>' + esc(optL) + '</b> вместо <b>' + esc(chosenL) + '</b> (−' + lost + ' т.).';
      return '🎯 Имаше малко по-добър избор на поле (−' + lost + ' т.).';
    }
    // costliest mistake was a keep — name the better dice to hold + flag over-chasing
    var found = -1, k = 0;
    td.decisions.forEach(function (d) { if (d.type === 'keep') { if (d === worst) found = k; k++; } });
    var log = moveLog[pi] && moveLog[pi][td.turn];
    var dice = (log && log.rolls && found >= 0) ? log.rolls[found] : null;
    var keepStr = '';
    if (dice && worst.optimal) {
      var kept = []; dice.forEach(function (v, j) { if (worst.optimal[j]) kept.push(v); });
      keepStr = kept.length ? ' — по-добре задръж <b>' + kept.slice().sort(function (a, b) { return a - b; }).join(' ') + '</b>'
                            : ' — по-добре не задържай нищо';
    }
    var chase = '';
    if (worst.chosen && worst.optimal) {
      var chN = worst.chosen.filter(Boolean).length, opN = worst.optimal.filter(Boolean).length;
      if (chN < opN) chase = ' Подгони по-голямо и прехвърли излишно.';
      else if (chN > opN) chase = ' Задържа твърде много, без да опиташ да подобриш.';
    }
    return '🎲 Слаб избор кои зарове да задържиш (−' + lost + ' т.).' + chase + keepStr;
  }
  // signed EV cell: zero shows as a green +0; negatives red, positives green
  function evNum(v) {
    if (Math.abs(v) < 0.05) return '<b class="np">+0</b>';
    return '<b class="' + (v >= 0 ? 'np' : 'nn') + '">' + signed(v, 1) + '</b>';
  }

  // colour palette for the stat labels (distinct hues for quick scanning)
  var RC = { luck: '#9bd17e', skill: '#e8b06a', leak: '#e0b85a', sev: '#e05545', nerves: '#e0688a',
             clutch: '#6fa8e8', bail: '#7ab8c0', zero: '#e0a05a', upper: '#7ab85a', stage: '#b39ddb', gen: 'var(--gen-brass-bright)',
             throwk: '#c9a0dc', chase: '#6fb0c0' };

  function renderReport(pi) {
    var fp = game.players[pi], fa = summary.ana[pi];
    var fpTotal = sumExp() ? X.total(fp) : G.playerTotal(fp);   // ruleset-aware running total
    var genVal = fp.scores.general;
    var html = '<div class="evpanel">';
    // (no "Рапорт за…" header — the details speak for themselves; EV lives in the ? window)

    // §identity (dice mode only — manual games have no luck term). §1.9 DA-21:
    // round the parts so they SUM to the shown final — absorb the remainder into
    // par (the largest term, 195.41), so a user adding them up never sees a gap.
    if (!fa.manual) {
      var tot = fpTotal, luckShown = Math.round(fa.luck), skillShown = Math.round(fa.skill);
      var parShown = tot - luckShown - skillShown;
      html += '<div class="evline"><b>' + parShown + '</b> ' + xterm('норма', 'norma') + ' '
        + '<span class="luck">' + signed(luckShown) + ' ' + xterm('късмет', 'luck') + '</span> '
        + '<span class="skill">' + signed(skillShown) + ' ' + xterm('решения', 'skill') + '</span> → <b>' + tot + '</b></div>';
    }

    // §5 playstyle box: stylised persona + Генерал badge, optimal% (right), description, avg EV/turn
    var st = G.playstyleFor(fa);
    var genBadge = (typeof genVal === 'number' && genVal > 0)
      ? '<span class="genbadge" title="Хвърли Генерал">🎖 ГЕНЕРАЛ ' + genVal + '</span>' : '';
    html += '<div class="stylebox"><div class="styhead"><div class="styleft">'
      + (st ? '<span class="stychip" style="background:' + st.color + '">' + esc(st.name) + '</span>' : '')
      + genBadge + '</div>'
      + '<span class="styopt">' + xterm('<b class="nu">' + Math.round(fa.accuracy * 100) + '%</b>', 'acc') + '</span></div>'
      + (st ? '<div class="stydesc">' + esc(st.desc) + '</div>' : '')
      + '<div class="stymetrics">средно ' + nBad(fa.avgLostPerTurn, 1) + ' т. ' + xterm('EV/ход', 'ev') + ' загуба</div></div>';

    // §1.8 DA-16 (game) — one synthesised "work on X" prescription for THIS game
    html += '<div class="coachline">' + coachLine(fa) + '</div>';

    // §2.5 DA-14 — viewing a past owner game: how this result compares to your average
    if (dossierCtx && dossierCtx.career && pi === dossierCtx.ownerPi) {
      var car = dossierCtx.career, parts = [];
      parts.push('резултат ' + deltaTag(fpTotal - car.avgScore, 0, 'т.'));
      parts.push('точност ' + deltaTag(fa.accuracy * 100 - car.avgAcc * 100, 0, '%'));
      if (!fa.manual && car.avgLuck != null) parts.push('късмет ' + deltaTag(fa.luck - car.avgLuck, 0, 'т.'));
      html += '<div class="dossierdelta">спрямо средното ти: ' + parts.join(' · ') + '</div>';
    }

    // outstanding moves / costliest mistake (the blunder reads as a headline + detail line)
    if (fa.sharpest) html += '<div class="evpick sharp">✓ Най-добър ход: ' + decisionLabel(fa.sharpest) + '</div>';
    if (fa.blunder && fa.blunder.cost < -0.5) {
      var b = fa.blunder, bcost = '−' + (-b.cost).toFixed(1) + ' т.', bhead, bdet;
      if (b.type === 'category') {
        bhead = 'игра ' + (sumLabel(b.chosenKey));
        bdet = (b.chosenKey !== b.optimalKey ? 'по-добре ' + (sumLabel(b.optimalKey)) + ' · ' : '') + bcost;
      } else { bhead = 'задържане на заровете'; bdet = bcost; }
      html += '<div class="evpick blunder"><div class="epk-h">✗ Най-скъпа грешка: ' + esc(bhead) + '</div>'
        + '<div class="epk-d">' + esc(bdet) + '</div></div>';
    }

    // §6 coloured stat lines ----------------------------------------------------
    // hold/category efficiency + mistake counts — each source on its own row
    if (!fa.manual) {
      var leakWord = fa.leak.keep <= fa.leak.category ? 'задържанията' : 'избора на категория';
      html += statRows('Изтичане', RC.leak, [
        'задържания ' + nBad(fa.leak.keep, 0) + ' т. (' + fa.mistakes.keep + '/' + fa.leakCounts.keep + ' грешни)',
        'категории ' + nBad(fa.leak.category, 0) + ' т. (' + fa.mistakes.category + '/' + fa.leakCounts.category + ' грешни)',
        'повече губиш в <b>' + leakWord + '</b>' ]);
    } else {
      html += stat('Избор на категория', RC.leak, fa.mistakes.category + ' от ' + fa.leakCounts.category + ' неоптимални (' + nBad(-fa.leak.category, 0) + ' т. изпуснати)');
    }

    // §6.x experimental: how each half of the card performed (points + EV-leak)
    if (sumExp()) {
      var upPts = G.upperStateExp(fp.scores).contribution, lowPts = 0, upLeak = 0, lowLeak = 0;
      G.CATEGORIES_EXP.forEach(function (c) {
        var bc = fa.byCategory && fa.byCategory[c.key];
        if (c.group === 'lower' && typeof fp.scores[c.key] === 'number') lowPts += fp.scores[c.key];
        if (bc) { if (c.group === 'upper') upLeak += bc.leak; else lowLeak += bc.leak; }
      });
      var upB = upPts > 0 ? '<b class="np">+' + upPts + '</b>' : upPts < 0 ? '<b class="nn">' + upPts + '</b>' : '<b class="nu">0</b>';
      html += statRows('Раздели', RC.upper, [
        'числа ' + upB + ' т. · теч ' + nBad(upLeak, 1),
        'комбинации ' + nNeut(lowPts) + ' т. · теч ' + nBad(lowLeak, 1) ]);
    }

    // blunder categorisation by severity — each tier on its own row
    var sevTotal = fa.severity.minor + fa.severity.major + fa.severity.fatal;
    if (sevTotal) html += statRows('Издънки', RC.sev, [
      nNeut(fa.severity.minor) + ' дребни',
      nNeut(fa.severity.major) + ' сериозни',
      '<b class="nn">' + fa.severity.fatal + '</b> фатални' ]);
    else html += stat('Издънки', RC.sev, 'нито една — чисто досие');

    // deep luck deconstruction + nerves + bailout (need the roll sequence)
    if (!fa.manual) {
      html += statRows('Късмет', RC.luck, [
        'първо хвърляне ' + nSigned(fa.luckFirst, 0),
        'прехвърляния ' + nSigned(fa.luckRerolls, 0),
        'в решителния край ' + nSigned(fa.clutch, 0) ]);
      if (fa.tilt) {
        html += stat('Изнервяне', RC.nerves, fa.tilt.delta > 1.5
          ? 'след гадно хвърляне губиш с <b class="nn">' + signed(fa.tilt.delta, 1) + '</b> т./ход повече — дишай дълбоко'
          : 'хладнокръвен — лошият късмет не те разклаща');
      }
      if (fa.bailout) {
        var pivots = fa.bailout.avgCost <= fa.bailout.baseline + 0.5;
        html += stat('Спасения', RC.bail, 'при счупен план (' + fa.bailout.n + ' хода) губиш средно ' + nBad(fa.bailout.avgCost, 1)
          + ' т./ход — ' + (pivots ? '<b class="np">превключваш добре</b>' : '<b class="nn">инатиш се на стария план</b>'));
      }
      // on which throw you commit, and what you tend to hold vs discard (chase profile)
      html += throwKeepHTML(throwKeepDist([moveLog[pi]]));
      html += diceKeepHTML(diceKeepDist([moveLog[pi]]), diceDropDist([moveLog[pi]]));
    }

    // zero-out avoidance — each kind on its own row
    if (fa.zeroOuts.total) {
      html += statRows('Нули', RC.zero, [
        'общо ' + nNeut(fa.zeroOuts.total),
        'принудени ' + nNeut(fa.zeroOuts.forced),
        'от твоята игра <b class="nn">' + fa.zeroOuts.unforced + '</b>' ]);
    }

    // game-section ratings (last entry) — each stage on its own row with its turn range
    function stageLoss(s) { return s.n ? (-s.skill / s.n).toFixed(1) : '0.0'; }
    var e = fa.stages.early, mid = fa.stages.mid, lt = fa.stages.late;
    function rng(start, len) { return len > 0 ? ' (ход ' + start + '–' + (start + len - 1) + ')' : ''; }
    html += statRows('По етапи', RC.stage, [
      'начало' + rng(1, e.n) + ' — <b class="nn">' + stageLoss(e) + '</b> т./ход',
      'среда' + rng(1 + e.n, mid.n) + ' — <b class="nn">' + stageLoss(mid) + '</b> т./ход',
      'край' + rng(1 + e.n + mid.n, lt.n) + ' — <b class="nn">' + stageLoss(lt) + '</b> т./ход' ]);

    // player's end-game scorecard (collapsed by default) — exact board at a glance.
    // categories where THIS player holds the highest result show the points in their colour.
    var recKeys = {};
    if (summary.meta && summary.meta.board) summary.meta.board.forEach(function (b) { if (b.recPi === pi && b.recVal > 0) recKeys[b.key] = 1; });
    html += '<details class="evboard"><summary>Дъска</summary>' + replayBoardHTML(fp.scores, null, { color: fp.color, recordKeys: recKeys }) + '</details>';

    // §7 turn-by-turn breakdown. Row: [Хn][combo] | [points][luck/decision EV][quality thumb].
    // tapping a row folds its dice throws in/out; the first turn's dice show by default (a hint they exist).
    html += '<details class="evturns"><summary>Ход по ход</summary>';
    fa.turns.forEach(function (td, ti) {
      var q = turnQuality(td.skill);
      var genRow = td.category === 'general' && td.score > 0;   // Генерал rolled — flag the event
      var forfeit = td.score === 0;                              // нулирана/жертвана комбинация
      // luck then decision (no letters; left = късмет, right = избор)
      var ev = '<span class="tev">' + (fa.manual ? '' : '<span class="tl xterm" data-x="ev" title="късмет (EV)">' + evNum(td.luck) + '</span>')
        + '<span class="tl xterm" data-x="ev" title="избор (EV)">' + evNum(td.skill) + '</span></span>';
      var dice = turnDiceHTML(pi, td, fa.manual, ti !== 0);   // first turn open; the rest collapsed
      html += '<div class="evtrow ' + q.cls + (genRow ? ' q-general' : '') + (dice ? ' clik' : '') + '">'
        + '<span class="tn">Х' + (td.turn + 1) + '</span>'
        + '<span class="tc' + (forfeit ? ' forfeit' : '') + '">' + esc(sumLabel(td.category)) + '</span>'
        + '<span class="tv">' + td.score + ' т.</span>'
        + ev
        + qualityIcon(td.skill, pi, td.turn) + '</div>'
        + dice;
    });
    html += '</details>';

    html += '</div>';
    return html;
  }

  function decisionLabel(d) {
    if (d.type === 'category') {
      return 'игра ' + (sumLabel(d.chosenKey))
        + (d.chosenKey !== d.optimalKey ? ' (по-добре ' + (sumLabel(d.optimalKey)) + ')' : '');
    }
    return 'задържане на заровете';
  }

  // §1.8 DA-16 — collapse the leak/blunder/stage diagnostics into ONE prescription
  function coachLine(fa) {
    if (fa.accuracy >= 0.93) return '🎯 Малко за пипане — решенията ти са почти оптимални.';
    var what;
    if (!fa.manual && fa.leak.keep < fa.leak.category - 0.5) what = 'задържането на заровете';
    else if (fa.manual || fa.leak.category < fa.leak.keep - 0.5) what = 'избора на категория';
    else what = 'дребните решения';
    var stages = [['началото', fa.stages.early], ['средата', fa.stages.mid], ['края', fa.stages.late]], worst = null;
    stages.forEach(function (s) { if (s[1].n) { var l = -s[1].skill / s[1].n; if (!worst || l > worst.l) worst = { name: s[0], l: l }; } });
    var where = worst && worst.l > 0.6 ? ', особено в ' + worst.name : '';
    return '🎯 Поработи над: <b>' + what + '</b>' + where + '.';
  }

