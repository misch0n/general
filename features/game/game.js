'use strict';
// Core game loop: state, board render, manual mode, dice interaction, commit / turn flow.

  // ===================================================== GAME STATE
  // Per-turn state lives on `game.turn` (one object, reset each turn) — see freshTurn().
  // turn.diceGen ("Нов набор зарове"): per-die generation = the roll a die was last thrown in. Parallel
  // to turn.dice; groups the tray (kept-longest left → newest right) instead of accenting. Empty = off.
  var game = null;
  var roastIx = 0, roastTimer = null;
  var moveLog = [];   // per player index: array of completed turn logs
  // the live per-turn fields, defaulted; beginTurn() overwrites them at each turn boundary.
  // Shape (and the whole turn-flow state machine) lives in reduce.js — see GReduce.
  function freshTurn() { return GReduce.freshTurn(); }
  // seed the turn's move-log for the active ruleset. Net minus games run the standard turn path
  // but score by EXP rules, so they need the EXP log shape — otherwise nothing is logged and the
  // end-game summary can't analyse (players unclickable, only the category board shows).
  function startTurnLog(p) {
    return sumExp() ? expStartLog(p)
      : (evReady ? { mask: EV.maskOfScores(p.scores), rolls: [game.turn.dice.slice()], keeps: [] } : null);
  }
  var hintsOn = false;
  var skipOwnerNext = false; // when set, the next game is NOT attributed to the owner (someone else is playing)
  var ownerDetached = false; // owner deliberately removed from the roster (only while skipped): seat #1 shows a MUTED token but keeps its own identity until the token is re-activated
  // ОТЧЕТ mode (manual point entry, no app dice rolls) now lives on `game.manual`; read via gManual().
  var netMode = false, net = null, localPid = null, netOrder = [], netMyTurn = false; // networked play (WebRTC)
  var netBus = null, netManual = false;   // regular/manual(ОТЧЕТ) network game mode
  var netPhase = 'choose', netMe = null, netMyReady = false, netAiActiveId = null, netMetaTimer = null; // lobby preparation + host AI takeover
  var netActiveId = null, specSelf = false, specAct = null, specSaved = null;   // spectating: who's playing, am I previewing my own board, last action, saved watch-view
  // true while we're rendering a watched opponent's read-only frame (not my turn, not my own-board preview)
  function netWatching() { return netMode && game.turn.locked && !netMyTurn && !specSelf && netActiveId != null && netActiveId !== localPid; }
  var CAT_INDEX = {}, CAT_KEYS = G.CATEGORIES.map(function (c) { return c.key; }); G.CATEGORIES.forEach(function (c, i) { CAT_INDEX[c.key] = i; });
  // experimental category space (for net minus games — the move protocol indexes into THIS list)
  var CAT_INDEX_EXP = {}, CAT_KEYS_EXP = G.CATEGORIES_EXP.map(function (c) { return c.key; }); G.CATEGORIES_EXP.forEach(function (c, i) { CAT_INDEX_EXP[c.key] = i; });
  // ruleset-aware index↔key for the net move protocol (standard path unchanged when not sumExp())
  function catIndexOf(key) { return (sumExp() ? CAT_INDEX_EXP : CAT_INDEX)[key]; }
  function catKeyAt(i) { return (sumExp() ? CAT_KEYS_EXP : CAT_KEYS)[i]; }
  var undoStack = [];      // manual-mode action log for ОПА (taps + commits)
  var summary = null;      // end-game summary state (tab, selected player)
  var tut = null;          // active tutorial controller (scripted dice + coach bubbles), null otherwise
  var fx = {};             // combo-reminder penalties folded into one override (see rebuildFx)

  // one start path for both rulesets: only the engine factory, the ruleset tag and the begin-turn
  // function differ (exp keeps its own free-order turn flow); everything else is shared scaffolding.
  function startGame(players, manual) {
    netMode = false;   // a normal local game is never networked
    var exp = settings.ruleset === 'experimental';
    document.querySelector('.sheet').classList.remove('hidden');   // both rulesets reuse the tile board
    $('expBoard').classList.add('hidden'); $('expReserve').classList.add('hidden'); $('expNumBar').classList.add('hidden');
    clearAllPenalties();
    game = (exp ? X : G).createGame(players);
    game.ruleset = exp ? 'experimental' : 'standard';
    game.ownerSkipped = skipOwnerNext || ownerDetached; // record so this game is excluded from owner trends
    skipOwnerNext = false; ownerDetached = false;        // the skip/detach is a one-game decision
    game.manual = !!manual;
    game.turn = freshTurn();
    trackGame('start');
    undoStack = [];
    moveLog = players.map(function () { return []; });
    $('setup').classList.add('hidden');
    $('game').classList.remove('hidden');
    $('overModal').classList.add('hidden');
    paintCamo($('game'));
    syncHintBtn();
    setDockUI(gManual());
    (exp ? expBeginTurn : beginTurn)();
  }

  // rebuild an unfinished game from its resume snapshot and continue (both rulesets)
  function resumeGame(snap) {
    clearAllPenalties();
    var exp = snap.ruleset === 'experimental';
    game = (exp ? X : G).createGame(reconstructPlayers(snap));
    game.ruleset = exp ? 'experimental' : 'standard';
    game.current = snap.current || 0; game.round = snap.round || 1; game.ownerSkipped = !!snap.ownerSkipped;
    game.manual = !!snap.manualMode; game.turn = freshTurn(); undoStack = []; viewingHistory = false;
    moveLog = snap.moveLog || game.players.map(function () { return []; });
    document.querySelector('.sheet').classList.remove('hidden');
    $('expBoard').classList.add('hidden'); $('expReserve').classList.add('hidden'); $('expNumBar').classList.add('hidden');
    $('setup').classList.add('hidden'); $('game').classList.remove('hidden'); $('overModal').classList.add('hidden');
    paintCamo($('game'));
    syncHintBtn();
    setDockUI(gManual());
    (exp ? expBeginTurn : beginTurn)();
  }
  function maybeOfferResume() {
    var snap = loadResume(); if (!snap) return;
    var exp = snap.ruleset === 'experimental', rows = exp ? (X ? X.KEYS.length : 15) : G.CATEGORIES.length;
    // experimental doesn't log per-turn moves for resume; count filled rows from the cards instead
    var filled = exp
      ? snap.players.reduce(function (s, sp) { return s + Object.keys(sp.scores || {}).length; }, 0)
      : (snap.moveLog || []).reduce(function (s, l) { return s + (l ? l.length : 0); }, 0);
    var turns = snap.players.length * rows;
    $('resumeInfo').innerHTML = snap.players.length + ' бойци · ' + Math.min(filled, turns) + '/' + turns + ' хода'
      + (exp ? ' · експ.' : '') + (snap.manualMode ? ' · отчет' : '') + '<br>от ' + esc(fmtDate(snap.ts)) + ' ' + esc(fmtTime(snap.ts));
    $('resumeModal').classList.remove('hidden');
  }
  $('resumeGo').onclick = function () { var snap = loadResume(); $('resumeModal').classList.add('hidden'); if (snap) resumeGame(snap); };
  $('resumeAbort').onclick = function () { clearResume(); $('resumeModal').classList.add('hidden'); };

  // on load: a deep-link invite (?join=CODE, e.g. from scanning the host QR with the phone camera)
  // opens the page straight into the join flow for that game.
  function maybeJoinFromURL() {
    var m = (location.search + location.hash).match(/[?&#]join=([A-Za-z0-9]{4,8})/i);
    if (!m || !settings.webrtc) return false;
    var code = m[1].toUpperCase().slice(0, 6);
    try { history.replaceState(null, '', location.pathname); } catch (e) {}   // don't re-trigger on reload
    netManual = false;
    openNetModal(false);
    $('netPickRole').classList.add('hidden');
    $('netJoinCode').classList.remove('hidden');
    $('netCodeInput').value = code; lastCodeSource = 'qr';
    $('netCodeJoin').onclick();
    return true;
  }
  // on load: if a WebRTC game was active within the last 15 min, offer to rejoin it (else clean up)
  function maybeOfferNetRejoin() {
    var o = netActiveLoad(); if (!o) return false;
    if (Date.now() - (o.ts || 0) > NET_REJOIN_MS) { netActiveClear(); return false; }   // stale → forget it
    netRejoinEntry = o;
    $('netRejoinInfo').innerHTML = 'Код: <b>' + esc(o.code) + '</b><br>'
      + (o.role === 'host' ? (o.snap ? 'възстанови играта (ти си старшината)' : 'ти беше старшината') : 'присъединяване към играта')
      + (o.exp ? ' · с минуси' : ' · без минуси') + (o.manual ? ' · отчет' : '');
    $('netRejoinModal').classList.remove('hidden');
    return true;
  }
  $('netRejoinNo').onclick = function () { netActiveClear(); netRejoinEntry = null; $('netRejoinModal').classList.add('hidden'); };
  $('netRejoinGo').onclick = function () {
    var o = netRejoinEntry; $('netRejoinModal').classList.add('hidden'); if (!o) return;
    settings.ruleset = o.exp ? 'experimental' : 'standard'; syncStartRuleSel();
    netManual = !!o.manual;
    openNetModal(o.manual);
    if (o.role === 'host') {
      if (o.snap) webrtcHostRestore(o.code, o.snap);   // rebuild the unfinished game; clients reconnect by the same code
      else webrtcHost(o.code);                          // re-host the same code so a waiting peer can reconnect
    }
    else {                                            // dial back in; the host re-seats us via our saved eph
      $('netPickRole').classList.add('hidden');
      $('netJoinCode').classList.remove('hidden');
      $('netCodeInput').value = o.code; lastCodeSource = 'manual';
      $('netCodeJoin').onclick();
    }
  };

  function beginTurn() {
    hintsOn = false; $('hintBtn').classList.remove('on');   // advice is per-turn: re-click each turn
    clearRoast();
    var p = G.currentPlayer(game);
    if (!netMode) saveResume();   // snapshot at every turn boundary (net games aren't resumed locally)
    document.documentElement.style.setProperty('--pc', p.color);
    if (netMode) {
      // the active player drives input on their own device; everyone else watches
      game.turn = GReduce.reduce(game, { type: 'BEGIN_TURN', mode: 'net', myTurn: netMyTurn }).turn;
      if (netMyTurn) { renderAll(); showOrder(p); }
      else { renderAll(); netSay('Ход на ' + esc(p.name) + '…'); }
      return;
    }
    if (gManual()) {
      game.turn = GReduce.reduce(game, { type: 'BEGIN_TURN', mode: 'manual' }).turn;
      renderAll();
      showOrder(p);
      return;
    }
    game.turn = GReduce.reduce(game, { type: 'BEGIN_TURN', mode: 'dice' }).turn;
    if (p.isAI) {
      // AI rolls immediately — replay the human first-roll transition, then drive the bot
      game.turn = GReduce.reduce(game, { type: 'FIRST_ROLL', dice: G.rollAll() }).turn;
      game.turn.curLog = startTurnLog(p);
      renderAll(); shakeDice(); showOrder(p);
      runAiTurn();
    } else {
      // human: the first roll waits for a tap of the dice — adds anticipation
      // after the general's order
      renderAll();
      showOrder(p);
    }
  }

  // the human's first throw of the turn, triggered by tapping the dice tray
  function firstRoll() {
    if (!game.turn.awaitingRoll || game.turn.locked) return;
    if (tut && !tutGate('roll')) return;          // tutorial: only roll on a roll step
    var p = G.currentPlayer(game);
    var faces = (tut && tut.dice) ? tut.dice.slice() : G.rollAll();
    game.turn = GReduce.reduce(game, { type: 'FIRST_ROLL', dice: faces }).turn;
    game.turn.curLog = startTurnLog(p);   // log seeds from game.turn.dice, so build it after the roll lands
    clearRoast();
    renderAll();
    shakeDice();
    netSendAct();   // let spectators watch my initial roll
    if (tut) tutEvent('roll');
  }

  // ---------- previews ----------
  function computePreviews(player) {
    var prev = {}, cand = {}, best = null, bestVal = 0;
    G.CATEGORIES.forEach(function (c) {
      if (G.isCategoryFilled(player, c.key)) return;
      var cs = G.candidates(c.key, game.turn.dice);
      cand[c.key] = cs;
      prev[c.key] = Math.max.apply(null, cs);
      if (prev[c.key] > bestVal) { bestVal = prev[c.key]; best = c.key; }
    });
    return { prev: prev, cand: cand, best: best };
  }

  // ---------- render ----------
  // single render entry for BOTH rulesets and BOTH sources (local + net). Every piece is now a
  // shared function: header/pills branch to the exp layout internally for LOCAL exp (net-exp keeps
  // the net-aware header/pills), and board/hint dispatch on sumExp(). The dice tray, fire button
  // and net spectating are shared outright. The exp board (signed deviation rows + два чифта +
  // number bar) is also what net-minus games render.
  function renderAll() {
    renderHeader();   // shared: branches to the exp 2-line layout internally for local exp
    syncNetLink();    // keep the connection-trouble marker in sync (esp. host: a seat drops/returns → re-render here)
    renderPills();    // shared: pills are identical; the peek modal (openPeek) picks the exp board by ruleset
    if (sumExp()) { expRenderBoard(); $('expNumBar').classList.remove('hidden'); }
    else { renderBoard(); $('expNumBar').classList.add('hidden'); }
    if (gManual()) { renderManualDock(); $('undoBottom').disabled = undoStack.length === 0; syncBottomPad(); return; }
    renderDice(); renderFire(); (sumExp() ? expRenderHint : renderHint)(); syncBottomPad();
  }

  // §1 live "best move" hint (toggle; off for serious play)
  $('hintBtn').onclick = function () {
    if (gExp()) { if (!exactReady) return; hintsOn = !hintsOn; $('hintBtn').classList.toggle('on', hintsOn); expRenderHint(); return; }
    if (!evReady) return;
    hintsOn = !hintsOn; $('hintBtn').classList.toggle('on', hintsOn); renderHint();
  };
  function hintDie(v) { return '<span class="hdie">' + pipFace(v) + '</span>'; }
  var HINT_FACE = { ones: 1, twos: 2, threes: 3, fours: 4, fives: 5, sixes: 6 };
  // the dice you'd naturally KEEP to chase a given category — only the relevant
  // ones (so "търсиш четворки" never tells you to hold a stray 1)
  function keepForTarget(d, key) {
    var counts = {}; d.forEach(function (v) { counts[v] = (counts[v] || 0) + 1; });
    if (HINT_FACE[key]) return d.map(function (v) { return v === HINT_FACE[key]; });
    if (key === 'twoKind' || key === 'threeKind' || key === 'fourKind' || key === 'general') {
      var best = 0, bf = 0; for (var f = 6; f >= 1; f--) if ((counts[f] || 0) > best) { best = counts[f]; bf = f; }
      return d.map(function (v) { return v === bf; });
    }
    if (key === 'fullHouse') return d.map(function (v) { return counts[v] >= 2; }); // keep the pairs/triples
    if (key === 'smallStraight' || key === 'largeStraight') {
      var need = key === 'smallStraight' ? [1, 2, 3, 4, 5] : [2, 3, 4, 5, 6], seen = {};
      return d.map(function (v) { if (need.indexOf(v) >= 0 && !seen[v]) { seen[v] = 1; return true; } return false; });
    }
    if (key === 'chance') return d.map(function (v) { return v >= 4; }); // keep the high dice
    return d.map(function () { return false; });
  }
  function renderHint() {
    var line = $('hintLine');
    var p = G.currentPlayer(game);
    var show = hintsOn && evReady && !p.isAI && !game.turn.locked && !game.turn.awaitingRoll && game.turn.dice.length === G.DICE_COUNT;
    if (!show) { line.classList.add('hidden'); return; }
    var head, alts;
    if (game.turn.throwsLeft > 0) {
      head = 'Щабът съветва:';
      // for each open category use its NATURAL keep, rank by EV, then dedupe by the
      // kept-dice signature so the three lines are genuinely different directions
      var mask = EV.maskOfScores(p.scores);
      var ranked = G.CATEGORIES.filter(function (c) { return !G.isCategoryFilled(p, c.key); }).map(function (c) {
        var keep = keepForTarget(game.turn.dice, c.key);
        return { key: c.key, keep: keep, ev: EV.keepValue(mask, game.turn.dice, game.turn.throwsLeft, keep) };
      }).sort(function (a, b) { return b.ev - a.ev; });
      var sigSeen = {}, opts = [];
      ranked.forEach(function (o) {
        if (opts.length >= 3) return;
        var sig = o.keep.map(function (b) { return b ? 1 : 0; }).join('');
        if (sigSeen[sig]) return;
        sigSeen[sig] = 1; opts.push(o);
      });
      alts = opts.map(function (o) {
        var kept = game.turn.dice.filter(function (v, j) { return o.keep[j]; });
        var tname = G.ORDER_NAMES[o.key] || o.key;
        if (kept.length === G.DICE_COUNT) return '<span class="kr">спри · отчети <b>' + esc(tname) + '</b></span>';
        var d = kept.length ? '<span class="krd">' + kept.map(hintDie).join('') + '</span>' : '<span class="kr-none">нищо</span>';
        return '<span class="kr">дръж ' + d + ' · търсиш <b>' + esc(tname) + '</b></span>';
      }).join('');
    } else {
      head = 'Щабът съветва да отчетеш:';
      var ev = EV.evaluate(p.scores, game.turn.dice, game.turn.throwsLeft);
      alts = ev.category_ranked.slice(0, 3).map(function (c) {
        return '<span class="kr"><b>' + esc(G.ORDER_NAMES[c.key] || c.key) + '</b></span>';
      }).join('');
    }
    line.innerHTML = '<div class="hh">' + esc(head) + '</div><div class="krs">' + alts + '</div>';
    line.classList.remove('hidden');
  }

  // single header for both rulesets. LOCAL exp uses a constant 2-line name (persona inline, no
  // ribbons) and counts the round from filled cells; standard/net use the 1-line name + ribbons and
  // the net-aware round counter. The total + number-part chip are shared (total() is ruleset-aware,
  // and penalties only ever apply to local-standard play, so they're a no-op for exp).
  function renderHeader() {
    // a 'pretend next turn' penalty briefly shows the next player in the header
    var idx = fx.pretendNext ? (game.current + 1) % game.players.length : game.current;
    var p = game.players[idx];
    if (gExp() && !netMode) {
      // constant 2-line name: first two words on line 1, the rest + persona on line 2
      var words = esc(p.name).split(/\s+/);
      var l1 = (isOwnerP(p) ? ownerTokenHTML(true) : '') + words.slice(0, 2).join(' ');
      var rest = words.slice(2).join(' ');
      var persona = (p.isAI && p.persona) ? '<span class="pn-persona">⚙ ' + esc(p.persona.name) + '</span>' : (p.isAI ? '<span class="pn-persona">AI</span>' : '');
      var word2 = rest ? '<span class="pn-a">' + rest + '</span>' : '';   // spilled word keeps the full name style
      var line2 = (rest || persona) ? word2 + (rest && persona ? ' ' : '') + persona : '&nbsp;';
      $('curName').innerHTML = '<span class="pn2"><span class="pn-a">' + l1 + '</span><span class="pn-line2">' + line2 + '</span></span>';
      $('curPersona').classList.add('hidden'); $('curRibbons').innerHTML = '';   // persona inline; no ribbons
      var filled = X.filledCount(p.scores);
      $('curRound').innerHTML = Math.min(filled + 1, EXP_CELLS) + '<span class="rsub">/' + EXP_CELLS + '</span>';
    } else {
      $('curName').innerHTML = (isOwnerP(p) ? ownerTokenHTML(true) : '') + esc(p.name) + (p.isAI ? '<span class="badge-ai">AI</span>' : '');
      var per = $('curPersona');
      if (p.isAI && p.persona) { per.textContent = '⚙ ' + p.persona.name; per.classList.remove('hidden'); }
      else per.classList.add('hidden');
      // which turn of the game. net games don't run the local turn counter, so derive it from the
      // shown player's progress (their filled categories + 1) — works for the active AND watched player.
      var totalCats = sumExp() ? G.CATEGORIES_EXP.length : G.CATEGORIES.length;
      var roundNum = netMode ? Math.min(totalCats, filledCount(p) + 1) : game.round;
      $('curRound').innerHTML = roundNum + '<span class="rsub">/' + totalCats + '</span>';
      $('curRibbons').innerHTML = (p.ribbons || RIBBON_COLORS).map(function (c) { return '<i style="background:' + c + '"></i>'; }).join('');
    }
    // temporary penalties trim the DISPLAYED total: a fine, plus any zeroed-out combos (local-standard only)
    var blankCut = (fx.blank || []).reduce(function (s, k) { return s + (p.scores[k] || 0); }, 0);
    $('curTotal').textContent = total(p) - (fx.points || 0) - blankCut;
    $('curNumPart').classList.add('hidden');   // number-part chip is experimental-only
  }

  // readable number colour for a pill painted in the player's own colour
  function pillInk(hex) {
    var c = String(hex || '').replace('#', ''); if (c.length === 3) c = c[0] + c[0] + c[1] + c[1] + c[2] + c[2];
    var r = parseInt(c.substr(0, 2), 16) || 0, g = parseInt(c.substr(2, 2), 16) || 0, b = parseInt(c.substr(4, 2), 16) || 0;
    return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? '#1c1a0f' : '#fff';
  }
  function isMyNetPlayer(p) { return netMode && p && p.owner; }   // each device owns exactly its own seat
  function filledCount(p) { return sumCats().filter(function (c) { return G.isCategoryFilled(p, c.key); }).length; }
  // manual net free-for-all: shame a player who races 2+ categories ahead of the SLOWEST one
  function isMamnik(i) {
    if (!(netMode && gManual()) || !game) return false;
    var others = game.players.filter(function (p, j) { return j !== i && !p.dropped; });
    if (!others.length) return false;
    var minOther = Math.min.apply(null, others.map(filledCount));
    return filledCount(game.players[i]) >= minOther + 2;
  }
  function pillHTML(p, i) {
    var col = p.color || 'var(--gen-pill)';
    var mamnik = isMamnik(i) ? '<span class="mamnik">МАМНИК!</span>' : '';
    return '<button class="ppill' + (i === game.current ? ' on' : '') + (p.dropped ? ' dropped' : '') + (isMyNetPlayer(p) ? ' mine' : '')
      + (netMode && i === 0 ? ' host' : '')   // the host is always seat #1 — set them apart with a touch of right spacing
      + '" data-i="' + i + '" style="background:' + col + ';color:' + pillInk(p.color) + ';border-color:rgba(0,0,0,.4)" title="' + (p.dropped ? 'разпадна се' : '') + '">' + (p.dropped ? '📵' : total(p)) + mamnik + '</button>';
  }
  function renderPills() {
    $('pillWrap').innerHTML = game.players.map(pillHTML).join('');
    $('pillWrap').querySelectorAll('.ppill').forEach(function (b) {
      b.onclick = function () {
        var i = +b.getAttribute('data-i');
        // Network spectating: the pills are a "where am I looking" switch.
        if (netMode && !netMyTurn) {
          if (isMyNetPlayer(game.players[i])) {        // own marker → full during-turn board; re-tap jumps back
            if (specSelf) returnToCurrent(); else previewSelf();
            return;
          }
          var activeSeat = netActiveId != null ? netOrder.indexOf(netActiveId) : -1;
          if (i === activeSeat) { returnToCurrent(); return; }   // current player → switch to their live turn
          openPeek(i); return;                                   // any other player → read-only peek
        }
        openPeek(i);
      };
    });
  }

  // combo hints + the random penalties are retired — category names are no longer
  // tappable. The low-point shaming now fires automatically on a floor-flop commit.
  function attachTip(nameEl, key, isAI) { /* no-op */ }

  function boardKeys(group) {
    if (fx.order && fx.order[group]) return fx.order[group];
    return G.CATEGORIES.filter(function (c) { return c.group === group; }).map(function (c) { return c.key; });
  }
  function renderBoard() {
    var p = G.currentPlayer(game);
    // manual mode reuses the regular board: once all 5 table dice are tapped in,
    // every open category shows its suggestion chip exactly like in normal play
    var pv = game.turn.dice.length === G.DICE_COUNT ? computePreviews(p) : { prev: {}, cand: {}, best: null };
    var canScore = !game.turn.locked && game.turn.dice.length === G.DICE_COUNT && !fx.lock
      && (gManual() || (!p.isAI && !game.turn.awaitingRoll));
    // spectators see the same combo previews for the watched dice (read-only — no commit handlers)
    var watchPrev = netWatching() && game.turn.dice.length === G.DICE_COUNT;
    var showPrev = canScore || watchPrev;
    var hidden = fx.hide || [], blanked = fx.blank || [];

    $('boardUpper').innerHTML = '';
    boardKeys('upper').forEach(function (key) {
      if (hidden.indexOf(key) >= 0) return; // penalty: combo removed
      var c = CAT_BY_KEY[key];
      var done = G.isCategoryFilled(p, key);
      var val = done ? p.scores[key] : pv.prev[key];
      var forf = (fx.forfeit || []).indexOf(key) >= 0;
      var isVoid = (done && p.scores[key] === 0) || forf;
      var cls = 'tile up' + (done || forf ? ' done' : '') + (isVoid ? ' void' : '');
      var el = document.createElement('button');
      el.className = cls;
      // 0-point 1-6 combos show ✕ (forfeit) to match the lower combos, not a dot
      var zeroForfeit = showPrev && !done && !(val > 0);
      var pts = forf ? '·' : (done ? (blanked.indexOf(key) >= 0 ? '·' : p.scores[key]) : (val > 0 ? val : (showPrev ? '✕' : '·')));
      el.innerHTML = '<span class="face-n">' + c.label + '</span>'
        + '<span class="pts' + (showPrev && !done ? (zeroForfeit ? ' xchip' : ' upchip') : '') + '">' + pts + '</span>';
      if (canScore && !done) el.onclick = function () { val > 0 ? commitScore(key, val) : commitForfeit(key); };
      attachTip(el.querySelector('.face-n'), key, p.isAI && !gManual());
      $('boardUpper').appendChild(el);
    });

    $('boardLower').innerHTML = '';
    boardKeys('lower').forEach(function (key) {
      if (hidden.indexOf(key) >= 0) return;
      var c = CAT_BY_KEY[key];
      var done = G.isCategoryFilled(p, key);
      var forf = (fx.forfeit || []).indexOf(key) >= 0;
      var isVoid = (done && p.scores[key] === 0) || forf;
      var row = document.createElement('div');
      row.className = 'tile low' + (done || forf ? ' done' : '') + (isVoid ? ' void' : '');
      var html = '<span class="cname">' + c.label + '</span>';
      if (forf) {
        row.innerHTML = html + '<span class="lval">·</span>';
      } else if (done) {
        row.innerHTML = html + '<span class="lval">' + (blanked.indexOf(key) >= 0 ? '·' : p.scores[key]) + '</span>';
      } else {
        row.innerHTML = html + '<span class="acts"></span>';
        var acts = row.querySelector('.acts');
        if (showPrev) {
          var positives = (pv.cand[key] || []).filter(function (v) { return v > 0; });
          positives.forEach(function (v) {
            var chip = document.createElement('button'); chip.className = 'chip'; chip.textContent = v;
            if (canScore) chip.onclick = function (e) { e.stopPropagation(); commitScore(key, v); };
            else chip.disabled = true;
            acts.appendChild(chip);
          });
          var x = document.createElement('button'); x.className = 'x'; x.textContent = '×'; x.setAttribute('aria-label', 'откажи се');
          if (canScore) x.onclick = function (e) { e.stopPropagation(); commitForfeit(key); }; else x.disabled = true;
          acts.appendChild(x);
          if (canScore) {
            // tap the box to submit — but a multi-way combo still needs the exact number
            row.style.cursor = 'pointer';
            row.onclick = function () {
              if (positives.length === 1) commitScore(key, positives[0]);
              else if (positives.length > 1) showGuide(row, 'Няколко начина — удари точното число.');
              else showGuide(row, 'Нищо не става тук — откажи с ×.');
            };
          }
        }
      }
      attachTip(row.querySelector('.cname'), key, p.isAI && !gManual());
      $('boardLower').appendChild(row);
    });
  }

  // ---------- manual mode (ОТЧЕТ): tap in all 5 table dice, then pick a combo ----------
  // Requiring the full hand lets the board suggest every fillable category (so
  // nothing is missed mentally) AND enables category-decision analytics.

  function manualDiceArray() { return GReduce.manualDiceFromCounts(game.turn.manualCounts); }

  function renderManualDock() {
    var sel = $('manualSel'), diceBox = $('manualDice');
    var n = game.turn.dice.length;
    sel.innerHTML = n < G.DICE_COUNT
      ? 'Удари заровете от масата · <b class="livescore">' + n + '/' + G.DICE_COUNT + '</b>'
      : 'Избери категория от таблото ↑';
    diceBox.innerHTML = '';
    for (var f = 1; f <= 6; f++) (function (face) {
      var b = document.createElement('button');
      b.className = 'die mdie' + (game.turn.manualCounts[face] ? ' counted' : '');
      b.innerHTML = pipFace(face) + (game.turn.manualCounts[face] ? '<span class="mcount">' + game.turn.manualCounts[face] + '</span>' : '');
      b.onclick = function () { tapManualDie(face); };  // tap to count; ОПА removes the last tap
      diceBox.appendChild(b);
    })(f);
  }
  function tapManualDie(face) {
    var next = GReduce.reduce(game, { type: 'TAP_MANUAL', face: face });
    if (next === game) return;   // reduce no-ops when locked or the hand is already full
    game.turn = next.turn;
    undoStack.push({ t: 'tap', face: face });
    renderAll();
  }

  // ОПА — undoes action by action across the whole game: dice taps first, then
  // the commit before them (restoring that player's entered hand), and so on.
  function popUndo() {
    if (!undoStack.length) return;
    clearTimeout(turnTimer);                    // undoing mid-handover must not double-advance
    $('overModal').classList.add('hidden');     // in case we're undoing the final entry
    var a = undoStack.pop();
    if (a.t === 'commit') {   // score delete + moveLog pop are score/log-coupled → shell's job
      delete game.players[a.playerIdx].scores[a.key];
      if (moveLog[a.playerIdx] && moveLog[a.playerIdx].length) moveLog[a.playerIdx].pop();
    }
    var next = GReduce.reduce(game, { type: 'UNDO', entry: a });   // rewinds the hand + cursor
    game.turn = next.turn; game.current = next.current; game.round = next.round;
    clearRoast();
    renderAll();
  }
  $('undoBottom').onclick = popUndo;
  $('overUndo').onclick = popUndo;

  function renderDice() {
    if (gManual()) return;
    var p = G.currentPlayer(game);
    var box = $('dice'); box.innerHTML = '';
    if (game.turn.awaitingRoll) {
      // before the first throw: dimmed placeholder dice (no ?), the throw happens via the ХВЪРЛИ! button
      for (var k = 0; k < G.DICE_COUNT; k++) {
        var g = document.createElement('button'); g.className = 'die preroll'; g.disabled = true; g.setAttribute('aria-hidden', 'true');
        box.appendChild(g);
      }
      var td = ''; for (var q = 0; q < ROLLS - 1; q++) td += '<span class="tdot on"></span>';
      $('throws').innerHTML = td;
      return;
    }
    var interactive = !p.isAI && !game.turn.locked && game.turn.throwsLeft > 0 && !fx.lock;
    var watching = netWatching();   // rendering a watched opponent's frame (read-only)
    // penalty overrides: swap the dice, or hide some (centred remainder)
    var shown = fx.dice ? fx.dice : game.turn.dice;
    if (fx.diceKeep != null) shown = shown.slice(0, fx.diceKeep);
    // „Нови зарове": group the tray by generation (separators) instead of accenting. While watching,
    // it follows THE WATCHER's own setting (not the active player's), for easy scanning of new dice.
    var batchMode = (watching ? settings.newDiceBatch : activeBatch()) && !fx.dice && fx.diceKeep == null && game.turn.diceGen.length === shown.length;
    shown.forEach(function (v, i) {
      if (batchMode && i > 0 && game.turn.diceGen[i] !== game.turn.diceGen[i - 1]) {   // a generation boundary → divider between groups
        var sep = document.createElement('span'); sep.className = 'die-sep'; sep.setAttribute('aria-hidden', 'true');
        $('dice').appendChild(sep);
      }
      var b = document.createElement('button');
      var sel = !watching && !fx.dice && fx.diceKeep == null && game.turn.selected[i];
      var fresh = !batchMode && !fx.dice && fx.diceKeep == null && game.turn.diceNew[i];   // freshly thrown — gold accent (off in batch mode)
      var throwing = watching && specThrow && specThrow[i];                       // watcher: dice about to be re-thrown
      var specNew = specPulseOn && game.turn.diceGen.length === shown.length && game.turn.diceGen[i] === specRollNo;   // watcher: pulse the just-thrown dice
      var keepMode = activeKeep();
      b.className = 'die' + (sel ? ' sel' + (keepMode ? ' keep' : '') : '') + (fresh ? ' fresh' : '') + (throwing ? ' throwing' : '') + (specNew ? ' spec-pulse' : '');
      b.disabled = !interactive; b.setAttribute('data-i', i);
      b.setAttribute('aria-label', 'Зар ' + v + (sel ? (keepMode ? ', задържан' : ', за хвърляне') : ''));
      b.innerHTML = pipFace(v) + (sel ? '<span class="reticle">' + (keepMode ? '✓' : '✕') + '</span>' : '');
      if (interactive) b.onclick = function () { toggleSelect(i); };
      $('dice').appendChild(b);
    });
    var t = ''; for (var k = 0; k < ROLLS - 1; k++) t += '<span class="tdot' + (k < game.turn.throwsLeft ? ' on' : '') + '"></span>';
    $('throws').innerHTML = t;
  }

  function renderFire() {
    $('fire').classList.remove('muted');   // clear any leftover spectator styling
    syncSpecReturn(); syncRollAll();
    if (gManual()) { $('bottombar').classList.remove('preroll'); return; }
    // ---- network spectating: previewing my own board, or watching an opponent's turn ----
    if (netMode && specSelf) {
      $('bottombar').classList.remove('preroll');
      $('fire').classList.add('hidden'); $('fireQ').classList.add('hidden'); $('aiThinking').classList.add('hidden'); $('rollHint').classList.add('hidden');
      return;   // the RETURN-to-current button is shown separately
    }
    if (netMode && !netMyTurn && netAiActiveId == null && !game.turn.aiBusy) {
      $('bottombar').classList.remove('preroll');
      $('rollHint').classList.add('hidden'); $('aiThinking').classList.add('hidden'); $('fireQ').classList.add('hidden');
      var fo = $('fire'); fo.classList.remove('hidden'); fo.disabled = true; fo.classList.add('muted'); $('fireTxt').textContent = 'ХОД НА ОПОНЕНТА';
      return;
    }
    if (game.turn.awaitingRoll) {
      // before the first throw: only the centred ХВЪРЛИ! button (no dice, no ? chooser yet)
      $('bottombar').classList.add('preroll');
      $('rollHint').classList.add('hidden'); $('aiThinking').classList.add('hidden'); $('fireQ').classList.add('hidden');
      var fa = $('fire'); fa.classList.remove('hidden'); fa.disabled = false; $('fireTxt').textContent = 'ХВЪРЛИ!';
      return;
    }
    $('bottombar').classList.remove('preroll');
    $('rollHint').classList.add('hidden');
    var p = G.currentPlayer(game);
    var fire = $('fire'), think = $('aiThinking');
    if (p.isAI) { fire.classList.add('hidden'); $('fireQ').classList.add('hidden'); think.classList.toggle('hidden', !game.turn.aiBusy); return; }
    think.classList.add('hidden'); fire.classList.remove('hidden'); $('fireQ').classList.remove('hidden');
    // the button keys off whether the player has MARKED any dice (same in both modes):
    // nothing marked → prompt to choose; once marked → throw/keep the selection
    var keep = activeKeep(), someSel = game.turn.selected.some(Boolean), txt;
    if (game.turn.locked) { txt = '…'; fire.disabled = true; }
    else if (game.turn.throwsLeft <= 0) { txt = 'ИЗБЕРИ КОМБИНАЦИЯ!'; fire.disabled = true; }
    else if (!someSel) { txt = 'ИЗБЕРИ ЗАРОВЕ'; fire.disabled = true; }
    else { txt = keep ? 'ДРЪЖ!' : 'ХВЪРЛИ!'; fire.disabled = false; }
    $('fireTxt').textContent = txt;
  }

  // ---------- dice interaction (select-to-reroll) ----------
  var diceSlideSuppress = false;
  function toggleSelect(i) {
    if (diceSlideSuppress) return;   // a slide gesture handled selection; swallow the trailing tap
    if (game.turn.aiBusy || game.turn.locked || game.turn.throwsLeft <= 0) return;
    game.turn.selected[i] = !game.turn.selected[i];
    renderDice(); renderFire();
    // (no live broadcast of selections — watchers see the throw highlighted at reroll time instead)
  }
  // slide-to-select: drag across the dice to mark a run (works in both rulesets, local + net).
  // A plain tap still toggles one die (handled by each die's click); a drag paints toward the
  // first die's opposite state and swallows the trailing click so the start die isn't re-toggled.
  (function diceSlide() {
    var box = $('dice'); if (!box) return;
    box.style.touchAction = 'none';
    var pid = null, startIdx = -1, paintVal = false, slid = false;
    function selOk() { var p = game && game.players && game.players[game.current]; return !gManual() && !game.turn.awaitingRoll && !game.turn.locked && !game.turn.aiBusy && game.turn.throwsLeft > 0 && p && !p.isAI && !(netMode && (!netMyTurn || specSelf)); }
    function dieIdxAt(x, y) {
      var el = document.elementFromPoint(x, y); el = el && el.closest ? el.closest('.die') : null;
      if (!el || el.disabled || el.classList.contains('preroll')) return -1;
      var i = el.getAttribute('data-i'); return i == null ? -1 : +i;
    }
    function setSel(i, val) {
      if (i < 0 || i >= game.turn.selected.length || game.turn.selected[i] === val) return;
      game.turn.selected[i] = val;
      renderDice(); renderFire();
    }
    box.addEventListener('pointerdown', function (e) {
      if (!selOk()) return;
      var i = dieIdxAt(e.clientX, e.clientY); if (i < 0) return;
      pid = e.pointerId; startIdx = i; paintVal = !game.turn.selected[i]; slid = false;
      // NB: don't capture here — a plain tap must still deliver its click to the die button
    });
    box.addEventListener('pointermove', function (e) {
      if (pid == null || e.pointerId !== pid) return;
      var i = dieIdxAt(e.clientX, e.clientY); if (i < 0) return;
      if (!slid && i !== startIdx) { slid = true; try { box.setPointerCapture(pid); } catch (x) {} setSel(startIdx, paintVal); }   // a real slide began
      if (slid) setSel(i, paintVal);
    });
    function end(e) {
      if (e.pointerId !== pid) return;
      if (slid) { diceSlideSuppress = true; setTimeout(function () { diceSlideSuppress = false; }, 0); }
      pid = null; startIdx = -1; slid = false;
    }
    box.addEventListener('pointerup', end);
    box.addEventListener('pointercancel', end);
  })();
  $('fire').onclick = function () { humanFire(); };
  // „roll all": keep-mode helper that re-throws every die (keep nothing → reroll all)
  function syncRollAll() {
    var btn = $('rollAll'); if (!btn) return;
    var p = game && game.players && game.players[game.current];
    var watching = netMode && (!netMyTurn || specSelf);
    var show = !gManual() && !game.turn.awaitingRoll && !game.turn.locked && !game.turn.aiBusy && game.turn.throwsLeft > 0
      && p && !p.isAI && !watching && activeKeep() && game.turn.dice.length === G.DICE_COUNT;
    btn.classList.toggle('hidden', !show);
  }
  $('rollAll').onclick = function () {
    var p = game && game.players && game.players[game.current];
    if (gManual() || game.turn.awaitingRoll || game.turn.locked || game.turn.aiBusy || game.turn.throwsLeft <= 0 || !p || p.isAI) return;
    if (netMode && (!netMyTurn || specSelf)) return;
    game.turn.selected = [false, false, false, false, false];   // hold nothing → the reroll mask covers all five
    humanFire();   // routes to expHumanFire when gExp()
  };
  $('specReturn').onclick = function () { returnToCurrent(); };
  $('expAgain').onclick = function () { var ps = game.players; $('expOver').classList.add('hidden'); expStartGame(ps); };
  $('expToArchive').onclick = function () { $('expOver').classList.add('hidden'); openHistory(); };
  $('expOver').onclick = function (e) { if (e.target === $('expOver')) $('expOver').classList.add('hidden'); };
  // throw/keep chooser — the ? on the fire button. The flavour is PER HUMAN PLAYER:
  // activeKeep() reads the current player's own preference (falling back to the default).
  function activeKeep() {
    var p = game && game.players && game.players[game.current];
    if (p && !p.isAI && typeof p.selectKeep === 'boolean') return p.selectKeep;
    return !!settings.selectKeep;
  }
  // „Нови зарове": the current player's tray-display flavour (separate vs sort) — same per-player pattern as keep
  function activeBatch() {
    var p = game && game.players && game.players[game.current];
    if (p && !p.isAI && typeof p.diceBatch === 'boolean') return p.diceBatch;
    return !!settings.newDiceBatch;
  }
  function renderKeepThrowTip() {
    $('keepThrowTip').querySelectorAll('.kt-opt[data-keep]').forEach(function (b) {
      b.classList.toggle('on', (b.getAttribute('data-keep') === '1') === activeKeep());
    });
    $('keepThrowTip').querySelectorAll('.kt-batch').forEach(function (b) {
      b.classList.toggle('on', (b.getAttribute('data-batch') === '1') === activeBatch());
    });
  }
  function showKeepThrowTip() {
    var tip = $('keepThrowTip');
    if (!tip.classList.contains('hidden')) { tip.classList.add('hidden'); return; }
    renderKeepThrowTip(); tip.classList.remove('hidden');
    var r = $('fireQ').getBoundingClientRect();
    tip.style.left = Math.min(Math.max(8, r.left + r.width / 2 - tip.offsetWidth / 2), window.innerWidth - tip.offsetWidth - 8) + 'px';
    tip.style.top = Math.max(8, r.top - tip.offsetHeight - 8) + 'px';   // above the fire button
    if (tut) tutEvent('chooser');
  }
  $('fireQ').onclick = function (e) { e.stopPropagation(); showKeepThrowTip(); };
  $('keepThrowTip').querySelectorAll('.kt-opt[data-keep]').forEach(function (b) {
    b.onclick = function (e) {
      e.stopPropagation();
      var newKeep = b.getAttribute('data-keep') === '1';
      if (newKeep !== activeKeep()) {
        // switch the mechanic but KEEP the same marked dice — only their accent flips
        // (red ✕ "throw these" ⇄ green ✓ "keep these"); no confusing inversion.
        var p = game && game.players[game.current];
        if (p && !p.isAI) p.selectKeep = newKeep;               // the change sticks to THIS player
        if (!p || p.owner || p.isAI) { settings.selectKeep = newKeep; saveSettings(); }  // owner's choice is also the persistent default
        if (game) renderAll();
      }
      renderKeepThrowTip();
    };
  });
  // „Нови зарове" flavour — same per-player pattern; the owner's pick is also the saved default
  $('keepThrowTip').querySelectorAll('.kt-batch').forEach(function (b) {
    b.onclick = function (e) {
      e.stopPropagation();
      var nb = b.getAttribute('data-batch') === '1';
      if (nb !== activeBatch()) {
        var p = game && game.players[game.current];
        if (p && !p.isAI) p.diceBatch = nb;
        if (!p || p.owner || p.isAI) { settings.newDiceBatch = nb; saveSettings(); }
        if (game) renderAll();
      }
      renderKeepThrowTip();
    };
  });

  // which dice get RE-THROWN this fire — interprets the tap marks per the player's keep/throw flavour
  function rerollMask() { return activeKeep() ? game.turn.selected.map(function (s) { return !s; }) : game.turn.selected.slice(); }
  // re-roll the masked dice. Default: keep the tray sorted ascending, mark the new ones (accent).
  // „Нов набор зарове": stamp each die with its generation (the roll it was last thrown in) and
  // sort by (generation, value) so kept dice group on the left and the fresh batch lands ordered on the right.
  function applyReroll(rr) {
    // the shell rolls the masked dice (keeps reduce deterministic), reduce does the regroup/sort
    var faces = rr.map(function (m) { return m ? G.rollDie() : 0; });
    game.turn = GReduce.reduce(game, { type: 'REROLL', mask: rr, faces: faces, batch: activeBatch() }).turn;
  }
  function humanFire() {
    if (gExp()) { expHumanFire(); return; }
    if (game.turn.awaitingRoll) { firstRoll(); return; }   // first throw via the ХВЪРЛИ! button
    if (game.turn.aiBusy || game.turn.locked || game.turn.throwsLeft <= 0) return;
    if (tut) { tutReroll(); return; }            // tutorial: scripted reroll
    var rr = rerollMask();
    if (!rr.some(Boolean)) return;                    // nothing to throw
    if (rr.every(Boolean)) game.turn.rerolledAll = true;        // re-rolled the whole hand
    var kept = rr.map(function (x) { return !x; });
    applyReroll(rr);
    if (game.turn.curLog) { game.turn.curLog.keeps.push(kept); game.turn.curLog.rolls.push(game.turn.dice.slice()); }
    game.turn.selected = [false,false,false,false,false];
    game.turn.throwsLeft--;
    renderAll(); shakeDice();
    netSendAct();   // spectators see my reroll (newly-thrown dice accented)
  }

  function sortDice() { game.turn.dice.sort(function (a, b) { return a - b; }); }
  // dice are re-sorted after every throw, so the whole tray resettles
  function shakeDice() {
    $('dice').querySelectorAll('.die').forEach(function (el) {
      el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake');
    });
  }

  // ---------- commit / turn flow ----------
  function commitScore(key, value) {
    var p = G.currentPlayer(game);
    if (game.turn.aiBusy || game.turn.locked || (!gManual() && p.isAI) || G.isCategoryFilled(p, key)) return;
    if (tut && !tutCommitOk(key)) { tutNudge(); return; }
    G.assignScore(p, key, game.turn.dice, value);
    afterCommit(key, value);
  }
  function commitForfeit(key) {
    var p = G.currentPlayer(game);
    if (game.turn.aiBusy || game.turn.locked || (!gManual() && p.isAI) || G.isCategoryFilled(p, key)) return;
    if (tut && !tutCommitOk(key)) { tutNudge(); return; }
    G.forfeitScore(p, key);
    afterCommit(key, 0);
  }
  function afterCommit(key, value) {
    var p = G.currentPlayer(game);  // still the player who just committed
    if (tut) tutEvent('commit');
    var log = game.turn.curLog;
    if (game.turn.curLog) { game.turn.curLog.category = key; moveLog[game.current].push(game.turn.curLog); game.turn.curLog = null; }
    if (netMode && gManual()) {
      // FREE-FOR-ALL: record + broadcast my entry, then reset for my next category (no turn handover)
      var ment = { mask: evReady ? (EV.maskOfScores(p.scores) & ~EV.catBit(key)) : 0, dice: game.turn.dice.slice(), category: key };
      if (evReady) moveLog[game.current].push(ment);
      flashTile(key);
      if (net) net.submitMove({ category: catIndexOf(key), score: value, log: JSON.stringify(ment) });
      game.turn.locked = true; renderAll();
      if (G.isFloorFlop(key, value)) showRoast(key, value);   // казарма shaming, same as local
      setTimeout(beginManualEntry, END_DELAY);
      return;
    }
    if (netMode) {
      // broadcast my completed turn; the host's STATE + next GRANT drive the rest
      game.turn.locked = true; renderAll(); flashTile(key); $('fire').disabled = true;
      netSendAct({ commit: true, category: catIndexOf(key), value: value });   // spectators see the category go in
      if (netAiActiveId == null && G.isFloorFlop(key, value)) showRoast(key, value);   // казарма shaming on my own commit
      var mv = { category: catIndexOf(key), score: value, log: log ? JSON.stringify(log) : '' };
      // hold the committed board a beat (comprehension) before the move propagates and the turn passes
      if (netAiActiveId != null) { var aid = netAiActiveId; netAiActiveId = null; setTimeout(function () { if (net) net.submitMoveFor(aid, mv); }, NET_HANDOVER_DELAY); }  // host injects the AI seat's move
      else { netSay('🔊 Изпращам хода…'); setTimeout(function () { if (net) net.submitMove(mv); }, NET_HANDOVER_DELAY); }
      return;
    }
    if (gManual()) {
      // ОПА can rewind this commit (restoring the entered hand), and the turn is
      // logged for the category-only analytics (mask = the board BEFORE this pick)
      undoStack.push({ t: 'commit', playerIdx: game.current, key: key, prevRound: game.round, counts: game.turn.manualCounts.slice() });
      if (evReady) moveLog[game.current].push({ mask: EV.maskOfScores(p.scores) & ~EV.catBit(key), dice: game.turn.dice.slice(), category: key });
    }
    game.turn = GReduce.reduce(game, { type: 'COMMIT' }).turn;   // lock the turn
    renderAll();
    flashTile(key);
    $('fire').disabled = true;
    // after an AI turn, hold the board a beat so players can read it
    var delay = !gManual() && p.isAI ? AI_VIEW_DELAY : END_DELAY;
    if ((gManual() || !p.isAI) && G.isFloorFlop(key, value) && showRoast(key, value)) delay = ROAST_MS + 250;
    turnTimer = setTimeout(endTurn, delay);
  }
  var turnTimer = null;
  function flashTile(key) {
    // tiles aren't id-keyed; locate the committed tile by its position in its section (per ruleset)
    var cats = sumCats(), cat = cats.filter(function (c) { return c.key === key; })[0]; if (!cat) return;
    var host = cat.group === 'upper' ? $('boardUpper') : $('boardLower');
    var within = cats.filter(function (c) { return c.group === cat.group; }).map(function (c) { return c.key; }).indexOf(key);
    var el = host.children[within];
    if (!el) return;
    el.classList.add('flash');
    if (netWatching()) {   // spectator: a clear pulsing border on the chosen category
      el.classList.add('spec-pulse');
      el.addEventListener('animationend', function h() { el.classList.remove('spec-pulse'); el.removeEventListener('animationend', h); });
    }
  }
  function endTurn() {
    if (G.isGameOver(game)) { GReduce.reduce(game, { type: 'END_GAME' }); endGame(); return; }
    function advance() { var n = GReduce.reduce(game, { type: 'NEXT_TURN' }); game.current = n.current; game.round = n.round; }
    advance();
    if (tut) { while (game.players[game.current].isAI) advance(); }   // tutorial: the opponent never plays
    beginTurn();
  }

