'use strict';
// Archive & history: saved games, replay viewer, career charts, battle calendar.
  // ============================================================ ARCHIVE / HISTORY
  var viewingHistory = false, histSnapshot = null, dossierCtx = null, currentHistRec = null;

  function recIsExp(rec) { return !!(rec && rec.ruleset === 'experimental'); }
  // local vs network game. New records carry an explicit `net` flag; for older ones we infer it:
  // a networked game recorded remote players' fill order with a `remote` marker, and (standard
  // ruleset) left every player's bet empty — local games always carry a random bet.
  function recIsNet(rec) {
    if (!rec) return false;
    if (typeof rec.net === 'boolean') return rec.net;
    var ml = rec.moveLog;
    if (ml && ml.some && ml.some(function (log) { return log && log.some && log.some(function (m) { return m && m.remote; }); })) return true;
    var ps = rec.players;
    if (ps && ps.length && ps.every(function (p) { return p.bet === ''; })) return true;
    return false;
  }
  // per-player total, ALWAYS computed per the record's ruleset (so scoring-rule fixes — e.g. the
  // minus −50 — apply to old saves too, and the entry matches the details view). The stored `pts`
  // is only a fallback for legacy standard records.
  function recTotal(sp, isExp) {
    if (isExp) return G.playerTotalExp(sp);   // ruleset-aware: number part (incl. −50 if negative) + combos
    if (typeof sp.pts === 'number') return sp.pts;
    var t = 0; G.CATEGORIES.forEach(function (c) { var v = sp.scores[c.key]; if (typeof v === 'number') t += v; }); return t + (sp.bonus || 0);
  }
  function recPlacement(rec, i) { var ex = recIsExp(rec), me = recTotal(rec.players[i], ex); var ahead = 0; rec.players.forEach(function (p, j) { if (j !== i && recTotal(p, ex) > me) ahead++; }); return ahead + 1; }
  function recOwnerIdx(rec) { if (rec.ownerSkipped) return -1; for (var i = 0; i < rec.players.length; i++) if (rec.players[i].owner) return i; return 0; } // -1: owner skipped; legacy: seat 0
  // a game counts toward victories / win-rate only when it had MORE THAN ONE player and a
  // known placement. Single-player games (regular or manual) are unranked — they still feed
  // the averages (personal best, playstyle), just not the win stats. A manual game can be
  // annotated by the owner (rec.mpResult) to declare it was multiplayer + their placement.
  function gameRanking(rec) {
    var oi = recOwnerIdx(rec), mp = rec.mpResult;
    if (mp && typeof mp.place === 'number') return { ranked: true, place: mp.place };
    if (mp && mp.solo) return { ranked: false, place: null };
    if (oi >= 0 && rec.players.length > 1) return { ranked: true, place: recPlacement(rec, oi) };
    return { ranked: false, place: null };
  }
  function analyzeRec(rec, i) {
    if (rec.ruleset === 'experimental') return null;     // analysed separately (analyzeGameExp), never by the standard engine
    var log = rec.moveLog && rec.moveLog[i];
    if (!evReady || !log || !log.length) return null;
    try { return rec.manualMode ? EV.analyzeManualGame(log) : EV.analyzeGame(log); } catch (e) { return null; }
  }
  function fmtDate(ts) { var d = new Date(ts), p = function (x) { return (x < 10 ? '0' : '') + x; }; return p(d.getDate()) + '/' + p(d.getMonth() + 1) + '/' + d.getFullYear(); }
  function fmtTime(ts) { var d = new Date(ts), p = function (x) { return (x < 10 ? '0' : '') + x; }; return p(d.getHours()) + ':' + p(d.getMinutes()); }

  // reconstruct a saved game into the live state and show its end-game summary
  function reconstructPlayers(rec) {
    return rec.players.map(function (sp) {
      var pl = G.createPlayer(sp.name, sp.color, sp.isAI);
      pl.gender = sp.gender || 'm'; pl.bet = sp.bet; pl.scores = sp.scores || {}; pl.bonus = sp.bonus || 0; pl.ribbons = sp.ribbons || RIBBON_COLORS; pl.owner = !!sp.owner;
      if (!sp.isAI) { pl.selectKeep = (typeof sp.selectKeep === 'boolean') ? sp.selectKeep : !!settings.selectKeep; pl.diceBatch = (typeof sp.diceBatch === 'boolean') ? sp.diceBatch : !!settings.newDiceBatch; }
      if (sp.isAI && sp.personaId) pl.persona = G.personaById(sp.personaId);
      return pl;
    });
  }
  function openHistoryGame(rec) {
    histSnapshot = { game: game, moveLog: moveLog, manualMode: manualMode, summary: summary, undo: undoStack };
    viewingHistory = true;
    game = { players: reconstructPlayers(rec), current: 0, round: 1, ruleset: rec.ruleset };   // ruleset drives total()/summary
    moveLog = rec.moveLog || game.players.map(function () { return []; });
    manualMode = !!rec.manualMode; undoStack = [];
    var top = Math.max.apply(null, game.players.map(total));
    var winner = game.players.filter(function (p) { return total(p) === top; })[0];
    $('historyModal').classList.add('hidden'); $('calModal').classList.add('hidden');
    showGameOver(winner);
    // §2.5 dossier context: viewing a PAST owner game → annotate its report with deltas
    var oi = recOwnerIdx(rec);
    dossierCtx = (oi >= 0 && !rec.players[oi].isAI) ? { ownerPi: oi, career: computeOwnerCareer(rec.ruleset) } : null;
    currentHistRec = rec;
    setOverTitle();   // editable title + date/time subline for the archived battle
    $('playAgain').classList.add('hidden'); $('overUndo').classList.add('hidden');
  }
  function exitHistoryGame(toArchive) {
    $('overModal').classList.add('hidden');
    $('playAgain').classList.remove('hidden');
    if (histSnapshot) { game = histSnapshot.game; moveLog = histSnapshot.moveLog; manualMode = histSnapshot.manualMode; summary = histSnapshot.summary; undoStack = histSnapshot.undo; histSnapshot = null; }
    viewingHistory = false; dossierCtx = null;
    if (toArchive) showHistory();   // back to the archive, keeping the tab + loaded games
  }
  // the header ✕ closes the summary: back to the archive when reviewing history,
  // otherwise (a live end screen) back to the muster
  $('overClose').onclick = function () {
    if (viewingHistory) { exitHistoryGame(true); return; }
    $('overModal').classList.add('hidden'); $('game').classList.add('hidden'); $('setup').classList.remove('hidden');
  };

  // ---------- §8 replay viewer (turn-by-turn + roll-by-roll, scrubbable) ----------
  var replay = null;
  // reconstruct each throw's per-die generation (the throw it was last rolled in) from the saved
  // keep masks, so the summary can group dice the same way „Нов набор зарове" does live. Generations
  // are carried across throws by value-matching the kept dice; remaining dice are this throw's batch.
  function replayGens(rolls, keeps) {
    var gens = [];
    for (var i = 0; i < rolls.length; i++) {
      var cur = rolls[i] || [];
      if (i === 0) { gens.push(cur.map(function () { return 1; })); continue; }
      var prev = rolls[i - 1] || [], prevGen = gens[i - 1] || [], km = keeps[i - 1] || [];
      var pool = [];
      for (var j = 0; j < prev.length; j++) if (km[j]) pool.push({ v: prev[j], g: prevGen[j] || 1, used: false });
      gens.push(cur.map(function (v) {
        for (var k = 0; k < pool.length; k++) if (!pool[k].used && pool[k].v === v) { pool[k].used = true; return pool[k].g; }
        return i + 1;   // not carried over → newly rolled this throw
      }));
    }
    return gens;
  }
  // flatten a saved game into atomic actions in true play order (round-robin)
  function buildReplayActions(rec) {
    var actions = [], nP = rec.players.length, R = G.CATEGORIES.length;
    for (var r = 0; r < R; r++) {
      for (var p = 0; p < nP; p++) {
        var log = rec.moveLog[p] && rec.moveLog[p][r];
        if (!log) continue;
        var score = rec.players[p].scores[log.category];
        if (rec.manualMode) {
          actions.push({ type: 'roll', p: p, r: r, dice: log.dice || [], kept: null, rollNo: 1, rolls: 1 });
          actions.push({ type: 'commit', p: p, r: r, category: log.category, score: score, dice: log.dice || [] });
        } else {
          var rolls = log.rolls || [], gens = replayGens(rolls, log.keeps || []);
          for (var i = 0; i < rolls.length; i++) {
            // remember BOTH the kept set and the re-thrown set for this throw; renderReplay
            // highlights whichever matches the game's dice-selection flavour (keep vs throw)
            var last = i === rolls.length - 1;
            var keep = (!last && log.keeps[i]) ? log.keeps[i].slice() : null;
            var reroll = keep ? keep.map(function (k) { return !k; }) : null;
            actions.push({ type: 'roll', p: p, r: r, dice: rolls[i], reroll: reroll, keep: keep, gens: gens[i], rollNo: i + 1, rolls: rolls.length });
          }
          actions.push({ type: 'commit', p: p, r: r, category: log.category, score: score, dice: rolls.length ? rolls[rolls.length - 1] : [], gens: rolls.length ? gens[rolls.length - 1] : null });
        }
      }
    }
    return actions;
  }
  function rpStateAt(idx) {
    var sc = replay.rec.players.map(function () { return {}; });
    for (var k = 0; k <= idx; k++) { var a = replay.actions[k]; if (a.type === 'commit') sc[a.p][a.category] = a.score; }
    return sc;
  }
  function replayBoardHTML(scores, hlKey, opts) {
    var recKeys = (opts && opts.recordKeys) || null, myCol = opts && opts.color;
    function tile(c, up) {
      var f = typeof scores[c.key] === 'number', hl = c.key === hlKey ? ' hl' : '';
      var ff = f && scores[c.key] === 0 ? ' forfeit' : '';   // a sacrificed (0) cell is greyed out
      var isRec = f && recKeys && recKeys[c.key];             // this player holds the highest result here
      // record accent: an inward glow + inset ring in the player's colour (reads clearly on the small cell)
      var mstyle = isRec && myCol ? ' style="box-shadow:inset 0 0 9px 1px ' + rgba(myCol, 0.75) + ', inset 0 0 0 1.6px ' + rgba(myCol, 0.6) + '"' : '';
      return '<div class="mtile ' + (up ? 'up' : 'low') + (f ? '' : ' empty') + hl + ff + (isRec ? ' rec' : '') + '"' + mstyle + '><span class="mlab">' + c.label + '</span><span class="mval">' + (f ? scores[c.key] + 'т.' : '–') + '</span></div>';
    }
    var up = G.CATEGORIES.filter(function (c) { return c.group === 'upper'; }).map(function (c) { return tile(c, true); }).join('');
    var low = G.CATEGORIES.filter(function (c) { return c.group === 'lower'; }).map(function (c) { return tile(c, false); }).join('');
    return '<div class="miniboard"><div class="upper">' + up + '</div><div class="lower">' + low + '</div></div>';
  }
  function renderReplay() {
    var a = replay.actions[replay.idx], rec = replay.rec, sc = rpStateAt(replay.idx), pl = rec.players[a.p];
    var run = 0; G.CATEGORIES.forEach(function (c) { if (typeof sc[a.p][c.key] === 'number') run += sc[a.p][c.key]; });
    $('rpName').innerHTML = (pl.owner ? ownerTokenHTML(true) : '') + esc(pl.name);
    $('replayBoard').innerHTML = replayBoardHTML(sc[a.p], a.type === 'commit' ? a.category : null);
    // highlight the dice this game's flavour marks: keep-mode → held; throw-mode → re-thrown
    var keepMode = !!rec.selectKeep, hlMask = keepMode ? a.keep : a.reroll;
    var batchMode = !!settings.newDiceBatch;
    if (batchMode) {
      // group by generation: kept dice (older) left → freshly-rolled batch right, ordered, with dividers
      var dArr = a.dice || [], gArr = (a.gens && a.gens.length === dArr.length) ? a.gens : dArr.map(function () { return 1; });
      var pairs = dArr.map(function (v, i) { return { v: v, g: gArr[i] }; }).sort(function (x, y) { return (x.g - y.g) || (x.v - y.v); });
      $('replayDice').innerHTML = pairs.map(function (pr, i) {
        return (i > 0 && pr.g !== pairs[i - 1].g ? '<span class="rpdie-sep" aria-hidden="true"></span>' : '') + '<div class="rpdie">' + pipFace(pr.v) + '</div>';
      }).join('');
    } else {
      $('replayDice').innerHTML = (a.dice || []).map(function (v, i) {
        return '<div class="rpdie' + (hlMask && hlMask[i] ? (keepMode ? ' kept' : ' rr') : '') + '">' + pipFace(v) + '</div>';
      }).join('');
    }
    // Х{ход}/14 · {етап} · точки — with a ? that explains the highlight
    var stage = a.type === 'commit' ? 'записване'
      : a.rollNo === 1 ? 'начално хвърляне' : a.rollNo === 2 ? 'второ хвърляне' : a.rollNo === 3 ? 'трето хвърляне' : 'хвърляне ' + a.rollNo;
    $('rpLabel').innerHTML = '<button id="rpDiceQ" class="rpdiceq" title="Какво означават маркираните зарове?">?</button>'
      + '<b>Х' + (a.r + 1) + '/' + G.CATEGORIES.length + '</b> · ' + stage + ' · ' + (run + (pl.bonus || 0)) + ' т.';
    $('rpDiceQ').onclick = function (e) {
      e.stopPropagation();
      var help = $('rpDiceHelp');
      help.innerHTML = batchMode
        ? '🎲 Заровете са подредени по <b>хвърляне</b>: задържаните отляво, новохвърлените отдясно (разделени с черта), всяка група подредена. Така веднага виждаш кои са новите.'
        : keepMode
        ? '🎲 <b>Маркираните</b> зарове са тези, които играчът <b>задържа</b> (избор „кои да държиш“). Останалите се хвърлят наново.'
        : '🎲 <b>Маркираните</b> зарове са тези, които играчът <b>хвърля наново</b> (избор „кои да хвърлиш“). Останалите се пазят.';
      help.classList.toggle('hidden');
    };
    $('rpSlider').value = String(replay.idx);
  }
  // speed gears: a modifier over the 1 s/move base; click cycles to the next gear
  var RP_BASE = 1000, RP_GEARS = [
    { mod: 0.5, color: '#6fa8e8' }, { mod: 1, color: '#ffffff' }, { mod: 1.5, color: '#9bd17e' },
    { mod: 2, color: '#e8b06a' }, { mod: 4, color: '#e8807a' },
  ];
  function syncSpeedBtn() {
    var g = RP_GEARS[replay.gear];
    replay.speed = RP_BASE / g.mod;
    var b = $('rpSpeed'); b.textContent = 'x' + g.mod; b.style.color = g.color;
  }
  // filter menu: All + one entry per player; selecting filters to that player's turns
  function buildFilterMenu() {
    var html = '<button class="rpfopt' + (replay.filter < 0 ? ' on' : '') + '" data-f="-1">Всички</button>';
    replay.rec.players.forEach(function (p, i) {
      html += '<button class="rpfopt' + (replay.filter === i ? ' on' : '') + '" data-f="' + i + '"><span class="rpfdot" style="background:' + p.color + '"></span>' + esc(p.name) + '</button>';
    });
    $('rpFilterMenu').innerHTML = html;
    $('rpFilterMenu').querySelectorAll('.rpfopt').forEach(function (b) {
      b.onclick = function () { setReplayFilter(+b.getAttribute('data-f')); $('rpFilterMenu').classList.add('hidden'); };
    });
  }
  function setReplayFilter(f) {
    replay.filter = f;
    replay.actions = f < 0 ? replay.all.slice() : replay.all.filter(function (a) { return a.p === f; });
    if (!replay.actions.length) replay.actions = replay.all.slice(), replay.filter = -1;
    replay.idx = 0; rpPause();
    $('rpSlider').max = String(rpLast());
    $('rpFilterBtn').classList.toggle('filtered', replay.filter >= 0);
    renderReplay();
  }
  function rpLast() { return replay.actions.length - 1; }
  function rpPause() { replay.playing = false; $('rpPlay').classList.remove('playing'); clearTimeout(replay.timer); }
  function rpSchedule() {
    clearTimeout(replay.timer);
    replay.timer = setTimeout(function () {
      if (!replay.playing) return;
      if (replay.idx < rpLast()) { replay.idx++; renderReplay(); rpSchedule(); } else rpPause();
    }, replay.speed);
  }
  function rpPlay() {
    if (replay.idx >= rpLast()) replay.idx = 0;
    replay.playing = true; $('rpPlay').classList.add('playing'); renderReplay(); rpSchedule();
  }
  function openReplay(rec) {
    var actions = buildReplayActions(rec);
    if (!actions.length) return;
    $('historyModal').classList.add('hidden');
    replay = { rec: rec, all: actions, actions: actions.slice(), idx: 0, timer: null, playing: false, gear: 1, filter: -1 };
    syncSpeedBtn();
    buildFilterMenu();
    $('rpFilterBtn').classList.remove('filtered');
    $('rpFilterMenu').classList.add('hidden');
    $('rpSlider').max = String(rpLast());
    $('replayModal').classList.remove('hidden');
    rpPlay(); // auto-start
  }
  $('rpPlay').onclick = function () { if (replay.playing) rpPause(); else rpPlay(); };
  $('rpRestart').onclick = function () { replay.idx = 0; rpPause(); renderReplay(); };
  $('rpStepF').onclick = function () { rpPause(); if (replay.idx < rpLast()) { replay.idx++; renderReplay(); } };
  $('rpStepB').onclick = function () { rpPause(); if (replay.idx > 0) { replay.idx--; renderReplay(); } };
  $('rpSlider').oninput = function () { rpPause(); replay.idx = +$('rpSlider').value; renderReplay(); };
  // speed control: tap cycles to the next gear; swipe right = faster, left = slower (clamped)
  (function () {
    var b = $('rpSpeed'), sx = null;
    b.addEventListener('pointerdown', function (e) { sx = e.clientX; try { b.setPointerCapture(e.pointerId); } catch (x) {} });
    b.addEventListener('pointerup', function (e) {
      if (!replay) { sx = null; return; }
      var dx = sx == null ? 0 : e.clientX - sx, n = RP_GEARS.length; sx = null;
      if (Math.abs(dx) > 18) replay.gear = Math.max(0, Math.min(n - 1, replay.gear + (dx > 0 ? 1 : -1)));  // swipe → step one gear
      else replay.gear = (replay.gear + 1) % n;                                                            // tap → cycle
      syncSpeedBtn(); if (replay.playing) rpSchedule();
    });
    b.addEventListener('pointercancel', function () { sx = null; });
  })();
  $('rpFilterBtn').onclick = function (e) { e.stopPropagation(); buildFilterMenu(); $('rpFilterMenu').classList.toggle('hidden'); };
  document.addEventListener('click', function (e) { if (!$('rpFilterMenu').classList.contains('hidden') && !$('replayInfo').contains(e.target)) $('rpFilterMenu').classList.add('hidden'); });
  // click OUTSIDE the colour popover (and not on a colour button) closes it — target-aware
  // so the very tap that opens it can't also close it on devices where stopPropagation slips
  document.addEventListener('click', function (e) {
    var pop = $('colorPop'); if (pop.classList.contains('hidden')) return;
    var t = e.target;
    if (pop.contains(t)) return;                                   // a swatch — its own handler picks
    if (t && t.closest && (t.closest('.cbtn') || t.closest('#netMeColor'))) return;  // a colour button — its handler toggles
    hideColorPop();
  });
  // tap outside a medal badge / its bubble closes the medal explainer
  document.addEventListener('click', function (e) {
    var g = $('medalTip'); if (g.classList.contains('hidden')) return;
    var t = e.target;
    if (g.contains(t) || (t && t.closest && (t.closest('.wbadge') || t.closest('.xterm')))) return;
    g.classList.add('hidden');
  });
  // tap outside the throw/keep chooser (and not on the ? button) closes it
  document.addEventListener('click', function (e) {
    var g = $('keepThrowTip'); if (g.classList.contains('hidden')) return;
    var t = e.target;
    if (g.contains(t) || (t && t.closest && t.closest('#fireQ'))) return;
    g.classList.add('hidden');
  });
  // tapping outside the owner-token bubble dismisses it (the star's own tap stops propagation)
  document.addEventListener('click', function (e) {
    var b = $('ownerInfo'); if (!b || b.classList.contains('hidden')) return;
    var t = e.target;
    if (b.contains(t) || (t && t.closest && t.closest('.ownerstar'))) return;
    b.classList.add('hidden');
  });
  // changing focus away from the window dismisses transient popovers/explainers — but NOT while the
  // network host/join flow is open (a focus change there must not disturb its view)
  function dismissTransients() {
    if (!$('netModal').classList.contains('hidden')) return;
    ['comboTip', 'fxBubble', 'guideTip', 'ownerInfo', 'colorPop', 'rpFilterMenu', 'medalTip', 'keepThrowTip'].forEach(function (id) {
      var el = document.getElementById(id); if (el) el.classList.add('hidden');
    });
  }
  window.addEventListener('blur', dismissTransients);
  document.addEventListener('visibilitychange', function () { if (document.hidden) dismissTransients(); });
  // lock the page behind any open overlay so only the panel itself scrolls
  (function () {
    function syncModalLock() { document.body.classList.toggle('modal-open', !!document.querySelector('.overlay:not(.hidden)')); }
    var mo = new MutationObserver(syncModalLock);
    document.querySelectorAll('.overlay').forEach(function (o) { mo.observe(o, { attributes: true, attributeFilter: ['class'] }); });
    syncModalLock();
  })();
  function closeReplay() { if (replay) rpPause(); $('replayModal').classList.add('hidden'); showHistory(); }   // keep the tab + loaded games
  $('replayClose').onclick = closeReplay;
  $('replayModal').onclick = function (e) { if (e.target === $('replayModal')) closeReplay(); };

  // owner trends: aggregate the flagged owner (when human) across games
  function stdev(arr, mean) {
    if (arr.length < 2) return 0;
    var v = arr.reduce(function (s, x) { return s + (x - mean) * (x - mean); }, 0) / (arr.length - 1);
    return Math.sqrt(v);
  }
  // least-squares slope of ys against their index (per-game trend); null if too few
  function trendSlope(ys) {
    var k = ys.length; if (k < 3) return null;
    var sx = 0, sy = 0, sxx = 0, sxy = 0;
    ys.forEach(function (y, i) { sx += i; sy += y; sxx += i * i; sxy += i * y; });
    var den = k * sxx - sx * sx; return den ? (k * sxy - sx * sy) / den : 0;
  }
  // §2 owner dossier aggregates (cached per render). Reduces the per-category cube
  // across the owner's games; honours ownerSkipped + AI exactly like the old overview.
  function computeOwnerCareer(rs) {
    rs = rs || 'standard'; var isExp = rs === 'experimental', CATS = isExp ? G.CATEGORIES_EXP : G.CATEGORIES;
    var games = loadHistory();
    // games flagged via the ranking-marker toggle are kept in the list but pulled out
    // of every career aggregate (and the percentile distribution derived from it)
    var owned = games.filter(function (r) { if (r.excluded) return false; if ((r.ruleset === 'experimental') !== isExp) return false; var oi = recOwnerIdx(r); if (oi < 0) return false; var o = r.players[oi]; return o && !o.isAI; });
    var data = owned.map(function (r) {
      var oi = recOwnerIdx(r), o = r.players[oi];
      var ana = isExp ? ((r.moveLog && r.moveLog[oi]) ? (r.manualMode ? analyzeManualGameExp(r.moveLog[oi]) : analyzeGameExp(r.moveLog[oi])) : null) : analyzeRec(r, oi);
      var rk = gameRanking(r);
      var item = { rec: r, ana: ana, total: recTotal(o, isExp), ranked: rk.ranked, place: rk.place, n: r.players.length,
               general: (o.scores.general || 0) > 0, name: o.name, manual: !!r.manualMode };
      if (isExp) { item.secUpper = G.upperStateExp(o.scores).contribution; item.secLower = 0; CATS.forEach(function (c) { if (c.group === 'lower' && typeof o.scores[c.key] === 'number') item.secLower += o.scores[c.key]; }); }
      return item;
    });
    if (!data.length) return null;
    // points & score averages count EVERY owned game of this ruleset (incl. network games, even
    // legacy ones without a recorded move log); skill/luck use only the games we could analyse.
    var anaData = data.filter(function (d) { return d.ana; });
    if (!anaData.length) return null;   // the dossier needs at least one analysable game for its stats
    var n = data.length;
    var scores = data.map(function (d) { return d.total; });
    var avgScore = scores.reduce(function (s, x) { return s + x; }, 0) / n;
    var avgAcc = anaData.length ? anaData.reduce(function (s, d) { return s + d.ana.accuracy; }, 0) / anaData.length : 0;
    var diceData = anaData.filter(function (d) { return !d.manual; });
    // §2.1 per-category mastery: reduce byCategory across games
    var cat = {};
    CATS.forEach(function (c) { cat[c.key] = { key: c.key, label: c.label, fills: 0, hits: 0, sum: 0, rec: 0, leak: 0 }; });
    anaData.forEach(function (d) {
      var bc = d.ana.byCategory || {};
      Object.keys(bc).forEach(function (k) {
        var cell = bc[k], t = cat[k]; if (!t) return;
        t.fills++; if (cell.score > 0) { t.hits++; t.sum += cell.score; } if (cell.score > t.rec) t.rec = cell.score; t.leak += cell.leak;
      });
    });
    var catList = CATS.map(function (c) {
      var t = cat[c.key];
      return { key: c.key, label: c.label, fills: t.fills, hitRate: t.fills ? t.hits / t.fills : 0,
               avg: t.hits ? t.sum / t.hits : 0, rec: t.rec, avgLeak: t.fills ? t.leak / t.fills : 0 };
    }).filter(function (c) { return c.fills; });
    // averages of every per-player report stat — updated as more games are played
    function mean(get, dice) { var a = (dice ? diceData : anaData).map(get).filter(function (v) { return typeof v === 'number'; }); return a.length ? a.reduce(function (s, x) { return s + x; }, 0) / a.length : null; }
    function stageLoss(s) { return s.n ? -s.skill / s.n : 0; }
    var report = {
      secUpper: isExp ? mean(function (d) { return d.secUpper; }) : null, secLower: isExp ? mean(function (d) { return d.secLower; }) : null,
      luck: mean(function (d) { return d.ana.luck; }, true), skill: mean(function (d) { return d.ana.skill; }),
      lostPerTurn: mean(function (d) { return d.ana.avgLostPerTurn; }),
      leakKeep: mean(function (d) { return d.ana.leak.keep; }, true), leakCat: mean(function (d) { return d.ana.leak.category; }),
      sevMinor: mean(function (d) { return d.ana.severity.minor; }), sevMajor: mean(function (d) { return d.ana.severity.major; }), sevFatal: mean(function (d) { return d.ana.severity.fatal; }),
      zeroTotal: mean(function (d) { return d.ana.zeroOuts.total; }), zeroForced: mean(function (d) { return d.ana.zeroOuts.forced; }), zeroUnforced: mean(function (d) { return d.ana.zeroOuts.unforced; }),
      luckFirst: mean(function (d) { return d.ana.luckFirst; }, true), luckRerolls: mean(function (d) { return d.ana.luckRerolls; }, true), clutch: mean(function (d) { return d.ana.clutch; }, true),
      stageEarly: mean(function (d) { return stageLoss(d.ana.stages.early); }), stageMid: mean(function (d) { return stageLoss(d.ana.stages.mid); }), stageLate: mean(function (d) { return stageLoss(d.ana.stages.late); }),
    };
    // keep-pattern metrics aggregated across every owned dice game (manual logs contribute nothing)
    var ownerLogs = data.map(function (d) { return d.rec.moveLog && d.rec.moveLog[recOwnerIdx(d.rec)]; });
    report.throwKeep = throwKeepDist(ownerLogs); report.diceKeep = diceKeepDist(ownerLogs); report.diceDrop = diceDropDist(ownerLogs);
    // victories / win-rate / average place are over RANKED games only (>1 player, known place)
    var rankedPlaces = data.filter(function (d) { return d.ranked; }).map(function (d) { return d.place; });
    var rankedN = rankedPlaces.length;
    return {
      data: data, anaData: anaData, n: n, dice: diceData.length, scores: scores, avgScore: avgScore, scoreSd: stdev(scores, avgScore),
      avgAcc: avgAcc, accSd: stdev(anaData.map(function (d) { return d.ana.accuracy * 100; }), avgAcc * 100),
      accSlope: trendSlope(anaData.map(function (d) { return d.ana.accuracy * 100; })),
      wins: rankedPlaces.filter(function (p) { return p === 1; }).length, rankedN: rankedN,
      best: Math.max.apply(null, scores), worst: Math.min.apply(null, scores), avgPlace: rankedN ? rankedPlaces.reduce(function (s, p) { return s + p; }, 0) / rankedN : null,
      generals: data.filter(function (d) { return d.general; }).length,
      avgLuck: diceData.length ? diceData.reduce(function (s, d) { return s + d.ana.luck; }, 0) / diceData.length : null,
      catList: catList, report: report, ruleset: rs,
    };
  }

  // ----- §2.7 per-battle career charts (points / skill / luck over recent games) -----
  // Each game contributes one point. Games that don't record a stat (e.g. luck in a
  // manual game) draw a dashed grey HOLD at the previous value; colour resumes from
  // that held value when the next recording game arrives. Line colour = owner colour.
  var ownerCharts = null;          // { points:{…}, skill:{…}, luck:{…} } meta for the scrubber
  var OC_N = 20;                   // last N battles per chart
  function ownerChartSeries(data, kind) {
    return data.slice(-OC_N).map(function (d) {
      var v = kind === 'points' ? d.total
            : kind === 'skill' ? (d.ana ? d.ana.accuracy * 100 : null)
            : (d.manual || !d.ana ? null : d.ana.luck);        // luck is dice-only; unanalysed games hold
      return { ts: d.rec.ts, name: d.rec.name, val: (typeof v === 'number' && isFinite(v)) ? v : null };
    });
  }
  function makeOwnerChart(kind, games, color) {
    var n = games.length, firstRel = -1;
    for (var i = 0; i < n; i++) if (games[i].val != null) { firstRel = i; break; }
    if (firstRel < 0 || n < 2) return null;                    // nothing meaningful to plot
    var luck = kind === 'luck', suffix = kind === 'skill' ? '%' : '';
    // carry the last recorded value forward across gaps (and back over a leading gap)
    var yv = new Array(n), last = games[firstRel].val;
    for (var j = 0; j < n; j++) { if (games[j].val != null) last = games[j].val; yv[j] = last; }
    var yMin = Infinity, yMax = -Infinity;
    yv.forEach(function (v) { if (v < yMin) yMin = v; if (v > yMax) yMax = v; });
    if (luck) { yMin = Math.min(0, yMin); yMax = Math.max(0, yMax); }
    if (kind === 'skill') { yMax = 100; yMin = Math.max(0, Math.min(yMin, 99)); }
    if (yMin === yMax) yMax = yMin + 1;
    var W = 300, H = 128, padL = 30, padR = 8, padT = 10, padB = 26, iw = W - padL - padR, ih = H - padT - padB, range = yMax - yMin || 1;
    var xfn = function (i) { return padL + (n > 1 ? i / (n - 1) * iw : iw / 2); };
    var yfn = function (v) { return padT + ih - (v - yMin) / range * ih; };
    var gvals = luck ? [yMax, 0, yMin] : [yMax, (yMin + yMax) / 2, yMin];
    var grid = gvals.map(function (gv) {
      var yy = yfn(gv);
      return '<line x1="' + padL + '" y1="' + yy + '" x2="' + (W - padR) + '" y2="' + yy + '" class="oc-grid' + (luck && gv === 0 ? ' zero' : '') + '"/>'
        + '<text x="' + (padL - 4) + '" y="' + (yy + 3) + '" class="oc-axis" text-anchor="end">' + (luck && gv > 0 ? '+' : '') + Math.round(gv) + suffix + '</text>';
    }).join('');
    var segs = '';
    for (var k = 1; k < n; k++) {
      var rel = games[k].val != null;
      segs += '<line x1="' + xfn(k - 1) + '" y1="' + yfn(yv[k - 1]) + '" x2="' + xfn(k) + '" y2="' + yfn(yv[k]) + '" '
        + 'stroke="' + (rel ? color : 'var(--gen-muted)') + '" stroke-width="' + (rel ? 2.2 : 1.6) + '" stroke-opacity="' + (rel ? 1 : 0.55) + '"'
        + (rel ? '' : ' stroke-dasharray="3 3"') + ' stroke-linecap="round" stroke-linejoin="round"/>';
    }
    var dots = '';
    for (var m = 0; m < n; m++) {
      var r2 = games[m].val != null;
      dots += '<circle cx="' + xfn(m) + '" cy="' + yfn(yv[m]) + '" r="' + (r2 ? 2.4 : 1.6) + '" fill="' + (r2 ? color : 'var(--gen-muted)') + '"/>';
    }
    // x-axis: game numbers (1..n) in sequence + an „игра" label at the start (like „ход" on per-turn charts)
    var xticks = '', per = iw / (n - 1 || 1), step = per >= 13 ? 1 : Math.ceil(13 / per);
    for (var t = 0; t < n; t += step) xticks += '<text x="' + xfn(t) + '" y="' + (H - 6) + '" class="oc-axis" text-anchor="middle">' + (t + 1) + '</text>';
    xticks += '<text x="2" y="' + (H - 6) + '" class="oc-axis" text-anchor="start">игра</text>';
    return { kind: kind, games: games, yv: yv, color: color, suffix: suffix, luck: luck,
             W: W, H: H, padL: padL, padT: padT, iw: iw, ih: ih, n: n, xfn: xfn, yfn: yfn,
             svg: grid + segs + dots + xticks + '<g class="oc-scrub"></g>' };
  }
  function buildOwnerCharts(c, grp) {
    grp = grp || 'std';
    if (!c || c.data.length < 2) return '';
    if (!ownerCharts) ownerCharts = {};                 // accumulate across groups (std + exp)
    var color = settings.ownerColor || '#d4a02e';
    var defs = [['points', 'Точки', 'точки'], ['skill', 'Точност', 'умение'], ['luck', 'Късмет', 'късмет']];
    var tabs = '', cards = '', first = true;
    defs.forEach(function (d) {
      var ch = makeOwnerChart(d[0], ownerChartSeries(c.data, d[0]), color);
      if (!ch) return;
      var id = grp + ':' + d[0];                         // namespaced so the two dossier cards don't collide
      ownerCharts[id] = ch;
      var title = d[2] + ' последните ' + ch.n + ' игри';
      tabs += '<button type="button" class="oc-tab' + (first ? ' on' : '') + '" data-kind="' + id + '">' + d[1] + '</button>';
      cards += '<div class="ocard' + (first ? '' : ' hidden') + '" data-card="' + id + '">'
        + '<div class="oc-title">' + title + '</div>'
        + '<div class="oc-wrap"><svg viewBox="0 0 ' + ch.W + ' ' + ch.H + '" class="oc-svg" data-kind="' + id + '" preserveAspectRatio="xMidYMid meet">'
        + ch.svg + '</svg><div class="oc-readout hidden"></div></div></div>';
      first = false;   // only the first chart is shown by default
    });
    return tabs ? ('<div class="ocharts"><div class="oc-tabs">' + tabs + '</div>' + cards + '</div>') : '';
  }
  // attach the drag-to-scrub reader to each career chart (after its SVG is in the DOM)
  function wireOwnerCharts() {
    if (!ownerCharts) return;
    Object.keys(ownerCharts).forEach(function (kind) {
      var ch = ownerCharts[kind];
      var svg = $('historyOverview').querySelector('.oc-svg[data-kind="' + kind + '"]'); if (!svg) return;
      var scrubG = svg.querySelector('.oc-scrub'), readout = svg.parentNode.querySelector('.oc-readout');
      function gameAt(clientX) {
        var rc = svg.getBoundingClientRect(), sc = Math.min(rc.width / ch.W, rc.height / ch.H) || 1, ox = (rc.width - ch.W * sc) / 2;
        var i = Math.round(((clientX - rc.left - ox) / sc - ch.padL) / (ch.iw || 1) * (ch.n - 1));
        return Math.max(0, Math.min(ch.n - 1, i));
      }
      function show(clientX) {
        var i = gameAt(clientX), sx = ch.xfn(i), g = ch.games[i], rel = g.val != null;
        scrubG.innerHTML = '<line x1="' + sx + '" y1="' + ch.padT + '" x2="' + sx + '" y2="' + (ch.padT + ch.ih) + '" class="oc-scrubline"/>'
          + '<circle cx="' + sx + '" cy="' + ch.yfn(ch.yv[i]) + '" r="3.1" fill="' + (rel ? ch.color : 'var(--gen-muted)') + '" stroke="#16160e" stroke-width="0.8"/>';
        var valTxt = rel ? ((ch.luck && g.val > 0 ? '+' : '') + Math.round(g.val) + ch.suffix) : '—';
        readout.innerHTML = '<div class="oc-rd-hd">' + esc(g.name ? g.name : fmtDate(g.ts)) + '</div><div class="oc-rd-v">' + valTxt + '</div>';
        readout.classList.toggle('left', sx > ch.W / 2);
        readout.classList.remove('hidden');
      }
      function hide() { scrubG.innerHTML = ''; readout.classList.add('hidden'); }
      var on = false;
      svg.addEventListener('pointerdown', function (e) { on = true; try { svg.setPointerCapture(e.pointerId); } catch (x) {} show(e.clientX); });
      svg.addEventListener('pointermove', function (e) { if (on) show(e.clientX); });
      svg.addEventListener('pointerup', function () { on = false; hide(); });
      svg.addEventListener('pointercancel', function () { on = false; hide(); });
    });
    // selecting a tab shows ONLY that chart below the row (never two stacked)
    $('historyOverview').querySelectorAll('.oc-tab').forEach(function (tab) {
      tab.onclick = function (e) {
        e.preventDefault(); e.stopPropagation();
        var kind = tab.getAttribute('data-kind'), box = tab.closest('.ocharts');
        if (!box) return;
        box.querySelectorAll('.ocard').forEach(function (c) { c.classList.toggle('hidden', c.getAttribute('data-card') !== kind); });
        box.querySelectorAll('.oc-tab').forEach(function (t) { t.classList.toggle('on', t === tab); });
      };
    });
  }

  function ownerOverview(rs) {
    rs = rs || 'standard';
    var c = computeOwnerCareer(rs);
    if (!c) {
      return '<div class="histover"><div class="noowner"><div class="nohd">🤷 Няма досие на стопанина</div>'
        + 'Щабът не намира нито една битка с теб на боец №1. За да следим бойната ти форма, '
        + '<b title="В настройките включи „Използвай моето име“, или просто играй като боец №1 (★) — без да го пускаш AI.">влез в боя сам</b> '
        + '(★ боец №1, не AI). Тогава архивът ще почне да трупа графиката на величието ти.</div></div>';
    }
    var n = c.n, data = c.data, anaData = c.anaData || [];
    var bl = {};
    anaData.forEach(function (d) { var b = d.ana.blunder; if (b && b.cost < -0.5) { var k = b.chosenKey || b.turnCategory; if (k) bl[k] = (bl[k] || 0) + 1; } });
    var favBl = null, favN = 0; Object.keys(bl).forEach(function (k) { if (bl[k] > favN) { favN = bl[k]; favBl = k; } });
    // достижения: outstanding optimal calls (biggest-EV-margin moves) counted by category
    var gm = {};
    anaData.forEach(function (d) { (d.ana.topMoves || []).forEach(function (mv) { var k = mv.chosenKey || mv.turnCategory; if (k) gm[k] = (gm[k] || 0) + 1; }); });
    var topGood = Object.keys(gm).map(function (k) { return { key: k, n: gm[k] }; }).sort(function (a, b) { return b.n - a.n; }).slice(0, 3);
    // name: the settings battle-name, else „Старшина“ (no random game name, no ★ token)
    var name = (settings.useOwnerName && settings.ownerName.trim()) || 'Старшина';
    var rank = G.rankForAccuracy(c.avgAcc);
    // last 10 battles, MOST RECENT LEFT, placement colour-coded (gold/silver/bronze/grey)
    var recent = data.slice(-10).reverse();
    var form = recent.map(function (d) {
      var cls = d.place === 1 ? 'r1' : d.place === 2 ? 'r2' : d.place === 3 ? 'r3' : d.place == null ? 'rx' : 'r4';
      return '<i class="rk ' + cls + '">' + (d.place != null ? d.place : '–') + '</i>';
    }).join('');

    // collapsed: name, a win/lose ratio bar, then the averages trio. Everything else
    // lives in the expandable body. The owner name carries the старшина's default colour.
    // wins / win-bar are over RANKED games only (>1 player); the bar hides when there are none.
    var rankedN = c.rankedN, losses = Math.max(0, rankedN - c.wins);
    var winPct = rankedN ? Math.round(100 * c.wins / rankedN) : 0, losePct = rankedN ? Math.round(100 * losses / rankedN) : 0;
    var bar = rankedN ? '<span class="ho-winbar" data-win="' + winPct + '" data-lose="' + losePct + '" title="' + winPct + '% победи · ' + losePct + '% загуби">'
      + '<i class="wb-win" style="flex:' + c.wins + '"></i><i class="wb-lose" style="flex:' + losses + '"></i></span>'
      : '<span class="ho-noranked">няма игри с класиране</span>';
    var h = '<details class="histover"><summary class="ho-sum"><span class="ho-head">'
      + '<span class="oname" style="color:' + (settings.ownerColor || 'var(--gen-brass)') + '">' + esc(name) + '</span>'
      + '<span class="ho-avgwrap">'
      + bar
      + '<span class="ho-mini">'
      + '<span class="hom-cell"><b>' + n + '</b><i>битки</i></span>'
      + '<span class="hom-cell"><b>' + c.wins + '</b><i>победи</i></span>'
      + '<span class="hom-cell"><b>' + Math.round(c.avgAcc * 100) + '%</b><i>точност</i></span>'
      + '</span></span>'
      + '</span><span class="ho-caret"></span></summary><div class="ho-body">';
    // §2.7 per-battle form charts sit at the TOP of the body — three collapsible buttons
    h += buildOwnerCharts(c, rs === 'experimental' ? 'exp' : 'std');
    // analysis-category breakdown (colour-coded labels) sits between the name and recent battles
    h += careerAverages(c.report, { biggest: favBl ? { key: favBl, n: favN } : null, achievements: topGood }, rs);
    h += '<div class="histline">Последни битки:</div><div class="histform' + (recent.length >= 10 ? ' full' : '') + '">' + (form || '—') + '</div>';
    // career stat lines — each starts with a colour-coded term, its parts split onto their own rows
    var chinRows = ['по средно умение <b>' + esc(rank) + '</b>'];
    if (c.rankedN) chinRows.push('процент победи <b>' + Math.round(100 * c.wins / c.rankedN) + '%</b> <span class="hmuted">(' + c.rankedN + ' с класиране)</span>', 'средно място <b>' + c.avgPlace.toFixed(1) + '</b>');
    else chinRows.push('<span class="hmuted">няма игри с класиране за победи</span>');
    h += statRows('Чин', RC.skill, chinRows);
    h += statRows('Личен рекорд', RC.upper, ['най-висок <b>' + c.best + '</b> т.', 'най-нисък <b>' + c.worst + '</b> т.', 'среден резултат <b>' + Math.round(c.avgScore) + '</b> т.'].concat(c.avgLuck != null ? ['среден късмет <b>' + (c.avgLuck >= 0 ? '+' : '') + c.avgLuck.toFixed(0) + '</b>'] : []));
    h += stat('Генерали', RC.gen, '<b>' + c.generals + '</b> от ' + n + ' битки');   // single line, no blunder here
    var consTag = c.scoreSd < 18 ? 'стабилен' : c.scoreSd > 32 ? 'нестабилен' : 'умерен';
    h += statRows('Постоянство', RC.stage, ['резултат <b>±' + Math.round(c.scoreSd) + ' т.</b>', 'точност <b>±' + Math.round(c.accSd) + '%</b>', '<span class="hmuted">' + consTag + '</span>']);
    if (c.accSlope != null) {
      var arrow = c.accSlope > 0.3 ? '↗' : c.accSlope < -0.3 ? '↘' : '→';
      var word = c.accSlope > 0.3 ? 'качваш се' : c.accSlope < -0.3 ? 'спадаш' : 'стабилно';
      h += stat('Развитие', RC.nerves, '<b>' + (c.accSlope >= 0 ? '+' : '') + c.accSlope.toFixed(1) + '%/битка ' + arrow + '</b> <span class="hmuted">(' + word + ')</span>');   // single line
    }
    var worst = c.catList.slice().filter(function (x) { return x.fills >= 2; }).sort(function (a, b) { return b.avgLeak - a.avgLeak; })[0];
    if (worst && worst.avgLeak > 0.6) h += '<div class="coachline career">🎖 За повишение наблегни на <b>' + esc(worst.label) + '</b> — там пробивът ти в строя е най-голям (средно −' + worst.avgLeak.toFixed(1) + ' т. на игра). Категорията, която да тренираш.</div>';
    // category board (same layout as the end-game Категории)
    h += careerCatBoard(c);
    h += '</div></details>';
    return h;
  }
  // career category board — tile = hit% + record + avg EV-leak, tinted green/grey/red
  // by how cleanly you play it. The read tips hide behind a ? to save space.
  function careerCatBoard(c) {
    var byKey = {}; c.catList.forEach(function (x) { byKey[x.key] = x; });
    function tile(cat) {
      var x = byKey[cat.key];
      if (!x) return '<div class="cgtile none"><span class="cg-lab">' + esc(cat.label) + '</span><span class="cg-pct">—</span><span class="cg-rec">—</span><span class="cg-leak">—</span></div>';
      var leak = x.avgLeak, cls = leak <= 0.3 ? ' good' : leak > 1 ? ' bad' : '';   // green / grey / red
      return '<div class="cgtile' + cls + '"><span class="cg-lab">' + esc(cat.label) + '</span>'
        + '<span class="cg-pct">' + Math.round(x.hitRate * 100) + '%</span>'
        + '<span class="cg-rec">' + (x.rec ? x.rec + 'т.' : '—') + '</span>'
        + '<span class="cg-leak">−' + leak.toFixed(1) + '</span></div>';
    }
    var CATS = c && c.ruleset === 'experimental' ? G.CATEGORIES_EXP : G.CATEGORIES;
    var up = CATS.filter(function (cc) { return cc.group === 'upper'; }).map(tile).join('');
    var low = CATS.filter(function (cc) { return cc.group === 'lower'; }).map(tile).join('');
    // the whole board folds away (collapsed by default — it's a screen-hog); the ? sits
    // inline next to the label and toggles the read-tips WITHOUT opening/closing the fold
    var tips = '<div class="cc-tips hidden">'
      + '<div><b>%</b> — колко често вкарваш категорията</div>'
      + '<div><b>число</b> — твоят личен рекорд</div>'
      + '<div><b>−EV</b> — среден теч: колко точки изпускаш на ход</div>'
      + '<div>цвят: <b class="cc-g">зелено</b> играеш я чисто · <b class="cc-n">сиво</b> средно · <b class="cc-r">червено</b> теч</div>'
      + '</div>';
    // a bordered bar that reads as expandable: label · ? button · down-arrow on the right.
    // the ? toggles the read-tips on its own (works whether or not the board is open).
    return '<div class="catfold">'
      + '<div class="catfold-bar"><span class="cf-lab">Категории</span>'
      + '<button type="button" class="cc-qbtn" aria-label="Как се чете?" title="Как се чете?">?</button>'
      + '<span class="cf-caret"></span></div>' + tips
      + '<div class="catgrid-wrap hidden"><div class="miniboard catgrid"><div class="upper">' + up + '</div><div class="lower">' + low + '</div></div></div></div>';
  }
  // career averages of the per-player report stats (mirrors renderReport's stat lines)
  function careerAverages(r, extra, rs) {
    extra = extra || {};
    var h = '';
    if (r.luck != null) h += '<div class="evline" style="font-size:13px"><span class="luck">' + signed(Math.round(r.luck)) + ' късмет</span> <span class="skill">' + signed(Math.round(r.skill)) + ' решения</span> · загуба ' + nBad(r.lostPerTurn, 1) + ' т./ход</div>';
    if (r.leakKeep != null) h += statRows('Изтичане', RC.leak, ['задържания ' + nBad(r.leakKeep, 1) + ' т.', 'категории ' + nBad(r.leakCat, 1) + ' т.']);
    else if (r.leakCat != null) h += stat('Изтичане', RC.leak, 'категории ' + nBad(r.leakCat, 1) + ' т.');
    if (rs === 'experimental' && r.secUpper != null) {   // section performance: avg points each half yields
      var su = Math.round(r.secUpper), suB = su > 0 ? '<b class="np">+' + su + '</b>' : su < 0 ? '<b class="nn">' + su + '</b>' : '<b class="nu">0</b>';
      h += statRows('Раздели', RC.upper, ['числа ' + suB + ' т.', 'комбинации ' + nNeut(Math.round(r.secLower)) + ' т.']);
    }
    h += statRows('Издънки', RC.sev, [nNeut(r.sevMinor.toFixed(1)) + ' дребни', nNeut(r.sevMajor.toFixed(1)) + ' сериозни', '<b class="nn">' + r.sevFatal.toFixed(1) + '</b> фатални']);
    if (extra.biggest) h += stat('Най-голяма издънка', RC.sev, '<b>' + esc(catLabelOf(extra.biggest.key, rs)) + '</b> · ×' + extra.biggest.n);
    // Постижения: where your sharpest (biggest-EV) moves land — top categories by COUNT
    if (extra.achievements && extra.achievements.length) h += statRows('Постижения', RC.upper, extra.achievements.map(function (a) { return esc(catLabelOf(a.key, rs)) + ' <b>×' + a.n + '</b>'; }));
    if (r.luckFirst != null) h += statRows('Късмет', RC.luck, ['първо хвърляне ' + nSigned(r.luckFirst, 1), 'прехвърляния ' + nSigned(r.luckRerolls, 1), 'в решителния край ' + nSigned(r.clutch, 1)]);
    h += throwKeepHTML(r.throwKeep);
    h += diceKeepHTML(r.diceKeep, r.diceDrop);
    if (r.zeroTotal != null) h += statRows('Нули', RC.zero, [nNeut(r.zeroTotal.toFixed(1)) + ' общо', nNeut(r.zeroForced.toFixed(1)) + ' принудени', '<b class="nn">' + r.zeroUnforced.toFixed(1) + '</b> от твоята игра']);
    h += statRows('По етапи', RC.stage, ['начало <b class="nn">' + r.stageEarly.toFixed(1) + '</b> т./ход', 'среда <b class="nn">' + r.stageMid.toFixed(1) + '</b> т./ход', 'край <b class="nn">' + r.stageLate.toFixed(1) + '</b> т./ход']);
    return h;
  }

  // §2.4 percentile of an owner game's score within the owner's score distribution to date
  function ownerScorePercentile(scoresAll, val) {
    if (scoresAll.length < 3) return null;                      // too few games to rank meaningfully
    var below = scoresAll.filter(function (s) { return s < val; }).length;
    var equal = scoresAll.filter(function (s) { return s === val; }).length;
    return Math.round(100 * (below + 0.5 * equal) / scoresAll.length);
  }
  var histTab = 'standard';   // which ruleset the archive is showing
  function setHistTab(rs) { if (histTab === rs) return; histTab = rs; renderHistory(); }
  var histShown = 5;          // how many battles are listed; grows by 5 via „покажи още“
  var histPlayFilter = 'all'; // 'all' | 'manual' (отчет) | 'engine' (игра) — manual-vs-engine filter
  var histPulsePending = false; // animate the first row's right edge once, only on a fresh open
  function renderHistory() {
    // paging is NOT reset here — loaded battles stay loaded across tab switches and
    // exclude toggles; histShown only resets on a fresh openHistory() (full close→open)
    ownerCharts = null;  // rebuilt fresh each render
    // same underline-style ruleset selector as the start screen (с минуси / без минуси)
    var tabs = '<div class="ssel hist-rsel">'
      + '<button type="button" class="ssel-opt' + (histTab === 'experimental' ? ' on' : '') + '" data-rs="experimental">с минуси</button>'
      + '<button type="button" class="ssel-opt' + (histTab === 'standard' ? ' on' : '') + '" data-rs="standard">без минуси</button></div>';
    $('historyOverview').innerHTML = tabs + ownerOverview(histTab);
    var rsel = $('historyOverview').querySelector('.hist-rsel');
    rsel.querySelectorAll('.ssel-opt').forEach(function (b) {
      b.onclick = function () { if (rsel._swiped) { rsel._swiped = false; return; } setHistTab(b.getAttribute('data-rs')); };
    });
    attachSelSwipe(rsel, function () { setHistTab('experimental'); }, function () { setHistTab('standard'); });
    var wbar = $('historyOverview').querySelector('.ho-winbar');
    if (wbar) wbar.onclick = function (e) { e.preventDefault(); e.stopPropagation(); showWinTip(wbar); };   // tap → temporary rate bubble (don't toggle the <details>)
    wireOwnerCharts();   // attach the scrub readers to the per-battle career charts
    // the bar opens/closes the board; the ? toggles the read-tips on its own (no fold needed)
    var fold = $('historyOverview').querySelector('.catfold');
    if (fold) {
      var bar = fold.querySelector('.catfold-bar'), grid = fold.querySelector('.catgrid-wrap'), q = fold.querySelector('.cc-qbtn'), tips = fold.querySelector('.cc-tips');
      bar.onclick = function () { fold.classList.toggle('open'); if (grid) grid.classList.toggle('hidden'); };
      if (q) q.onclick = function (e) { e.preventDefault(); e.stopPropagation(); if (tips) tips.classList.toggle('hidden'); };
    }
    renderHistoryList();
  }
  // the battle list — paginated: 5 at a time, a centred „покажи още 5“ reveals the next batch
  function wireClearFilter() {
    var c = $('historyList').querySelector('#histClearFilter');
    if (c) c.onclick = function () { histDateFilter = null; histShown = 5; renderHistoryList(); };
  }
  function renderHistoryList() {
    var all = loadHistory().slice().reverse(); // newest first
    var rsGames = all.filter(function (r) { return (r.ruleset === 'experimental') === (histTab === 'experimental'); });
    // an active calendar date filter narrows the section to that day (rulesets stay split),
    // then the manual-vs-engine filter narrows further
    var games = histDateFilter ? rsGames.filter(function (r) { return dayStart(r.ts) === histDateFilter; }) : rsGames;
    if (histPlayFilter === 'manual') games = games.filter(function (r) { return r.manualMode; });
    else if (histPlayFilter === 'engine') games = games.filter(function (r) { return !r.manualMode; });
    var chip = histDateFilter ? '<div class="histfilter"><button type="button" class="histfilter-chip" id="histClearFilter">📅 ' + fmtDate(histDateFilter) + ' <span class="hf-x">✕</span></button></div>' : '';
    if (!rsGames.length) {
      $('historyList').innerHTML = chip + '<div class="noowner">' + (histTab === 'experimental' ? 'Още няма битки „с минуси“. Превключи правилата в настройките и влез в боя.' : 'Архивът е празен, командире. Спечели (или загуби) някоя битка и тя ще влезе тук.') + '</div>';
      wireClearFilter(); return;
    }
    if (!games.length) {   // a date / play filter left nothing in THIS section
      $('historyList').innerHTML = chip + playFilterHeaderHTML(0) + '<div class="noowner">Няма битки за избраните филтри.</div>';
      wireClearFilter(); wirePlayFilter(); return;
    }
    // owner score distribution (for the percentile tags), drift-as-it-grows by design
    var career = computeOwnerCareer(histTab);
    var ownerScores = career ? career.scores : [];
    var html = chip + playFilterHeaderHTML(games.length);
    games.slice(0, histShown).forEach(function (rec) {
      var oi = recOwnerIdx(rec), skipped = oi < 0, excluded = !!rec.excluded;
      var recEx = recIsExp(rec);
      var top = rec.players.slice().sort(function (a, b) { return recTotal(b, recEx) - recTotal(a, recEx); })[0];
      var ptsPlayer = skipped ? top : rec.players[oi];
      var rk = gameRanking(rec);                                  // single-player games are unranked (no place / crown)
      var oTotal = recTotal(ptsPlayer, recEx), place = rk.ranked ? rk.place : null;
      var pct = !excluded && !skipped && !rec.players[oi].isAI ? ownerScorePercentile(ownerScores, oTotal) : null;
      // only flag genuinely standout games: top 5 / 10 / 15 % (bucketed); nothing below that
      var topPct = pct == null ? null : 100 - pct;
      var tier = topPct == null ? null : topPct <= 5 ? 5 : topPct <= 10 ? 10 : topPct <= 15 ? 15 : null;
      var pctTag = tier != null
        ? ' <span class="hg-pct hi" title="по-добра от ' + pct + '% от игрите ти">топ ' + tier + '%</span>' : '';
      // ranking marker: medal-coloured by finishing place, grey when excluded / unranked
      var rankCls = excluded ? 'ex' : place === 1 ? 'r1' : place === 2 ? 'r2' : place === 3 ? 'r3' : 'r4';
      var rankNum = place != null ? place : '–';
      var rankTitle = excluded ? 'Извън статистиката · докосни за връщане'
        : (place != null ? place + '-то място · докосни за изключване' : 'Без класиране · докосни за изключване');
      // a renamed battle leads with its name; otherwise the date stays the title
      var named = !!rec.name;
      var primary = named ? esc(rec.name) : esc(fmtDate(rec.ts));
      var subDate = named ? esc(fmtDate(rec.ts) + ' ' + fmtTime(rec.ts)) : esc(fmtTime(rec.ts));
      html += '<div class="histgame' + (excluded ? ' ex' : '') + '" data-id="' + esc(rec.id) + '">'
        + '<div class="hg-row">'
        + '<button type="button" class="hg-count ' + rankCls + '" title="' + esc(rankTitle) + '">' + rankNum + '</button>'
        + '<span class="hg-main"><span class="hg-top">' + primary
        + (skipped ? ' <span class="hg-skip" title="Старшината е пропуснат — извън статистиката">⊘</span>' : '') + '</span>'
        + '<span class="hg-sub">'
        + '<span class="hg-mode" title="' + (rec.manualMode ? 'отчет (ръчно)' : 'със зарове') + '">'
        +   (rec.manualMode ? '<i class="minipencil"></i>' : '<i class="minidie"></i>') + '</span>'
        + (function () { var isNet = recIsNet(rec); return '<span class="hg-net" title="' + (isNet ? 'по мрежа' : 'на устройството') + '">'
        +   (isNet ? '<i class="mininet"></i>' : '<i class="minidev"></i>') + '</span>'; })()
        + ' · ' + subDate + pctTag + '</span></span>'
        + '<span class="hg-pts">' + oTotal + '</span>'
        + '</div>'
        + '<div class="hg-actions">'
        + '<button class="hg-play ic-play" title="Реплей"><span class="gl"></span></button>'
        + '<button class="hg-exp" title="Експорт"><span class="ic ic-up solo"></span></button>'
        + '<button class="hg-del" title="Изтрий">✕</button>'
        + '</div></div>';
    });
    // batch loader: reveal the next 5 until the whole archive is shown
    if (histShown < games.length) {
      var more = Math.min(5, games.length - histShown);
      html += '<div class="histmore"><button type="button" class="histmore-btn">Покажи още ' + more
        + ' <span class="hm-rem">(' + (games.length - histShown) + ' остават)</span></button></div>';
    }
    $('historyList').innerHTML = html;
    $('historyList').querySelectorAll('.histgame').forEach(function (row) {
      var id = row.getAttribute('data-id');
      var find = function () { return loadHistory().filter(function (r) { return r.id === id; })[0]; };
      row.querySelector('.hg-count').onclick = function (e) { e.stopPropagation(); toggleExcludeGame(id); };
      row.querySelector('.hg-play').onclick = function (e) { e.stopPropagation(); var rec = find(); if (rec) openReplay(rec); };
      row.querySelector('.hg-exp').onclick = function (e) { e.stopPropagation(); var rec = find(); if (rec) chooseMethod('Изнеси играта', function () { exportGame(rec); }, function () { acousticSend(rec); }); };
      row.querySelector('.hg-del').onclick = function (e) { e.stopPropagation(); confirmDeleteGame(row, id); };
      attachSwipe(row, id, find);
    });
    var mb = $('historyList').querySelector('.histmore-btn');
    if (mb) mb.onclick = function () { histShown += 5; renderHistoryList(); };
    wireClearFilter(); wirePlayFilter();
  }
  // „Битки (N)" header + a CSS funnel that cycles the manual/engine filter
  function playFilterHeaderHTML(count) {
    var lbl = histPlayFilter === 'manual' ? 'отчет' : histPlayFilter === 'engine' ? 'игра' : '';
    return '<div class="histhd"><span class="hh-count">Битки (' + count + ')</span>'
      + '<button type="button" class="histfilt' + (histPlayFilter !== 'all' ? ' on' : '') + '" id="histPlayBtn" title="Филтър: ръчно (отчет) / машина (игра)">'
      + '<i class="filt-ic"></i>' + (lbl ? '<span class="filt-lbl">' + lbl + '</span>' : '') + '</button></div>';
  }
  function wirePlayFilter() {
    var pb = $('historyList').querySelector('#histPlayBtn');
    if (pb) pb.onclick = function () {
      histPlayFilter = histPlayFilter === 'all' ? 'manual' : histPlayFilter === 'manual' ? 'engine' : 'all';
      histShown = 5; renderHistoryList();
    };
  }
  // ---- swipe gestures on a history row ------------------------------------------------
  // left → reveal play/export/delete (menu over a blurred body; >80% arms delete-confirm);
  // right → exclude from stats (>50%); the opposite direction closes an open menu; a plain
  // tap opens the game. Horizontal is tracked via pointer events while touch-action:pan-y
  // leaves vertical scrolling to the browser, so a diagonal still scrolls.
  function attachSwipe(row, id, find) {
    var sx = 0, sy = 0, w = 0, dx = 0, moved = false, tracking = false, startedOpen = false;
    function live() {
      var L = -dx, R = dx;
      if (startedOpen) row.classList.toggle('menu-open', !(R > 0.06 * w));
      else row.classList.toggle('menu-open', L >= 0.25 * w);
      row.classList.toggle('confirm-arm', L >= 0.8 * w);
      row.classList.toggle('excl-arm', !startedOpen && R >= 0.5 * w);
    }
    row.addEventListener('pointerdown', function (e) {
      if (e.target.closest('.hg-actions') || e.target.closest('.hg-count') || e.target.closest('.hg-confirm')) return;
      sx = e.clientX; sy = e.clientY; w = row.offsetWidth || 300; dx = 0; moved = false; tracking = true;
      startedOpen = row.classList.contains('menu-open');
    });
    row.addEventListener('pointermove', function (e) {
      if (!tracking) return;
      dx = e.clientX - sx; var dy = e.clientY - sy;
      if (Math.abs(dx) > 8 || Math.abs(dy) > 8) moved = true;
      live();
    });
    function end() {
      if (!tracking) return; tracking = false;
      row.classList.remove('confirm-arm', 'excl-arm');
      var L = -dx, R = dx;
      if (startedOpen) {
        if (L >= 0.8 * w) { row.classList.add('menu-open'); confirmDeleteGame(row, id); }
        else if (R > 0.06 * w || !moved) row.classList.remove('menu-open');
        else row.classList.add('menu-open');
      } else {
        if (L >= 0.8 * w) { row.classList.add('menu-open'); confirmDeleteGame(row, id); }
        else if (L >= 0.25 * w) row.classList.add('menu-open');
        else if (R >= 0.5 * w) toggleExcludeGame(id);          // re-renders the whole list
        else if (!moved) { var rec = find(); if (rec) openHistoryGame(rec); }
        else row.classList.remove('menu-open');
      }
    }
    row.addEventListener('pointerup', end);
    row.addEventListener('pointercancel', end);
  }
  function pulseFirstRow(row) {
    row.classList.add('hg-pulse');
    row.addEventListener('animationend', function h() { row.classList.remove('hg-pulse'); row.removeEventListener('animationend', h); });
  }

  // ---------- §ист battle calendar (git-style activity heatmap over ALL rulesets) ----------
  var histDateFilter = null;   // a day-start ts; when set the archive list shows only that day
  var calMonth = null;         // first-of-month Date currently displayed
  var CAL_MONTHS = ['януари', 'февруари', 'март', 'април', 'май', 'юни', 'юли', 'август', 'септември', 'октомври', 'ноември', 'декември'];
  function dayStart(ts) { var d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); }
  // representative score of a battle: the owner's total (or the top score if skipped)
  function recRepScore(rec) {
    var oi = recOwnerIdx(rec), ex = recIsExp(rec);
    var p = oi < 0 ? rec.players.slice().sort(function (a, b) { return recTotal(b, ex) - recTotal(a, ex); })[0] : rec.players[oi];
    return recTotal(p, ex);
  }
  // aggregate EVERY archived battle (all rulesets) by calendar day
  function calData() {
    var by = {};
    loadHistory().forEach(function (r) {
      var k = dayStart(r.ts), b = by[k] || (by[k] = { count: 0, sum: 0 });
      b.count++; b.sum += recRepScore(r);
    });
    return by;
  }
  function calLevel(count) { return count >= 6 ? 4 : count >= 4 ? 3 : count >= 2 ? 2 : count >= 1 ? 1 : 0; }
  function openCalendar() {
    var now = new Date();
    calMonth = histDateFilter ? new Date(new Date(histDateFilter).getFullYear(), new Date(histDateFilter).getMonth(), 1)
                              : new Date(now.getFullYear(), now.getMonth(), 1);
    renderCalendar();
    $('calModal').classList.remove('hidden');
  }
  function renderCalendar() {
    var by = calData(), data = loadHistory();
    var earliest = data.length ? new Date(Math.min.apply(null, data.map(function (r) { return r.ts; }))) : new Date();
    var earliestM = new Date(earliest.getFullYear(), earliest.getMonth(), 1);
    var now = new Date(), curM = new Date(now.getFullYear(), now.getMonth(), 1);
    var y = calMonth.getFullYear(), mo = calMonth.getMonth();
    // month totals (all rulesets)
    var mCount = 0, mSum = 0;
    Object.keys(by).forEach(function (k) { var d = new Date(+k); if (d.getFullYear() === y && d.getMonth() === mo) { mCount += by[k].count; mSum += by[k].sum; } });
    var mAvg = mCount ? Math.round(mSum / mCount) : 0;
    var atEarliest = calMonth.getTime() <= earliestM.getTime(), atCurrent = calMonth.getTime() >= curM.getTime();
    $('calHeader').innerHTML = '<button type="button" class="cal-nav" id="calPrev"' + (atEarliest ? ' disabled' : '') + '>‹</button>'
      + '<div class="cal-mtitle"><div class="cal-mname">' + CAL_MONTHS[mo] + ' ' + y + '</div>'
      + '<div class="cal-mstats">' + (mCount ? mCount + ' игри · средно ' + mAvg + ' т.' : 'няма битки') + '</div></div>'
      + '<button type="button" class="cal-nav" id="calNext"' + (atCurrent ? ' disabled' : '') + '>›</button>';
    // grid: Monday-first, with leading blanks
    var firstDow = (new Date(y, mo, 1).getDay() + 6) % 7, daysIn = new Date(y, mo + 1, 0).getDate();
    var todayK = dayStart(now.getTime());
    var cells = '';
    for (var i = 0; i < firstDow; i++) cells += '<div class="calday empty"></div>';
    for (var day = 1; day <= daysIn; day++) {
      var k = dayStart(new Date(y, mo, day).getTime()), b = by[k];
      var lv = b ? calLevel(b.count) : 0, has = !!b;
      var meta = b ? '<span class="cd-meta">' + b.count + '<br>~' + Math.round(b.sum / b.count) + 'т.</span>' : '';
      cells += '<button type="button" class="calday l' + lv + (has ? ' has' : '') + (k === todayK ? ' today' : '') + (k === histDateFilter ? ' sel' : '') + '"'
        + (has ? ' data-day="' + k + '"' : ' disabled') + '><span class="cd-num">' + day + '</span>' + meta + '</button>';
    }
    $('calGrid').innerHTML = cells;
    var prev = $('calPrev'), next = $('calNext');
    if (prev) prev.onclick = function () { calMonth = new Date(y, mo - 1, 1); renderCalendar(); };
    if (next) next.onclick = function () { if (!atCurrent) { calMonth = new Date(y, mo + 1, 1); renderCalendar(); } };
    $('calGrid').querySelectorAll('.calday.has').forEach(function (c) {
      c.onclick = function () { histDateFilter = +c.getAttribute('data-day'); histShown = 5; $('calModal').classList.add('hidden'); renderHistoryList(); };
    });
  }
  $('calBtn').onclick = openCalendar;
  $('calClose').onclick = function () { $('calModal').classList.add('hidden'); };
  $('calModal').onclick = function (e) { if (e.target === $('calModal')) $('calModal').classList.add('hidden'); };

