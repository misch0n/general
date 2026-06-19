'use strict';
// Networked play: WebRTC (PeerJS) transport, lobby, spectating.
  // ===================================================== lobby flavour + net link status
  // rotating flavour accents per protocol stage — funny filler while the link negotiates
  var FLAV = {
    hostSearch: ['Ехо, има ли някой?', 'Търся някой за игра на Генерал…', 'Хайде да играем!', 'Кой е насреща?', 'Свирка! Сбор!'],
    clientSearch: ['Чувам ли някого?', 'Подушвам игра наблизо…', 'Хост, къде си?', 'Ало-ало?'],
    clientSaw: ['А, видях те!', 'Искам!', 'ГЕНЕРАЛ!', 'Пусни ме вътре!'],
    lobbyWait: ['Кога ще започваме?', 'Готов съм, командире.', 'Заровете тръпнат…', 'Хайде де, мързеливци!'],
    clientReady: ['Нагласи се и натисни „Готов".', 'Избери си цвят и име, войнико.', 'Старшината чака всички да са готови.'],
  };
  var flavTimer = null, flavEl = null, flavKey = null;
  function setFlavour(el, key) {
    if (flavKey === key && flavEl === el) return;            // already on this stage
    stopFlavour(); flavKey = key; flavEl = el;
    var lines = FLAV[key] || []; if (!lines.length || !el) return;
    var i = 0; el.textContent = lines[0];
    flavTimer = setInterval(function () { i = (i + 1) % lines.length; if (flavEl) flavEl.textContent = lines[i]; }, 4200);   // slower, calmer rotation
  }
  function stopFlavour() { if (flavTimer) clearInterval(flavTimer); flavTimer = null; flavEl = null; flavKey = null; }

  // WebRTC connection indicator: a dot by the turn marker
  var netReconnecting = false;
  function syncNetLink() {
    var nl = $('netLink'); if (!nl) return;
    if (!netMode) return;
    var up = !!(netBus && netBus.conns && netBus.conns.length > 0);
    var cls, lbl;
    if (net && net.isHost) { cls = 'up'; lbl = 'хост'; }
    else if (netReconnecting || !up) { cls = 'warn'; lbl = 'връзка…'; }
    else { cls = 'up'; lbl = 'свързан'; }
    nl.innerHTML = '<span class="condot ' + cls + '"></span><span class="conlbl">' + lbl + '</span>';
    nl.classList.remove('hidden');
  }

  // host rejected our join (e.g. we picked the wrong game mode) → explain + back to the chooser
  function netOnReject(reason) {
    var msg = (reason === 1)
      ? (netManual ? '⚠ Това е игра <b>със зарове</b>, а ти избра <b>ръчна</b>. Превключи режима горе и опитай пак.'
                   : '⚠ Това е <b>ръчна</b> игра, а ти избра <b>със зарове</b>. Превключи режима горе и опитай пак.')
      : '⚠ Хостът отказа връзката.';
    if (net) { try { net.dispose(); } catch (e) {} net = null; }
    if (netBus) { try { netBus.stop(); } catch (e) {} netBus = null; }
    stopScan(); stopFlavour();
    netShow('choose'); $('netPickRole').classList.remove('hidden'); $('netJoinCode').classList.add('hidden'); $('netOptical').classList.add('hidden');
    netChooseMsg(msg);
  }
  function netSay(s) { var el = $('netStatus'); if (el) el.innerHTML = s; }
  function localMeta() {
    applyOwnerName();
    var me = setupPlayers[0] || {};
    return { name: (me.name || 'Боец').trim() || 'Боец', color: me.color || '#cccccc', gender: me.gender || 'm' };
  }
  function renderNetRoster() {
    if (!net) return;
    $('netRoster').innerHTML = net.roster.map(function (m) {
      return '<div class="netp' + (m.dropped ? ' dropped' : '') + '"><span class="netdot" style="background:' + m.color + '"></span>' + esc(m.name)
        + (m.id === localPid ? ' <b>(ти)</b>' : '') + (m.id === MP.HOST_ID ? ' · старшина' : '') + (m.dropped ? ' <span class="netdrop">📵 разпадна се</span>' : '') + '</div>';
    }).join('');
  }
  function netCallbacks() {
    return {
      onStatus: function () {},                               // app drives all user-facing text (flavour/stage)
      onRoster: function () {
        if (netPhase === 'prep') { renderNetPrep(); return; }
        renderNetRoster();
        if (net.isHost && net.roster.length >= net.minPlayers) { $('netToPrep').classList.remove('hidden'); setFlavour($('netStatus'), 'lobbyWait'); }
        else if (net.isHost) setFlavour($('netStatus'), 'hostSearch');
      },
      onJoined: function (id, manual, exp) {
        localPid = id; track('join-success');
        // what I SELECTED on the start screen, before adopting the host's actual game
        var selM = netManual, selE = selExp();
        var hostM = (typeof manual === 'boolean') ? manual : selM, hostE = !!exp;
        if (typeof manual === 'boolean') { netManual = hostM; syncNetMode(); }   // adopt the host's mode (host rules win)
        if (net) net.rounds = hostE ? (X ? X.KEYS.length : 15) : G.CATEGORIES.length;
        netJoinMismatch(selM, selE, hostM, hostE);   // warn (don't block) if it differs from my selection
        renderNetRoster(); setFlavour($('netStatus'), 'lobbyWait');
      },
      onReject: function (reason) { track('join-error'); netOnReject(reason); },
      onHostGone: function () { netHostGone(); },             // host cancelled the lobby → back to picker
      onBeacon: function () { if (!net.isHost && net.myId == null) setFlavour($('netStatus'), 'clientSaw'); },
      onPrep: function () { enterNetPrep(); },
      onSpur: function (id, heat) { onNetSpur(id, heat); },
      onStart: function (roster, order) { stopFlavour(); startNetGame(roster, order); },
      onTurn: function (activeId) { netSetTurn(activeId); },
      onMove: function (mv) { netApplyRemote(mv); },
      onAction: function (a) { netSpectate(a); },                    // watch the active player roll/reroll/commit live
      onResync: function (scores) { netApplySnapshot(scores); },     // catching up after a reconnect
      onTakeover: function () { if (netMode) { renderAiTakeover(); renderAll && game && renderAll(); } },
      onPaused: function () { if (netMode) { renderAiTakeover(); netActiveSave(); } },   // host: a seat was paused/resumed
      onDrop: function (id, dropped) { netOnDrop(id, dropped); },
      onEnd: function () { if (netMode && game) endGame(); },
      onError: function () { if (netMode && game) trackGame('error'); },   // mid-game data/link failure
      onWait: function () { netOnWait(); },   // host: the rotation paused on a dropped seat (await reconnect / AI takeover)
    };
  }
  // the host's rotation is waiting on a player who dropped — tell everyone and surface the takeover menu
  function netOnWait() {
    if (!netMode || !game) return;
    netNotice('⏳ Чакам разпаднал се боец да се върне… (или го поеми с AI от менюто)');
    if (net && net.isHost) renderAiTakeover();
  }
  // mirror the host's dropped flags onto the live players, refresh the board, and surface it
  function netOnDrop(id, dropped) {
    if (!netMode || !game) { if (netPhase) renderNetRoster(); return; }
    syncNetDropped();
    var seat = netOrder.indexOf(id), pl = seat >= 0 ? game.players[seat] : null;
    if (pl) netNotice((dropped ? '📵 ' : '✅ ') + esc(pl.name) + (dropped ? ' се разпадна — прескачам го' : ' се върна в битката'));
    renderAll();
  }
  // a transient in-game notice (reuses the roast bubble chrome) for drop/reconnect events
  function netNotice(html) {
    var box = $('roast'); if (!box) return;
    box.className = 'roast show order';
    box.innerHTML = '<span class="bubble">' + html + '</span>';
    box.querySelector('.bubble').onclick = clearRoast;
    clearTimeout(roastTimer); roastTimer = setTimeout(clearRoast, 3500);
  }
  // copy roster.dropped → game.players[].dropped (matched by netId)
  function syncNetDropped() {
    if (!game || !net) return;
    var byId = {}; net.roster.forEach(function (m) { byId[m.id] = m; });
    game.players.forEach(function (p) { if (p.netId != null && byId[p.netId]) p.dropped = !!byId[p.netId].dropped; });
  }
  // apply a host snapshot (id → {catIdx: score}) onto the local board after a reconnect
  function netApplySnapshot(scores) {
    if (!netMode || !game) return;
    Object.keys(scores).forEach(function (idStr) {
      var seat = netOrder.indexOf(+idStr); if (seat < 0) return;
      var cells = scores[idStr];
      Object.keys(cells).forEach(function (cIx) {
        var key = catKeyAt(+cIx);   // re-read the seat each cell: APPLY_SCORE replaces the players array
        if (key && !G.isCategoryFilled(game.players[seat], key))
          game.players = GReduce.reduce(game, { type: 'APPLY_SCORE', seat: seat, key: key, score: cells[cIx] }).players;
      });
    });
    syncNetDropped(); renderAll();
  }
  // ---------- lobby preparation UI ----------
  function netShow(phase) {
    netPhase = phase;
    if ($('netOptical')) $('netOptical').classList.add('hidden');         // leaving the QR view
    $('netChoose').classList.toggle('hidden', phase !== 'choose');
    $('netLobby').classList.toggle('hidden', phase === 'choose');
    $('netScan').classList.toggle('hidden', phase !== 'scan');
    $('netPrep').classList.toggle('hidden', phase !== 'prep');
  }
  // bitmask of enabled pre-game settings — only the GAMEPLAY-modifying ones (shown to all in the lobby)
  var SETT_BITS = [['titles', 'Редки титли'], ['titlePoints', 'Бонус точки'], ['bets', 'Облози']];
  function settingsBits() { var b = 0; SETT_BITS.forEach(function (s, i) { if (settings[s[0]]) b |= (1 << i); }); return b; }
  function renderSettSummary(bits) {
    var on = SETT_BITS.filter(function (s, i) { return bits & (1 << i); });
    // lead with the host's game mode so joiners see what they joined (dice vs manual)
    var mode = '<span class="sc mode">' + (net && net.manual ? '✍ Ръчно' : '🎲 Със зарове') + '</span>';
    $('netSettSummary').innerHTML = mode + (on.length
      ? on.map(function (s) { return '<span class="sc">' + s[1] + '</span>'; }).join('')
      : '<span class="sc none">стандартни правила</span>');
  }
  function netMyEntry() { return net ? net.roster.filter(function (m) { return m.id === localPid; })[0] : null; }
  // host opens prep; clients are pulled in by the PREP message
  function enterNetPrep() {
    resetSpur(); netEditing = false;
    var me = netMyEntry() || {};
    netMe = { name: me.name || localMeta().name, color: me.color || '#d4a02e', gender: me.gender || 'm' };
    netMyReady = !!me.ready;
    netShow('prep');
    renderSettSummary(net.settingsBits);
    $('netHostTools').classList.toggle('hidden', !net.isHost);
    $('netAddAI').classList.toggle('hidden', net.manual || net.exp);   // no AI seats in a manual game (or minus net — exp AI scoring isn't wired)
    $('netReady').classList.toggle('hidden', net.isHost);   // host has no ready button — it starts
    $('netStart').classList.toggle('hidden', !net.isHost);
    renderNetMeCard(); renderNetPrep();
    setFlavour($('netStatus'), net.isHost ? 'lobbyWait' : 'clientReady');
  }
  function renderNetMeCard() {
    var card = $('netMeCard');
    // the gender picker only inflects RANDOM Bulgarian names; if the player set their own
    // owner name, the name is their choice and gender is irrelevant — so hide the picker.
    var ownNamed = !!(settings.useOwnerName && settings.ownerName.trim());
    card.innerHTML = '<div class="nm-row"><button type="button" class="cbtn" id="netMeColor" title="Цвят" style="background:' + netMe.color + '"></button>'
      + '<input class="nm-name" id="netMeNameInput" maxlength="28" value="' + esc(netMe.name) + '"></div>'
      + (ownNamed ? '' : '<div class="gender" id="netMeGender">'
        + [['m', 'мъжко'], ['n', 'то'], ['f', 'женско']].map(function (g) { return '<button class="glabel g-' + g[0] + (netMe.gender === g[0] ? ' on' : '') + '" data-g="' + g[0] + '">' + g[1] + '</button>'; }).join('')
        + '</div>');
    $('netMeColor').onclick = function (e) {
      e.stopPropagation();
      touchedField();   // opening the colour picker signals intent to change → a ready client reverts to ГОТОВ
      // offer only colours no other device is using (the host dedupes anyway, but show free ones)
      var used = net.roster.filter(function (m) { return m.id !== localPid; }).map(function (m) { return (m.color || '').toLowerCase(); });
      openColorPop($('netMeColor'), netMe.color, 'netme', function (c) { netMe.color = c; $('netMeColor').style.background = c; pushMyMeta(true); markEdited(); }, freeSwatches(netMe.color, used));
    };
    $('netMeNameInput').onfocus = function () { touchedField(); };   // even touching the box reverts a ready client
    $('netMeNameInput').oninput = function () { netMe.name = $('netMeNameInput').value; pushMyMeta(false); markEdited(); };  // debounced
    var gw = $('netMeGender');
    if (gw) gw.querySelectorAll('.glabel').forEach(function (gb) {
      gb.onclick = function () { netMe.gender = gb.getAttribute('data-g'); renderNetMeCard(); pushMyMeta(true); markEdited(); };
    });
  }
  // host has no „ready" — but editing a field arms a „ГОТОВ!" confirm on the action button
  var netEditing = false;
  function setMyReady(v) { netMyReady = v; if (net) net.setReady(v); var e = netMyEntry(); if (e) e.ready = v; }   // optimistic local marker
  // a client editing (or even touching) a field cancels their ready; the host arms „ГОТОВ!"
  function markEdited() {
    if (!net) return;
    if (net.isHost) { netEditing = true; renderNetPrep(); }
    else if (netMyReady) { setMyReady(false); renderNetPrep(); }
  }
  function touchedField() { if (net && !net.isHost && netMyReady) { setMyReady(false); renderNetPrep(); } }   // focus alone reverts a ready client
  // send my edited meta to the host; debounce typing, fire colour/gender at once
  function pushMyMeta(immediate) {
    clearTimeout(netMetaTimer);
    var send = function () { if (net) net.setMyMeta({ name: (netMe.name || 'Боец').trim() || 'Боец', color: netMe.color, gender: netMe.gender }); };
    if (immediate) send(); else netMetaTimer = setTimeout(send, 550);
  }
  // ---------- „ДАЙ ЗОР" lobby cheer: a spammable button that spurs YOUR entry; heat reddens the
  // row + speeds a rotating cheer; it decays when you stop. Broadcast so everyone sees it. ----------
  var SPUR_MSGS = ['Айде бе!', 'По-бързо!', 'Стегнете се!', 'До кога ще чакам?', 'Бавняри!', 'Кога ще почваме?', 'Айде бе, свине!', 'Мързеливци!', 'Заспахте ли?', 'Стига сте се мотали!', 'Цял ден ли ще се излежавате?', 'Размърдайте се!'];
  var GARBLE_CHARS = '€$¥&)(@#%*!?§£¢¤½‰±×÷~^¶•';
  var FULL_RAGE = 0.5;   // heat at/above this = full rage → the cheer turns into garbled special chars (lower = garbles sooner)
  var spurHeat = {}, spurClicks = {}, spurGarble = {}, spurGarbleT = {}, spurRaf = 0, spurLast = 0, spurTxAt = 0;
  function nowMs() { return (window.performance && performance.now) ? performance.now() : Date.now(); }
  // which message a player is on, by how many times they've hit ДАЙ ЗОР this burst:
  // 1st hit → msg 0; then it takes +2 hits for msg 1, +3 for msg 2, +4 for msg 3, … (rising threshold)
  function spurMsgForClicks(c) {
    if (c < 1) return 0;
    var idx = 0, thr = 1, gap = 2;
    while (c >= thr + gap) { thr += gap; gap++; idx++; }
    return idx;
  }
  // full rage: garbled special chars, same length as the message it replaces (re-shuffled ~9×/s)
  function garbleFor(id, len) {
    var now = Date.now();
    if (!spurGarble[id] || spurGarble[id].length !== len || now - (spurGarbleT[id] || 0) > 110) {
      var s = ''; for (var i = 0; i < len; i++) s += GARBLE_CHARS.charAt(Math.floor(Math.random() * GARBLE_CHARS.length));
      spurGarble[id] = s; spurGarbleT[id] = now;
    }
    return spurGarble[id];
  }
  function spurBump(id) {
    var was = spurHeat[id] || 0;
    spurHeat[id] = Math.min(1, was + 0.17);
    spurClicks[id] = (was > 0.01 ? (spurClicks[id] || 0) : 0) + 1;   // count hits this burst (resets when cooled)
    applySpurVisual(id); startSpurLoop();
  }
  function spurMe() {
    if (netPhase !== 'prep' || !net || localPid == null) return;
    spurBump(localPid);
    var t = Date.now();
    if (t - spurTxAt > 110 && net.sendSpur) { spurTxAt = t; net.sendSpur(spurHeat[localPid], spurClicks[localPid] || 0); }   // throttle the broadcast
  }
  function onNetSpur(id, heat, clicks) {
    spurHeat[id] = Math.max(spurHeat[id] || 0, heat);
    if (clicks != null) spurClicks[id] = clicks;
    applySpurVisual(id); startSpurLoop();
  }
  function startSpurLoop() { if (spurRaf) return; spurLast = nowMs(); spurRaf = requestAnimationFrame(spurTick); }
  function spurTick(t) {
    var n = t || nowMs(), dt = Math.min(120, n - spurLast); spurLast = n; var any = false;
    Object.keys(spurHeat).forEach(function (id) {
      var h = spurHeat[id]; if (!h) return;
      h *= Math.pow(0.90, dt / 100); if (h < 0.02) { h = 0; spurClicks[id] = 0; }   // cooled → reset the burst
      spurHeat[id] = h;
      if (h > 0) any = true;
      applySpurVisual(id);
    });
    spurRaf = any ? requestAnimationFrame(spurTick) : 0;
  }
  function applySpurVisual(id) {
    var box = $('netPrepRoster'); if (!box) return;
    var row = box.querySelector('.netpp[data-id="' + id + '"]'); if (!row) return;
    var h = spurHeat[id] || 0; row.style.setProperty('--heat', h.toFixed(3));
    var sp = row.querySelector('.pp-spur'); if (!sp) return;
    if (h <= 0.05) { sp.textContent = ''; sp.style.opacity = 0; sp.classList.remove('rage'); return; }
    var base = SPUR_MSGS[Math.min(spurMsgForClicks(spurClicks[id] || 0), SPUR_MSGS.length - 1)] || SPUR_MSGS[0];
    var rage = h >= FULL_RAGE;
    sp.textContent = rage ? garbleFor(id, base.length) : base;
    sp.classList.toggle('rage', rage);
    sp.style.opacity = Math.min(1, 0.55 + h * 1.2);
  }
  function resetSpur() { spurHeat = {}; spurClicks = {}; spurGarble = {}; spurGarbleT = {}; if (spurRaf) { cancelAnimationFrame(spurRaf); spurRaf = 0; } }
  function renderNetPrep() {
    if (!net) return;
    $('netPrepRoster').innerHTML = net.roster.map(function (m) {
      var tags = (m.id === MP.HOST_ID ? '<span class="pp-tag">старшина</span>' : '') + (m.isAI ? '<span class="pp-tag">🤖 AI</span>' : '');
      var rdy = m.id === MP.HOST_ID || m.isAI ? ''
        : (m.ready ? '<span class="pp-rdy ready" title="готов"></span>'
                   : '<span class="pp-cfg" title="нагласява се"><i></i><i></i><i></i></span>');
      var kick = (net.isHost && m.isAI) ? '<button class="pp-kick" data-id="' + m.id + '">✕</button>' : '';
      return '<div class="netpp" data-id="' + m.id + '" style="--heat:' + ((spurHeat[m.id] || 0).toFixed(3)) + '"><span class="netdot" style="background:' + m.color + '"></span><span class="pp-nm">' + esc(m.name)
        + (m.id === localPid ? ' (ти)' : '') + '</span>' + tags + rdy + kick + '<span class="pp-spur"></span></div>';
    }).join('');
    $('netPrepRoster').querySelectorAll('.pp-kick').forEach(function (b) {
      b.onclick = function () { net.removeAI(+b.getAttribute('data-id')); };
    });
    Object.keys(spurHeat).forEach(applySpurVisual);
    // keep my own name input in sync if the host renamed me on a collision (don't fight the cursor)
    var mine = netMyEntry(), inp = $('netMeNameInput');
    if (mine && inp && document.activeElement !== inp && mine.name !== netMe.name) { netMe.name = mine.name; inp.value = mine.name; }
    if (mine && mine.color && mine.color.toLowerCase() !== (netMe.color || '').toLowerCase()) { netMe.color = mine.color; if ($('netMeColor')) $('netMeColor').style.background = mine.color; }
    $('netMeCard').classList.toggle('ready', netMyReady);   // green tint when ready (fields stay editable)
    if (net.isHost) {
      $('netStart').disabled = false;
      if (netEditing) {
        $('netStart').classList.remove('spur'); $('netStart').classList.add('confirm'); $('netStart').textContent = '✔ ГОТОВ!';
      } else {
        var allRdy = net.allReady();
        $('netStart').classList.remove('confirm');
        $('netStart').classList.toggle('spur', !allRdy);
        $('netStart').textContent = allRdy ? '⚔ Започни битката' : '🔥 ДАЙ ЗОР!';
      }
    } else {
      $('netReady').classList.toggle('on', netMyReady);
      $('netReady').classList.toggle('spur', netMyReady);
      // not ready → „ГОТОВ!" with the same green-circle tick used on the roster rows
      $('netReady').innerHTML = netMyReady ? '🔥 ДАЙ ЗОР!' : 'ГОТОВ! <span class="rdy-ic"></span>';
    }
  }
  // the ruleset I'm SELECTING for a net game I host/join (the host's wins after JOIN_ACK adoption)
  function selExp() { return settings.ruleset === 'experimental'; }
  function netRounds() { return selExp() ? (X ? X.KEYS.length : 15) : G.CATEGORIES.length; }
  // the ruleset the net game actually runs by (host-authoritative: net.exp once adopted)
  function netRuleset() { return (net && net.exp) ? 'experimental' : 'standard'; }
  function newSessionWith(transport, isHost, eph) {
    return new MP.Session({ transport: transport, isHost: isHost, me: localMeta(), eph: eph, manual: netManual, exp: selExp(), minPlayers: 2, maxPlayers: 6, rounds: netRounds(), callbacks: netCallbacks() });
  }
  // a client persists its eph (player identity) per game code, so a reconnect/reload rejoins
  // the same seat the host already knows — rather than seating a brand-new boец.
  function wrEphKey(code) { return 'genrl:wrtc:eph:' + code; }
  function wrLoadEph(code) { var v = lsGet(wrEphKey(code)); v = v && parseInt(v, 10); return (v && v > 0 && v < 65535) ? v : null; }
  function wrSaveEph(code, eph) { try { lsSet(wrEphKey(code), String(eph)); } catch (e) {} }
  // an in-progress WebRTC game is remembered (code + role + last activity) so a reload/crash within
  // 15 min can offer to rejoin; older entries are treated as stale and cleaned up.
  var NET_ACTIVE_KEY = 'genrl:wrtc:active', NET_REJOIN_MS = 15 * 60 * 1000, netRejoinEntry = null;
  function netActiveSave() {
    if (!wrCode || !net) return;
    try {
      var e = { code: wrCode, role: net.isHost ? 'host' : 'client', manual: !!net.manual, exp: !!net.exp, ts: Date.now() };
      if (net.isHost && net.snapshot) { var s = net.snapshot(); if (s) e.snap = s; }   // host keeps the authoritative state for crash recovery
      lsSet(NET_ACTIVE_KEY, JSON.stringify(e));
    } catch (x) {}
  }
  function netActiveLoad() { try { var o = JSON.parse(lsGet(NET_ACTIVE_KEY) || 'null'); return (o && typeof o.code === 'string' && /^[A-Z0-9]{4,8}$/.test(o.code)) ? o : null; } catch (e) { return null; } }
  // host: re-snapshot the authoritative state on every move; client: just refresh the timestamp
  function netActiveTouch() {
    if (net && net.isHost) { netActiveSave(); return; }
    var o = netActiveLoad(); if (o) { o.ts = Date.now(); try { lsSet(NET_ACTIVE_KEY, JSON.stringify(o)); } catch (e) {} }
  }
  function netActiveClear() { lsDel(NET_ACTIVE_KEY); }
  // returning to the foreground after a background (esp. iOS, where the host may switch tabs while
  // waiting for their turn): reconcile so no updates are lost. The host re-broadcasts its state;
  // a client asks the host to catch it up. The transport reconnects separately if the link dropped.
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible' || !netMode || !net) return;
    try {
      if (net.isHost) { if (net.rebroadcast) net.rebroadcast(); netActiveSave(); }
      else if (net.rejoin) net.rejoin();
    } catch (e) {}
  });
  // ===================================================== WebRTC transport (PeerJS) ==============
  // A pluggable MP.Session transport over WebRTC data channels. PeerJS provides the public
  // signalling cloud (no account/server needed) just for the handshake; gameplay is P2P.
  // It runs a BROADCAST bus: the host sends to every client connection, a client
  // sends to the host, and the host re-broadcasts state — so the session needs no topology change.
  var PEER_PREFIX = 'genrl1-';                 // namespaces our peer ids on the shared PeerJS cloud
  // ICE servers for NAT traversal. STUN handles same-network play; a real TURN RELAY is needed
  // across different networks (cellular ↔ Wi-Fi / symmetric NAT). These are a Metered.ca relay
  // (free tier) — all transports (udp/tcp/443/turns) so even restrictive firewalls find a path.
  // The WebRTC-debug panel can override this with a custom iceServers JSON at runtime.
  var DEFAULT_ICE = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun.relay.metered.ca:80' },
    { urls: 'turn:global.relay.metered.ca:80', username: '3e79b3c318986af67e0f9bb1', credential: 'quOGERYHPcVcTY8Q' },
    { urls: 'turn:global.relay.metered.ca:80?transport=tcp', username: '3e79b3c318986af67e0f9bb1', credential: 'quOGERYHPcVcTY8Q' },
    { urls: 'turn:global.relay.metered.ca:443', username: '3e79b3c318986af67e0f9bb1', credential: 'quOGERYHPcVcTY8Q' },
    { urls: 'turns:global.relay.metered.ca:443?transport=tcp', username: '3e79b3c318986af67e0f9bb1', credential: 'quOGERYHPcVcTY8Q' },
  ];
  // custom iceServers (JSON array) override the default when provided + valid
  function customIce() {
    var raw = (settings.iceServers || '').trim(); if (!raw) return null;
    try { var a = JSON.parse(raw); return (Array.isArray(a) && a.length) ? a : null; } catch (e) { return null; }
  }
  function peerOpts() { return { config: { iceServers: customIce() || DEFAULT_ICE } }; }
  function genGameCode() { var a = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789', s = ''; for (var i = 0; i < 6; i++) s += a.charAt(Math.floor(Math.random() * a.length)); return s; }
  function loadPeerJS(cb) {
    if (window.Peer) { cb(true); return; }
    var t0 = Date.now();
    var s = document.createElement('script'); s.src = 'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js';
    s.onload = function () { wrlog('peerjs-load', { ok: !!window.Peer, ms: Date.now() - t0 }); cb(!!window.Peer); };
    s.onerror = function () { wrlog('peerjs-load', { ok: false, error: 'script-load-failed', ms: Date.now() - t0 }); cb(false); };
    document.head.appendChild(s);
  }
  // ---------- WebRTC capture (records every connection event + frame for offline debugging) ----------
  var wrLog = [], wrT0 = Date.now(), wrRole = '', wrCode = '';
  function wrTypeName(t) { if (window.MP && MP.T) { for (var k in MP.T) if (MP.T[k] === t) return k; } return String(t); }
  function wrlog(ev, data) {
    if (!settings.webrtcDebug) return;
    var e = { t: Date.now() - wrT0, ev: ev };
    if (data) for (var k in data) e[k] = data[k];
    wrLog.push(e); if (wrLog.length > 3000) wrLog.shift();
    syncWrCapStatus();
  }
  function wrCapReset(role, code) {
    wrT0 = Date.now(); wrLog = []; wrRole = role || wrRole || ''; wrCode = code || wrCode || '';
    wrlog('env', { app: APP_VERSION, role: wrRole, code: wrCode, ua: navigator.userAgent, online: navigator.onLine,
      proto: location.protocol, hasPeer: !!window.Peer,
      hasRTC: !!(window.RTCPeerConnection || window.webkitRTCPeerConnection || window.mozRTCPeerConnection) });
  }
  function wrFrame(bytes) {
    var info = { len: (bytes && bytes.length) || 0 };
    try { var u = MP.unframe(bytes); if (u) { info.type = wrTypeName(u.type); info.from = u.sender; info.seq = u.seq; info.plen = u.payload ? u.payload.length : 0; } else info.type = '∅unframed'; } catch (e) { info.type = '∅err'; }
    return info;
  }
  function wrPeerErr(e) { return { type: (e && e.type) || null, message: (e && e.message) || String(e) }; }
  // ICE-level diagnostics: shows whether STUN/TURN candidates are gathered, whether the TURN
  // server authenticates (icecandidateerror code 401), and whether ICE actually connects/fails.
  function candType(c) { var m = / typ (\w+)/.exec(c || ''); return m ? m[1] : '?'; }
  function wrAttachIce(conn, who) {
    if (!settings.webrtcDebug || !conn) return;
    var tries = 0, seen = {};
    (function grab() {
      var pc = conn.peerConnection;
      if (!pc) { if (tries++ < 25) setTimeout(grab, 150); return; }
      if (pc._wrHooked) return; pc._wrHooked = true;
      try {
        wrlog('ice-attach', { who: who, ice: pc.iceConnectionState, gather: pc.iceGatheringState });
        pc.addEventListener('iceconnectionstatechange', function () { wrlog('ice-state', { who: who, state: pc.iceConnectionState }); });
        pc.addEventListener('icegatheringstatechange', function () { wrlog('ice-gather', { who: who, state: pc.iceGatheringState }); });
        pc.addEventListener('icecandidate', function (e) {
          if (!e.candidate) { wrlog('ice-cand-end', { who: who }); return; }
          var typ = candType(e.candidate.candidate);
          if (!seen[typ]) { seen[typ] = 1; wrlog('ice-cand', { who: who, typ: typ, proto: e.candidate.protocol }); }   // one per type to stay compact
        });
        pc.addEventListener('icecandidateerror', function (e) { wrlog('ice-cand-err', { who: who, code: e.errorCode, url: (e.url || '').slice(0, 40), text: (e.errorText || '').slice(0, 50) }); });
      } catch (err) { wrlog('ice-attach-fail', { message: err && err.message }); }
    })();
  }
  function syncWrCapStatus() { var el = $('wrCapStatus'); if (el) el.textContent = settings.webrtcDebug ? (wrLog.length + ' събития записани') : 'дебъгът е изключен'; }
  function syncWrCapVis() {
    var box = $('wrCap'); if (!box) return;
    var show = !$('netModal').classList.contains('hidden') && settings.webrtc && settings.webrtcDebug;
    box.classList.toggle('hidden', !show); syncWrCapStatus(); if (show) syncIceField();
  }
  function syncIceField() { var t = $('wrIce'); if (t) t.value = settings.iceServers || ''; iceStatus(); }
  function iceStatus() {
    var el = $('wrIceStatus'); if (!el) return;
    var n = (customIce() || []).length;
    el.textContent = n ? ('✓ ' + n + ' собствени ICE сървъра') : 'по подразбиране (STUN + безплатен TURN)';
  }
  function PeerBus(opts) {
    this.isHost = !!opts.isHost; this.code = opts.code;
    this.peer = null; this.conns = []; this._rx = null;
    this.onPeers = opts.onPeers || function () {}; this.onLost = opts.onLost || function () {};
    this.onReup = opts.onReup || function () {};   // client: a dropped data channel was re-established
    this.maxPayload = 60000;
  }
  PeerBus.prototype.onReceive = function (cb) { this._rx = cb; };   // MP.Session transport interface
  PeerBus.prototype.send = function (bytes) {
    var arr = bytes;                                                  // BinaryPack ships the typed array as-is
    var n = 0; this.conns.forEach(function (c) { if (c && c.open) { try { c.send(arr); n++; } catch (e) { wrlog('tx-error', { message: e.message }); } } });
    if (settings.webrtcDebug) { var f = wrFrame(bytes); f.to = n; wrlog('tx', f); }
    return Promise.resolve();
  };
  PeerBus.prototype._addConn = function (conn) {
    var self = this; this.conns.push(conn);
    wrlog('conn-add', { peer: conn.peer, n: this.conns.length });
    conn.on('data', function (data) {
      var b = data instanceof Uint8Array ? data : new Uint8Array(data);
      // host: tag this connection with the player id it carries, so a close maps to a dropped seat
      if (self.isHost) { try { var u = MP.unframe(b); if (u && u.sender > 0 && u.sender < 15) conn._pid = u.sender; } catch (e) {} }
      if (settings.webrtcDebug) wrlog('rx', wrFrame(b));
      if (self._rx) self._rx(b);
    });
    conn.on('close', function () {
      wrlog('conn-close', { peer: conn.peer, pid: conn._pid });
      self.conns = self.conns.filter(function (c) { return c !== conn; });
      self.onPeers(self.conns.length); self.onLost(conn);
      if (!self.isHost) self._scheduleRedial();   // client: lost the host — try to get back in
    });
    conn.on('error', function (e) { wrlog('conn-error', wrPeerErr(e)); });
    self.onPeers(self.conns.length);
  };
  // the PeerJS broker websocket can drop (iOS backgrounding, flaky free cloud) without killing
  // live data channels — but new joins need it. Re-establish it (same id) instead of giving up.
  PeerBus.prototype._reconnect = function () {
    var self = this;
    if (self._stopped || !self.peer || self.peer.destroyed) return;
    self._recon = (self._recon || 0) + 1;
    if (self._recon > 8) { wrlog('reconnect-giveup', { attempts: self._recon }); return; }
    setTimeout(function () {
      if (self._stopped || !self.peer || self.peer.destroyed || !self.peer.disconnected) return;
      wrlog('peer-reconnect', { attempt: self._recon });
      try { self.peer.reconnect(); } catch (e) { wrlog('reconnect-error', { message: e.message }); }
    }, Math.min(800 * self._recon, 4000));
  };
  // client: (re)establish the data channel to the host. `first` carries the initial start()
  // resolve/reject; a redial (first=null) instead fires onReup so the session can re-announce.
  PeerBus.prototype._dialHost = function (first) {
    var self = this;
    if (self._stopped || self._dialing || self.conns.length || !self.peer || self.peer.destroyed) return;
    self._dialing = true;
    wrlog('conn-attempt', { target: PEER_PREFIX + self.code, redial: !first });
    var conn, settled = false;
    var settle = function (okFn) { if (settled) return; settled = true; self._dialing = false; okFn(); };
    try { conn = self.peer.connect(PEER_PREFIX + self.code, { reliable: true }); }
    catch (e) { self._dialing = false; if (first) first.fail(e); else self._scheduleRedial(); return; }
    wrAttachIce(conn, 'client');
    var t = setTimeout(function () { settle(function () { wrlog('conn-timeout', { redial: !first }); if (first) first.fail(new Error('timeout')); else self._scheduleRedial(); }); }, 20000);
    conn.on('open', function () { clearTimeout(t); settle(function () {
      wrlog('client-conn-open', { peer: conn.peer, redial: !first }); self._redialN = 0; self._addConn(conn);
      if (first) first.ok(); else self.onReup();
    }); });
    conn.on('error', function (e) { clearTimeout(t); settle(function () { wrlog('client-conn-error', wrPeerErr(e)); if (first) first.fail(e); else self._scheduleRedial(); }); });
  };
  PeerBus.prototype._scheduleRedial = function () {
    var self = this;
    if (self._stopped || self.conns.length) return;
    self._redialN = (self._redialN || 0) + 1;
    if (self._redialN > 20) { wrlog('redial-giveup', { attempts: self._redialN }); return; }
    wrlog('redial-schedule', { attempt: self._redialN });
    setTimeout(function () { if (!self._stopped && !self.conns.length) self._dialHost(null); }, Math.min(1000 * self._redialN, 5000));
  };
  PeerBus.prototype.start = function () {
    var self = this;
    self._stopped = false;
    wrlog('bus-start', { role: self.isHost ? 'host' : 'client', code: self.code });
    return new Promise(function (resolve, reject) {
      if (!window.Peer) { wrlog('start-fail', { reason: 'no-peerjs' }); reject(new Error('no-peerjs')); return; }
      var done = false, fail = function (e) { wrlog('start-fail', wrPeerErr(e)); if (!done) { done = true; reject(e); } };
      if (self.isHost) {
        self.peer = new window.Peer(PEER_PREFIX + self.code, peerOpts());
        self.peer.on('open', function (id) { wrlog('peer-open', { id: id }); self._recon = 0; if (!done) { done = true; resolve(); } });
        self.peer.on('connection', function (conn) {
          wrlog('host-incoming', { peer: conn.peer }); wrAttachIce(conn, 'host');
          conn.on('open', function () { wrlog('host-conn-open', { peer: conn.peer }); self._addConn(conn); });
          conn.on('error', function (e) { wrlog('host-conn-error', wrPeerErr(e)); });
        });
        self.peer.on('disconnected', function () { wrlog('peer-disconnected', {}); self._reconnect(); });
        // a 'network'/socket error after we're open is a transient broker drop — keep the lobby alive
        self.peer.on('error', function (e) { wrlog('peer-error', wrPeerErr(e)); if (!done) fail(e); });
      } else {
        self.peer = new window.Peer(undefined, peerOpts());
        self.peer.on('open', function (id) {
          wrlog('peer-open', { id: id }); self._recon = 0;
          if (!self._opened) { self._opened = true; self._dialHost({ ok: function () { if (!done) { done = true; resolve(); } }, fail: function (e) { fail(e); } }); }
          else if (!self.conns.length) self._dialHost(null);   // broker came back mid-session: re-grab the host
        });
        self.peer.on('disconnected', function () { wrlog('peer-disconnected', {}); self._reconnect(); });
        self.peer.on('error', function (e) { wrlog('peer-error', wrPeerErr(e)); if (!done) fail(e); });
      }
    });
  };
  PeerBus.prototype.stop = function () {
    wrlog('bus-stop', {}); this._stopped = true;
    this.conns.forEach(function (c) { try { c.close(); } catch (e) {} }); this.conns = [];
    if (this.peer) { try { this.peer.destroy(); } catch (e) {} } this.peer = null;
  };
  // open the multiplayer (WebRTC) lobby modal
  function openNetModal(presetManual) {
    if (typeof presetManual === 'boolean') netManual = presetManual;   // mode comes from the start-screen play button
    $('netTitle').innerHTML = '<i class="ic-net" aria-hidden="true"></i><span>Игра по мрежа</span>';
    $('netMeName').textContent = localMeta().name;
    netShow('choose');
    $('netPickRole').classList.remove('hidden');                       // back to the role picker
    // webrtc mode is preset on the start screen
    $('netModeSwitch').classList.add('hidden');
    renderNetPickInfo();
    $('netJoinCode').classList.add('hidden'); $('netCodeInput').value = '';
    $('netHostCode').classList.add('hidden'); $('netHostCode').innerHTML = '';
    $('netToPrep').classList.add('hidden'); $('netStart').classList.add('hidden'); netSay(''); netChooseMsg('');
    $('netOptical').classList.add('hidden'); stopScan();
    $('netJoin').textContent = 'ПРИСЪЕДИНИ СЕ';
    $('netHost').textContent = 'ПОКАНИ';
    wrCapReset('', '');   // start a fresh capture session (records the environment)
    syncNetMode();
    $('netModal').classList.remove('hidden');
    syncWrCapVis();
  }
  // regular (dice) vs manual (ОТЧЕТ) network game
  function syncNetMode() {
    $('netModeSwitch').querySelectorAll('.nms-opt').forEach(function (b) { b.classList.toggle('on', (b.getAttribute('data-manual') === '1') === netManual); });
  }
  $('netModeSwitch').querySelectorAll('.nms-opt').forEach(function (b) {
    b.onclick = function () { netManual = (b.getAttribute('data-manual') === '1'); syncNetMode(); renderNetPickInfo(); };
  });
  // human-readable labels for the chosen ruleset / game type (reused in the mismatch warning)
  function rsLabel(rs) { return rs === 'experimental' ? 'с минуси' : 'без минуси'; }
  function modeLabel(manual) { return manual ? 'на отчет (ръчно)' : 'със зарове'; }
  // joined a game that differs from what I picked → tell me (but never block); I play by the host's rules
  function netJoinMismatch(selManual, selE, hostManual, hostE) {
    if (selManual === hostManual && selE === hostE) return;
    var diffs = [];
    if (selE !== hostE) diffs.push('правила <b>' + rsLabel(hostE ? 'experimental' : 'standard') + '</b> (ти избра „' + rsLabel(selE ? 'experimental' : 'standard') + '“)');
    if (selManual !== hostManual) diffs.push('игра <b>' + modeLabel(hostManual) + '</b> (ти избра „' + modeLabel(selManual) + '“)');
    netSay('⚠ Тази игра е ' + diffs.join(' и ') + '. Влизаш по правилата на старшината — ако не искаш, върни се назад.');
  }
  // role-pick info chips: what you're about to host or join (webrtc only — mode/ruleset are preset)
  function renderNetPickInfo() {
    var el = $('netPickInfo'); if (!el) return;
    el.innerHTML = '<span class="npi-chip">' + rsLabel(settings.ruleset) + '</span><span class="npi-chip">' + modeLabel(netManual) + '</span>';
  }
  // a status line that is visible during the CHOOSE phase (netStatus lives inside the hidden lobby)
  function netChooseMsg(s) { var el = $('netChooseMsg'); if (el) el.innerHTML = s; }
  $('netHost').onclick = function () {
    webrtcHost();
  };
  $('netJoin').onclick = function () {
    // switch to the join sub-view; deliberately DON'T focus the field (no keyboard until tapped).
    // the mode selector is the host's choice — joiners adopt it, so hide it here.
    $('netPickRole').classList.add('hidden'); $('netModeSwitch').classList.add('hidden');
    $('netJoinCode').classList.remove('hidden'); netChooseMsg('');
  };
  // guest: scan the host's QR to fill the code field (no typing). reuses the optical scan view.
  var codeScanActive = false;
  // how the join code reached the field — reported once when the guest taps „Влез с кода"
  var lastCodeSource = 'manual';
  if ($('netCodeInput')) $('netCodeInput').addEventListener('input', function () { lastCodeSource = 'manual'; });
  function codeScanShow() {
    codeScanActive = true;
    optShow(false, true); optStatus('Насочи камерата към QR кода на старшината…'); optNextBtn(null);
    startScan(function (data, err) {
      if (!data) { optStatus('⚠ Камерата отказа (' + (err || '') + '). Дай ѝ достъп и опитай пак.'); optNextBtn('📷 Опитай пак', codeScanShow); return; }
      var code = extractGameCode(data);
      if (!code) { optStatus('⚠ Това не е код за игра. Опитай пак.'); optNextBtn('📷 Опитай пак', codeScanShow); return; }
      codeScanActive = false; stopScan(); optHideView();
      netShow('choose'); $('netPickRole').classList.add('hidden'); $('netJoinCode').classList.remove('hidden');
      $('netCodeInput').value = code; lastCodeSource = 'qr'; netChooseMsg(''); flashCodeGreen();   // scan feedback = code box only
    });
  }
  // pull a 4–6 char game code out of whatever the QR carried (plain code, or with stray chars)
  function extractGameCode(data) {
    if (!data) return null;
    var s = String(data);
    var m = s.match(/[?&#]join=([A-Za-z0-9]{4,8})/i);   // a deep-link invite URL
    if (m) return m[1].toUpperCase().slice(0, 6);
    s = s.toUpperCase().replace(/[^A-Z0-9]/g, '');
    return (s.length >= 4) ? s.slice(0, 6) : null;
  }
  // brief green flash on the code box (paste/scan feedback); optionally flash a button too
  function flashCodeGreen(btn) {
    var el = $('netCodeInput'); if (el) { el.classList.add('flash-green'); clearTimeout(el._fg); el._fg = setTimeout(function () { el.classList.remove('flash-green'); }, 1600); }
    if (btn) { btn.classList.add('copied'); clearTimeout(btn._t); btn._t = setTimeout(function () { btn.classList.remove('copied'); }, 1600); }
  }
  $('netCodeScan').onclick = function () {
    netChooseMsg('Зареждам QR библиотеки…');
    loadOpticalLibs(function (ok) {
      if (!ok) { netChooseMsg('⚠ Неуспешно зареждане на QR библиотеките (нужен е интернет първия път).'); return; }
      netChooseMsg(''); codeScanShow();
    });
  };
  // paste: pull the code straight from the clipboard into the field (paste button + code box flash green)
  $('netCodePaste').onclick = function () {
    if (!(navigator.clipboard && navigator.clipboard.readText)) { netChooseMsg('⚠ Браузърът не дава достъп до клипборда — постави ръчно.'); return; }
    navigator.clipboard.readText().then(function (t) {
      // accept a bare 6-char code or the exact host share message; anything else is rejected
      var code = parsePastedCode(t);
      if (code) { $('netCodeInput').value = code; lastCodeSource = 'paste'; netChooseMsg(''); flashCodeGreen($('netCodePaste')); }
      else netChooseMsg('⚠ Копираният код не е правилен — трябва да е 6 букви и цифри.');
    }).catch(function () { netChooseMsg('⚠ Нямам достъп до клипборда — постави ръчно.'); });
  };
  // leave the join sub-view, back to the host/join picker
  $('netJoinCancel').onclick = function () {
    $('netJoinCode').classList.add('hidden'); $('netPickRole').classList.remove('hidden');
    // over the net the mode comes from the start screen
    $('netModeSwitch').classList.add('hidden');
    $('netCodeInput').value = ''; netChooseMsg('');
    if (netBus) { netBus.stop(); netBus = null; }
    if (net) { net.dispose(); net = null; }
  };
  // keep the code input upper-cased and limited to our alphabet
  $('netCodeInput').oninput = function () {
    this.value = this.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  };
  $('netCodeInput').onkeydown = function (e) { if (e.key === 'Enter') $('netCodeJoin').onclick(); };
  // ---- WebRTC host: mint a code, open the PeerJS link, then run the normal lobby ----
  // host code display: the code is NOT selectable; a copy button next to it flips to a „copied" state.
  // shared markup + wiring for a game code with a CSS copy icon
  // the code text + copy button; tapping either the text or the button copies the code.
  function codeCopyLine(code) {
    // share button (native share sheet) shown only where the Web Share API exists, next to copy
    var canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
    var share = canShare ? '<button type="button" class="codecopy netcode-share" title="Сподели кода" aria-label="Сподели кода"><i class="share-ic"></i></button>' : '';
    return '<div class="netcode-line"><b class="netcode-show">' + code + '</b>'
      + '<button type="button" class="codecopy" title="Копирай кода" aria-label="Копирай кода"><i class="copy-ic"></i></button>'
      + share + '</div>';
  }
  function wireCodeCopy(container, code) {
    var btn = container.querySelector('.codecopy:not(.netcode-share)');
    if (btn) btn.onclick = function () { copyGameCode(code, btn); };
    var share = container.querySelector('.netcode-share');
    if (share) share.onclick = function () { shareGameCode(code); };
    // tapping the code text copies too — use click (a trusted gesture iOS allows clipboard in),
    // not pointerdown (which iOS Safari does NOT treat as activating for the clipboard)
    var hold = container.querySelector('.netcode-show');
    if (hold) hold.onclick = function () { copyGameCode(code, btn); };
  }
  // the exact message the host shares (kept in one place so paste-parsing can match it)
  function shareCodeText(code) { return 'Влез в играта ми на ГЕНЕРАЛ с код: ' + code; }
  // a deep-link invite: scanning this QR with the phone camera (outside the app) opens the page
  // straight into the join flow for that code (handled by maybeJoinFromURL on load)
  function joinURL(code) { return pageShareURL() + '?join=' + code; }
  // accept only the two formats we hand out: a bare 6-char code, or the host share message
  function parsePastedCode(raw) {
    var s = String(raw == null ? '' : raw).trim();
    if (/^[A-Za-z0-9]{6}$/.test(s)) return s.toUpperCase();
    var pre = shareCodeText('');   // the share text minus the code
    if (s.slice(0, pre.length) === pre) {
      var tail = s.slice(pre.length).trim();
      if (/^[A-Za-z0-9]{6}$/.test(tail)) return tail.toUpperCase();
    }
    return null;
  }
  // native share sheet (iOS/Android/…) with the game code; ignores the user cancelling
  function shareGameCode(code) {
    if (!navigator.share) { copyGameCode(code); return; }
    try { navigator.share({ title: 'ГЕНЕРАЛ', text: shareCodeText(code) }).catch(function () {}); } catch (e) {}
  }
  // render a scannable QR of the code into qbox; qrcode-generator is lazy-loaded the first
  // time (needs internet once, then it's cached), with a graceful offline fallback.
  function renderCodeQRInto(qbox, code) {
    if (!qbox) return;
    if (window.qrcode) { renderCodeQR(qbox, code); return; }
    qbox.classList.add('loading');   // spinner sits on the view bg, not a white tile
    qbox.innerHTML = '<span class="qr-load"><span class="qr-spin"></span>Зареждам QR…</span>';
    loadOpticalLibs(function (ok) {
      if (ok && window.qrcode) renderCodeQR(qbox, code);
      else qbox.innerHTML = '<span class="qr-load">⚠ Няма QR (нужен е интернет първия път).</span>';   // stays .loading
    });
  }
  function renderCodeQR(qbox, code) {
    try {
      var qr = window.qrcode(0, 'M'); qr.addData(String(code)); qr.make();
      qbox.classList.remove('loading');   // a real QR needs the white tile to scan
      qbox.innerHTML = qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
      var svg = qbox.querySelector('svg'); if (svg) { svg.removeAttribute('width'); svg.removeAttribute('height'); svg.style.width = '100%'; svg.style.height = 'auto'; }
    } catch (e) { qbox.classList.add('loading'); qbox.innerHTML = '<span class="qr-load">⚠ Грешка при QR.</span>'; }
  }
  // host lobby: show the QR up top so a guest can scan it, with the code + copy button beneath.
  function renderHostCode(code) {
    var box = $('netHostCode');
    box.innerHTML = '<div class="netcode-lbl">Код за играта</div><div class="netcodeqr"></div>' + codeCopyLine(code);
    box.classList.remove('hidden');
    wireCodeCopy(box, code);
    renderCodeQRInto(box.querySelector('.netcodeqr'), joinURL(code));   // deep-link so an external camera can join
  }
  // robust clipboard copy: a synchronous execCommand path (works inside the tap gesture on iOS
  // Safari, where navigator.clipboard often rejects), with the async Clipboard API as a backup.
  function copyToClipboard(text) {
    var ok = false;
    try {
      var ta = document.createElement('textarea');
      ta.value = text; ta.readOnly = true; ta.contentEditable = 'true';
      ta.style.position = 'fixed'; ta.style.left = '0'; ta.style.top = '0';
      ta.style.width = '1px'; ta.style.height = '1px'; ta.style.opacity = '0'; ta.style.fontSize = '16px';
      document.body.appendChild(ta);
      var range = document.createRange(); range.selectNodeContents(ta);
      var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
      ta.setSelectionRange(0, text.length);
      ok = document.execCommand('copy');
      document.body.removeChild(ta);
    } catch (e) {}
    if (navigator.clipboard && navigator.clipboard.writeText) { try { navigator.clipboard.writeText(text); ok = true; } catch (e) {} }
    return ok;
  }
  function copyGameCode(code, btn) {
    copyToClipboard(code);   // best-effort; the green tint confirms the action either way
    if (btn) { btn.classList.add('copied'); clearTimeout(btn._t); btn._t = setTimeout(function () { btn.classList.remove('copied'); }, 1600); }
    // also flash the code text itself green (same colour + duration as the copy button)
    var line = btn && btn.closest ? btn.closest('.netcode-line') : null;
    var show = line ? line.querySelector('.netcode-show') : null;
    if (show) { show.classList.add('copied'); clearTimeout(show._t); show._t = setTimeout(function () { show.classList.remove('copied'); }, 1600); }
  }
  // a bundle/diff copy button: push to clipboard on tap, flash „копирано", never show a textbox
  function flashCopied(btn, original) {
    if (!btn) return;
    btn.textContent = '✓ копирано'; clearTimeout(btn._t);
    btn._t = setTimeout(function () { btn.textContent = original; }, 1500);
  }
  // crash recovery: re-host the SAME code and rebuild the unfinished game from the saved snapshot.
  // Clients reconnect by code (their saved eph re-seats them) and the host catches them up via STATE.
  function webrtcHostRestore(code, snap) {
    wrCapReset('host', ''); syncWrCapVis();
    netChooseMsg('Възстановявам играта…');
    loadPeerJS(function (ok) {
      if (!ok) { netChooseMsg('⚠ Няма връзка с интернет сървъра (PeerJS). Провери мрежата и опитай пак.'); return; }
      wrCode = code;
      netBus = new PeerBus({ isHost: true, code: code, onPeers: function () {}, onLost: function (conn) { netHostLost(conn); } });
      netBus.start().then(function () {
        net = newSessionWith(netBus, true); localPid = MP.HOST_ID;
        netManual = !!snap.manual;
        if (!net.restore(snap)) { netChooseMsg('⚠ Записът на играта е повреден.'); netBus = null; return; }
        net.resumeHost();   // → onStart (rebuild game + show the board) + onResync (restore boards) + onTurn/onWait
        track('host-success');
      }).catch(function (e) { track('host-error'); netChooseMsg('⚠ Неуспешно свързване със сървъра: ' + ((e && (e.type || e.message)) || 'грешка') + '. Опитай пак.'); netBus = null; });
    });
  }
  function webrtcHost(presetCode) {
    wrCapReset('host', ''); wrlog('action', { tap: 'host' }); syncWrCapVis();
    netChooseMsg('Свързвам се със сървъра…');
    loadPeerJS(function (ok) {
      if (!ok) { netChooseMsg('⚠ Няма връзка с интернет сървъра (PeerJS). Провери мрежата и опитай пак.'); return; }
      var code = presetCode || genGameCode(); wrCode = code;   // presetCode: re-hosting the same game on rejoin
      netBus = new PeerBus({ isHost: true, code: code,
        onPeers: function () {}, onLost: function (conn) { netHostLost(conn); } });
      netBus.start().then(function () {
        net = newSessionWith(netBus, true); localPid = MP.HOST_ID;
        netShow('scan'); $('netToPrep').classList.add('hidden'); netChooseMsg('');
        renderHostCode(code);
        net.openLobby(); renderNetRoster(); setFlavour($('netStatus'), 'hostSearch'); track('host-success');
      }).catch(function (e) { track('host-error'); netChooseMsg('⚠ Неуспешно свързване със сървъра: ' + ((e && (e.type || e.message)) || 'грешка') + '. Опитай пак.'); netBus = null; });
    });
  }
  // ---- WebRTC client: dial the host's code, then ask to join the lobby ----
  $('netCodeJoin').onclick = function () {
    var code = ($('netCodeInput').value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length < 4) { netChooseMsg('⚠ Въведи валиден код (поне 4 знака).'); return; }
    track('code-' + lastCodeSource);   // how this code was entered: qr / paste / manual
    wrCapReset('client', code); wrlog('action', { tap: 'joinCode', code: code }); syncWrCapVis();
    $('netCodeJoin').disabled = true; netChooseMsg('Свързвам се с код ' + code + '…');
    loadPeerJS(function (ok) {
      if (!ok) { $('netCodeJoin').disabled = false; netChooseMsg('⚠ Няма връзка с интернет сървъра (PeerJS). Провери мрежата и опитай пак.'); return; }
      netBus = new PeerBus({ isHost: false, code: code,
        onLost: function () { netClientLost(); },
        onReup: function () { wrlog('reup', {}); netReconnecting = false; syncNetLink(); if (net) net.rejoin(); track('net-reconnect'); netSay('Връзката се възстанови — наваксвам…'); } });
      netBus.start().then(function () {
        var savedEph = wrLoadEph(code);                 // reuse our identity if we've played this game before
        net = newSessionWith(netBus, false, savedEph || undefined);
        wrSaveEph(code, net.eph);
        $('netJoinCode').classList.add('hidden'); $('netCodeJoin').disabled = false; netChooseMsg('');
        netShow('scan'); $('netToPrep').classList.add('hidden');
        net.requestJoin(); setFlavour($('netStatus'), 'clientSearch');
      }).catch(function (e) {
        $('netCodeJoin').disabled = false; track('join-error');
        var et = e && (e.type || e.message);
        // a timeout/negotiation failure = signalling worked but the P2P link couldn't form (NAT/TURN);
        // 'peer-unavailable' = the code/host wasn't found at all
        if (et === 'timeout' || et === 'negotiation-failed') netChooseMsg('⚠ Намерих играта, но не успях да изградя връзка с хоста. При различни мрежи трябва TURN сървър — пробвайте на една и съща Wi-Fi мрежа, или задайте TURN в дебъг панела.');
        else if (et === 'peer-unavailable') netChooseMsg('⚠ Няма игра с този код. Провери кода и опитай пак.');
        else netChooseMsg('⚠ Връзката се провали: ' + (et || 'грешка') + '. Опитай пак.');
        netBus = null;
      });
    });
  };
  // ---- connection-loss handling ----
  // host: a closed data channel maps (via the tagged connection) to a player seat → mark it dropped
  function netHostLost(conn) {
    if (!net || !net.isHost) return;
    var pid = conn && conn._pid; if (pid == null) return;
    // ignore if another live connection already carries this player (an overlapping reconnect)
    if (netBus && netBus.conns.some(function (c) { return c !== conn && c.open && c._pid === pid; })) return;
    net.markDropped(pid, true);
  }
  function netClientLost() {
    if (netMode) { track('net-disconnect'); netReconnecting = true; syncNetLink(); netSay('Връзката с хоста прекъсна — опитвам да се върна…'); }
    else netChooseMsg('⚠ Връзката прекъсна. Опитай пак.');
  }
  // ===================================================== QR scan / display helpers (shared: WebRTC join-by-scan + invite QR)
  function loadScriptOnce(test, src, cb) { if (test()) { cb(true); return; } var s = document.createElement('script'); s.src = src; s.onload = function () { cb(test()); }; s.onerror = function () { cb(false); }; document.head.appendChild(s); }
  function loadOpticalLibs(cb) {
    loadScriptOnce(function () { return !!window.LZString; }, 'https://unpkg.com/lz-string@1.5.0/libs/lz-string.min.js', function (a) {
      if (!a) { cb(false); return; }
      loadScriptOnce(function () { return !!window.qrcode; }, 'https://unpkg.com/qrcode-generator@1.4.4/qrcode.js', function (b) {
        if (!b) { cb(false); return; }
        loadScriptOnce(function () { return !!window.jsQR; }, 'https://unpkg.com/jsqr@1.4.0/dist/jsQR.js', function (c) { cb(c); });
      });
    });
  }
  // ---- QR scan / display UI helpers ----
  function optStatus(s) { var el = $('optStatus'); if (el) el.innerHTML = s; }
  function optShow(showQR, showScan) {
    $('netChoose').classList.add('hidden'); $('netLobby').classList.add('hidden'); $('netOptical').classList.remove('hidden');
    $('optQRwrap').classList.toggle('hidden', !showQR); $('optScanWrap').classList.toggle('hidden', !showScan);
  }
  function optHideView() { $('netOptical').classList.add('hidden'); }
  function optNextBtn(label, fn) { var b = $('optNext'); if (!label) { b.classList.add('hidden'); b.onclick = null; return; } b.textContent = label; b.classList.remove('hidden'); b.onclick = fn; }
  var optStream = null, optScanning = false;
  function startScan(onResult) {
    stopScan();
    if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) { onResult(null, 'no-camera'); return; }
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }).then(function (stream) {
      optStream = stream; optScanning = true;
      var video = $('optVideo'); video.srcObject = stream; video.setAttribute('playsinline', ''); video.muted = true;
      var pr = video.play(); if (pr && pr.catch) pr.catch(function () {});
      var canvas = document.createElement('canvas'), ctx = canvas.getContext('2d');
      (function tick() {
        if (!optScanning) return;
        if (video.readyState >= 2 && video.videoWidth) {
          canvas.width = video.videoWidth; canvas.height = video.videoHeight;
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          var img = null; try { img = ctx.getImageData(0, 0, canvas.width, canvas.height); } catch (e) {}
          if (img && window.jsQR) { var code = window.jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' }); if (code && code.data) { stopScan(); onResult(code.data); return; } }
        }
        (window.requestAnimationFrame || window.setTimeout)(tick, 60);
      })();
    }).catch(function (e) { onResult(null, (e && e.name) || 'camera-denied'); });
  }
  function stopScan() { optScanning = false; if (optStream) { optStream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} }); optStream = null; } var v = $('optVideo'); if (v) v.srcObject = null; }
  // ✕ on the QR scan view (used by WebRTC join-by-scan): close the camera and return to the picker
  $('optCancel').onclick = function () {
    stopScan(); optHideView();
    if (codeScanActive) { codeScanActive = false; netShow('choose'); $('netPickRole').classList.add('hidden'); $('netJoinCode').classList.remove('hidden'); netChooseMsg(''); return; }
    leaveNet();
  };
  // host closes the scan and moves everyone into preparation
  $('netToPrep').onclick = function () { if (net && net.isHost) net.startPrep(settingsBits()); };
  // host adds an AI seat (generated boец); clients can't
  $('netAddAI').onclick = function () {
    if (!net || !net.isHost) return;
    var g = ['m', 'n', 'f'][Math.floor(Math.random() * 3)], r = G.randomNameRarity('ai', g);
    net.addAI({ name: r.name, color: PRESET_COLORS[Math.floor(Math.random() * PRESET_COLORS.length)], gender: g });
  };
  // host edits pre-game settings in the lobby (broadcast as a summary)
  $('netPrepSettings').onclick = function () { if (net && net.isHost) { netSettCtx = true; openSettings(); } };
  var netSettCtx = false;
  // client: first tap readies up; once ready the button becomes the spammable „ДАЙ ЗОР"
  $('netReady').onclick = function () {
    if (!net || net.isHost) return;
    if (!netMyReady) { setMyReady(true); renderNetPrep(); }   // ready → button becomes the spammable ДАЙ ЗОР
    else { spurMe(); }
  };
  $('netStart').onclick = function () {
    if (!net || !net.isHost) return;
    if (netEditing) { netEditing = false; renderNetPrep(); return; }   // confirm my customisation → back to ДАЙ ЗОР/старт
    // until everyone's ready this button is „ДАЙ ЗОР"; it only starts the game once all are ready
    if (!net.allReady()) {
      if (net.roster.length < net.minPlayers) { netSay('⚠ Трябват поне ' + net.minPlayers + ' бойци.'); }
      else { var notReady = net.roster.filter(function (m) { return m.id !== MP.HOST_ID && !m.isAI && !m.ready && !m.dropped; }); if (notReady.length) netSay('⏳ Чакам: ' + notReady.map(function (m) { return esc(m.name); }).join(', ')); }
      spurMe();
      return;
    }
    $('netStart').disabled = true; setFlavour($('netStatus'), 'lobbyWait');
    net.startGame();   // data channels need no link calibration
  };
  // tear the live session/transport down without touching the modal's visibility
  function netDisposeSession() {
    stopFlavour(); resetSpur(); clearTimeout(netMetaTimer);
    stopScan();
    var disbanding = net && net.isHost;
    if (disbanding) { try { net.disband(); } catch (e) {} }   // tell clients the lobby is cancelled
    if (net) net.dispose();
    // stop the transport — deferred briefly when disbanding so the BYE flushes to the clients first
    var bus = netBus;
    if (bus) { if (disbanding) setTimeout(function () { try { bus.stop(); } catch (e) {} }, 250); else bus.stop(); }
    net = null; netBus = null; netMode = false; localPid = null;
    netPhase = 'choose'; netMe = null; netMyReady = false; netAiActiveId = null; netSettCtx = false;
    $('netBars').innerHTML = ''; $('netLink').classList.add('hidden');
    if ($('netCodeJoin')) $('netCodeJoin').disabled = false;
    if ($('netOptical')) $('netOptical').classList.add('hidden');
  }
  // a client whose host disbanded the lobby: drop the session and return to the host/join picker
  function netHostGone() {
    if (!netMode && !net) return;
    netDisposeSession();
    openNetModal(netManual);
    netChooseMsg('⚠ Старшината отказа играта. Можеш да създадеш своя или да влезеш в друга.');
  }
  function leaveNet() { netDisposeSession(); $('netModal').classList.add('hidden'); }   // ✕ — back to the start screen
  // „Откажи" from the host invite / lobby returns to the host/join role picker (modal stays open)
  function netBackToChoose() { netDisposeSession(); openNetModal(netManual); }
  $('netLeave').onclick = netBackToChoose;
  // true only at the idle host/join picker — nothing started yet (no session, no transport, no code view)
  function netAtPicker() {
    return netPhase === 'choose' && !net && !netBus
      && $('netPickRole') && !$('netPickRole').classList.contains('hidden')
      && $('netJoinCode').classList.contains('hidden')
      && $('netOptical').classList.contains('hidden');
  }
  // tapping the backdrop dismisses the modal ONLY at the picker; once hosting/joining it's locked
  // so a stray tap can't cancel the connection
  $('netModal').addEventListener('click', function (e) {
    if (e.target === $('netModal') && netAtPicker()) leaveNet();
  });
  $('netClose').onclick = leaveNet;
  if ($('netChooseBack')) $('netChooseBack').onclick = leaveNet;   // back from the host/join picker → start screen
  // ---- WebRTC capture export (base64 JSON of every logged event) ----
  $('wrCapCopy').onclick = function () {
    var payload = { v: 1, app: APP_VERSION, role: wrRole, code: wrCode, ts: Date.now(), log: wrLog };
    var b64; try { b64 = 'GENWRCAP1:' + btoa(unescape(encodeURIComponent(JSON.stringify(payload)))); } catch (e) { b64 = 'грешка: ' + e.message; }
    var ok = copyToClipboard(b64);
    flashCopied($('wrCapCopy'), '📋 Копирай WebRTC лог');
    var ta = $('wrCapOut'); ta.value = b64; ta.classList.toggle('hidden', ok);   // only reveal as a fallback if the copy failed
    $('wrCapStatus').textContent = wrLog.length + ' събития · ' + b64.length + ' знака' + (ok ? '' : ' — копирай ръчно ⬇');
  };
  $('wrCapClear').onclick = function () { wrCapReset(wrRole, wrCode); $('wrCapOut').classList.add('hidden'); $('wrCapOut').value = ''; syncWrCapStatus(); };
  $('wrIceSave').onclick = function () {
    var raw = ($('wrIce').value || '').trim();
    if (raw) { try { var a = JSON.parse(raw); if (!Array.isArray(a)) throw 0; } catch (e) { $('wrIceStatus').textContent = '⚠ Невалиден JSON масив.'; return; } }
    settings.iceServers = raw; saveSettings(); iceStatus();
    $('wrIceStatus').textContent = (customIce() ? '✓ Запазено — важи при следващо свързване.' : 'по подразбиране (STUN + безплатен TURN)');
  };
  $('wrIceClear').onclick = function () { settings.iceServers = ''; saveSettings(); $('wrIce').value = ''; iceStatus(); };

  function startNetGame(roster, order) {
    clearAllPenalties();
    netOrder = order.slice();
    var players = roster.map(function (m) {
      var pl = G.createPlayer(m.name, m.color, !!m.isAI);       // humans play on their own device; AI seats are host-driven
      pl.gender = m.gender; pl.bet = ''; pl.bonus = 0; pl.netId = m.id; pl.dropped = !!m.dropped;
      if (!m.isAI) { pl.selectKeep = !!settings.selectKeep; pl.diceBatch = !!settings.newDiceBatch; }       // each device's human plays in its own flavour
      pl.ribbons = RIBBON_COLORS.slice().sort(function () { return Math.random() - 0.5; }).slice(0, 6);
      pl.owner = (m.id === localPid);                           // ★ each device owns ITS OWN player (history attribution)
      return pl;
    });
    var exp = netRuleset() === 'experimental';
    game = (exp ? X.createGame(players) : G.createGame(players)); game.ownerSkipped = false;
    game.ruleset = exp ? 'experimental' : 'standard';          // drives sumExp() → exp board/scoring over the net
    game.manual = !!(net && net.manual); game.turn = freshTurn(); netMode = true; undoStack = []; viewingHistory = false;
    trackGame('start');
    // lobby size by HUMAN players (AI seats excluded), bucketed 1–5
    var humans = roster.filter(function (m) { return !m.isAI; }).length;
    track('net-start-' + Math.max(1, Math.min(5, humans)) + 'p');
    moveLog = players.map(function () { return []; });
    $('netModal').classList.add('hidden'); $('setup').classList.add('hidden');
    $('game').classList.remove('hidden'); $('overModal').classList.add('hidden');
    paintCamo($('game'));
    syncHintBtn();
    setDockUI(gManual());
    netReconnecting = false; syncNetLink();   // show the connection indicator by the turn marker
    if (gManual()) {
      // FREE-FOR-ALL: I always fill MY OWN sheet at my own pace; others' boards update for peeking
      var mySeat = netOrder.indexOf(localPid); game.current = mySeat >= 0 ? mySeat : 0;
      netMyTurn = true; $('undoBottom').classList.add('hidden');   // no ОПА: entries are broadcast immediately
      beginManualEntry();
    }
    netActiveSave();   // remember this game so a reload within 15 min can offer to rejoin
    // (regular) the first GRANT (onTurn) drives beginTurn
  }
  // manual net: reset the dock for my next category entry (stay on my own sheet)
  function beginManualEntry() {
    var p = game.players[game.current], cats = sumCats();   // ruleset-aware (minus has 15 rows incl. два чифта)
    var filled = cats.filter(function (c) { return G.isCategoryFilled(p, c.key); }).length;
    game.round = Math.min(cats.length, filled + 1);
    if (myManualDone()) { game.turn.locked = true; game.turn.manualCounts = [0, 0, 0, 0, 0, 0, 0]; game.turn.dice = []; renderAll(); netSay('✔ Готов! Чакам останалите да попълнят…'); return; }
    game.turn.locked = false; game.turn.manualCounts = [0, 0, 0, 0, 0, 0, 0]; game.turn.dice = []; game.turn.throwsLeft = 0; game.turn.curLog = null;
    renderAll();
  }
  function myManualDone() { var p = game && game.players[game.current]; return p && sumCats().every(function (c) { return G.isCategoryFilled(p, c.key); }); }
  function netSetTurn(activeId) {
    if (!netMode || !game) return;
    netActiveTouch();   // keep the rejoin window fresh while the game is live
    var seat = netOrder.indexOf(activeId); if (seat < 0) return;
    netActiveId = activeId; specSelf = false; specAct = null; resetSpecPlay(); syncSpecReturn();   // new turn → fresh spectating
    game.current = seat; netMyTurn = (activeId === localPid);
    // the host plays any seat it controls (lobby AI or a live takeover) locally
    if (net.isHost && net.isAIControlled(activeId)) { runNetAiTurn(seat, activeId); return; }
    beginTurn();
  }
  // ---------- live spectating: broadcast my actions; watch the active player's actions ----------
  // the active player broadcasts each completed action so everyone else can watch.
  // Works for my own turn AND a host-driven AI seat.
  function netSendAct(extra) {
    if (!(netMode && net)) return;
    var pid = (netAiActiveId != null && net.isHost) ? netAiActiveId : (netMyTurn ? localPid : null);
    if (pid == null) return;
    var mask = 0;
    for (var i = 0; i < 5; i++) if (game.turn.diceNew[i]) mask |= (1 << i);   // which dice are freshly thrown (drives the watcher's reroll view)
    var a = { playerId: pid, throwsLeft: game.turn.throwsLeft, dice: game.turn.dice.slice(), mask: mask };
    if (extra) for (var k in extra) a[k] = extra[k];
    try { net.sendAction(a); } catch (e) {}
  }
  // ---- spectating: a calm, QUEUED replay of the watched player's actions (~2s apart) so a fast
  // player doesn't blur past watchers. New dice are grouped/accented by THE WATCHER's own settings;
  // a reroll first highlights the dice being thrown (distinct accent) for a beat, then reveals them.
  var SPEC_GAP = 2500, SPEC_HILITE = 500;
  var specQueue = [], specBusy = false, specTimer = null, specEpoch = 0;
  var specPid = null, specRollNo = 0, specPairs = [], specThrow = null, specPulseOn = false;
  function resetSpecPlay() { specEpoch++; specQueue = []; specBusy = false; clearTimeout(specTimer); specTimer = null; specPid = null; specRollNo = 0; specPairs = []; specThrow = null; specSaved = null; }
  function netSpectate(a) {
    if (!netMode || !game) return;
    if (a.playerId === localPid) return;                 // my own action — already on my board
    if (netOrder.indexOf(a.playerId) < 0) return;
    netActiveId = a.playerId; specAct = a;               // remember so RETURN can jump back here
    if (a.playerId !== specPid) { specQueue = []; specPid = a.playerId; specRollNo = 0; specPairs = []; }   // new player → fresh
    specQueue.push(a);
    if (specQueue.length > 6) specQueue.splice(0, specQueue.length - 6);   // never lag more than a few actions behind
    specPump();
  }
  function specPump() {
    if (specBusy || specSelf || !specQueue.length) return;   // specSelf: watcher is on their own board → hold the queue
    specBusy = true;
    var ep = specEpoch, a = specQueue.shift();
    playSpecAction(a, function () { if (ep !== specEpoch) return; specTimer = setTimeout(function () { if (ep !== specEpoch) return; specBusy = false; specPump(); }, SPEC_GAP); });
  }
  function playSpecAction(a, done) {
    var seat = netOrder.indexOf(a.playerId); if (seat < 0) { done(); return; }
    var ep = specEpoch;
    game.current = seat; netMyTurn = false; game.turn.aiBusy = false; game.turn.awaitingRoll = false; game.turn.locked = true;
    if (a.commit) {
      specSetDice(a); specThrow = null;
      var ck = a.category != null ? catKeyAt(a.category) : null;
      // mark the category as submitted right away (the authoritative STATE confirms the same value)
      if (ck && game.players[seat] && !G.isCategoryFilled(game.players[seat], ck))
        game.players = GReduce.reduce(game, { type: 'APPLY_SCORE', seat: seat, key: ck, score: a.value }).players;
      renderAll(); if (ck) flashTile(ck); done(); return;
    }
    if (!specPairs.length || a.mask === 0) { specThrow = null; specSetDice(a); specPulseOn = true; renderAll(); specPulseOn = false; shakeDice(); done(); return; }   // turn's first roll
    // a reroll: HIGHLIGHT the dice being thrown on the current frame, then reveal the new batch (pulsing)
    specThrow = specThrownPositions(a); renderAll();
    setTimeout(function () { if (ep !== specEpoch) return; specThrow = null; specSetDice(a); specPulseOn = true; renderAll(); specPulseOn = false; shakeDice(); done(); }, SPEC_HILITE);
  }
  // which CURRENTLY-shown dice are being re-thrown — derived from the values that survive the reroll
  function specThrownPositions(a) {
    var nd = a.dice || [], kept = [];
    nd.forEach(function (v, i) { if (!(a.mask & (1 << i))) kept.push(v); });
    return specPairs.map(function (p) { var k = kept.indexOf(p.v); if (k >= 0) { kept.splice(k, 1); return false; } return true; });
  }
  // set the watched dice + reconstruct their generations, then ORDER them by the watcher's own setting
  function specSetDice(a) {
    var bd = (a.dice || []).slice(), bm = [0, 1, 2, 3, 4].map(function (i) { return !!(a.mask & (1 << i)); }), pairs;
    if (specPairs.length && bm.some(Boolean)) {
      specRollNo++;
      var pool = specPairs.map(function (p) { return { v: p.v, g: p.g, used: false }; });
      pairs = bd.map(function (v, i) {
        if (bm[i]) return { v: v, g: specRollNo };
        for (var k = 0; k < pool.length; k++) if (!pool[k].used && pool[k].v === v) { pool[k].used = true; return { v: v, g: pool[k].g }; }
        return { v: v, g: specRollNo };
      });
    } else { specRollNo = 1; pairs = bd.map(function (v) { return { v: v, g: 1 }; }); }
    if (settings.newDiceBatch) pairs.sort(function (x, y) { return (x.g - y.g) || (x.v - y.v); });
    else pairs.sort(function (x, y) { return x.v - y.v; });
    specPairs = pairs;
    game.turn.dice = pairs.map(function (p) { return p.v; });
    game.turn.diceGen = pairs.map(function (p) { return p.g; });
    game.turn.diceNew = pairs.map(function (p) { return specRollNo > 1 && p.g === specRollNo; });   // accent the freshest batch (not the opening roll)
    game.turn.throwsLeft = a.throwsLeft || 0; game.turn.selected = [false, false, false, false, false];
  }
  // tap your own board while spectating → see your usual during-turn screen (read-only preview).
  // the spectator queue is HELD while you're here, then resumes on RETURN.
  function previewSelf() {
    if (!netMode || localPid == null) return;
    var seat = netOrder.indexOf(localPid); if (seat < 0) return;
    // snapshot the watched view so RETURN restores it exactly (even if the active player hasn't rolled yet)
    if (!specSelf) specSaved = { dice: game.turn.dice.slice(), diceGen: game.turn.diceGen.slice(), diceNew: game.turn.diceNew.slice(), throwsLeft: game.turn.throwsLeft,
      selected: game.turn.selected.slice(), specPairs: specPairs.slice(), specRollNo: specRollNo, specThrow: specThrow };
    specSelf = true; specThrow = null;
    game.current = seat; netMyTurn = false; game.turn.aiBusy = false; game.turn.awaitingRoll = false; game.turn.locked = true;
    game.turn.dice = []; game.turn.throwsLeft = 0; game.turn.selected = [false, false, false, false, false]; game.turn.diceNew = [false, false, false, false, false]; game.turn.diceGen = [];
    renderAll(); syncSpecReturn();
  }
  function returnToCurrent() {
    specSelf = false;
    // always jump the board back to the current active player (don't require spectated dice to exist)
    var seat = netActiveId != null ? netOrder.indexOf(netActiveId) : -1;
    if (seat >= 0) {
      game.current = seat; netMyTurn = (netActiveId === localPid); game.turn.locked = !netMyTurn; game.turn.awaitingRoll = false;
      if (specSaved) {   // restore the exact watch-view we left
        game.turn.dice = specSaved.dice; game.turn.diceGen = specSaved.diceGen; game.turn.diceNew = specSaved.diceNew; game.turn.throwsLeft = specSaved.throwsLeft;
        game.turn.selected = specSaved.selected; specPairs = specSaved.specPairs; specRollNo = specSaved.specRollNo; specThrow = specSaved.specThrow;
      }
      renderAll();
    }
    specSaved = null;
    syncSpecReturn();
    specPump();   // resume the paced replay
  }
  function syncSpecReturn() { var b = $('specReturn'); if (b) b.classList.toggle('hidden', !(netMode && specSelf)); }
  // dev-only: open the lobby PREP screen with a mock roster, to preview that flow without a 2nd device
  function devMockLobby() {
    try { leaveNet(); } catch (e) {}
    var nullTp = { maxPayload: 60000, onReceive: function () {}, send: function () { return Promise.resolve(); } };
    wrCode = 'MOCK01';
    openNetModal();
    net = newSessionWith(nullTp, true); localPid = MP.HOST_ID;
    net.openLobby();
    net.roster.push({ id: net._nextId(), eph: 9001, name: 'Редник Тъпан', color: '#2e9e5b', gender: 'm', ready: true });
    net.roster.push({ id: net._nextId(), eph: 9002, name: 'Ефрейтор Мечка', color: '#6a52c0', gender: 'f', ready: true });
    if (!net.exp) net.addAI({ name: 'Сержант Болт', color: '#e07a2e', gender: 'n' });   // exp AI scoring isn't wired

    netShow('scan'); renderNetRoster();
    net.startPrep(settingsBits());   // → onPrep → enterNetPrep (the preparation screen)
  }
  // dev-only: preview the CLIENT's preparation screen (ready button, no host tools, settings summary)
  function devMockLobbyClient() {
    try { leaveNet(); } catch (e) {}
    var nullTp = { maxPayload: 60000, onReceive: function () {}, send: function () { return Promise.resolve(); } };
    openNetModal();
    net = newSessionWith(nullTp, false); localPid = 3; net.myId = 3; net._acked = true; net.state = 'PREP';
    net.settingsBits = settingsBits() || 0b011;   // pretend a couple of gameplay settings are on
    net.roster = [
      { id: 0, name: 'Старшина Желязков', color: '#d4a02e', gender: 'm', ready: true },
      { id: 1, name: 'Редник Тъпан', color: '#2e9e5b', gender: 'm', ready: true },
      { id: 3, name: localMeta().name, color: '#6a52c0', gender: 'f', ready: false },
      { id: 4, name: 'Сержант Болт', color: '#e07a2e', gender: 'n', isAI: true },
    ];
    enterNetPrep();
  }
  // pick a bot strength matching the (dropped) player's optimal-decision rate so far
  function netAiPolicy(seat) {
    var acc = null;
    if (evReady && moveLog[seat] && moveLog[seat].length) { try { var a = EV.analyzeGame(moveLog[seat]); acc = a && a.accuracy; } catch (e) {} }
    return EV.botPolicyForAccuracy(acc);
  }
  // host drives a controlled seat: roll locally, let the matched bot play, inject the move
  function runNetAiTurn(seat, activeId) {
    var p = game.players[seat];
    p.persona = { name: 'AI', policy: netAiPolicy(seat) };     // synthetic persona feeding aiKeepMask/aiCategory
    netAiActiveId = activeId;
    netMyTurn = false; game.turn.awaitingRoll = false; game.turn.locked = false;
    game.turn.throwsLeft = ROLLS - 1; game.turn.selected = [false, false, false, false, false]; game.turn.diceNew = [false, false, false, false, false];
    game.turn.dice = G.rollAll(); sortDice();
    game.turn.rollNo = 1; game.turn.diceGen = game.turn.dice.map(function () { return 1; });
    game.turn.curLog = startTurnLog(p);
    renderAll(); shakeDice(); showOrder(p);
    netSendAct();   // clients watch the host-driven AI seat roll
    runAiTurn();
  }
  function netApplyRemote(mv) {
    if (!netMode || !game) return;
    netActiveTouch();
    if (mv.playerId === localPid) return;                        // my own move is already on my board
    var seat = netOrder.indexOf(mv.playerId); if (seat < 0) return;
    var pl = game.players[seat], key = catKeyAt(mv.category);
    if (key && !G.isCategoryFilled(pl, key)) {
      game.players = GReduce.reduce(game, { type: 'APPLY_SCORE', seat: seat, key: key, score: mv.score }).players;   // mirror the remote score
      // store this player's FULL turn log (relayed as JSON) so history is complete on every device.
      // If no log came through (older peer), fall back to a fill-order-only marker.
      if (moveLog[seat]) {
        var entry = null;
        if (mv.log) { try { entry = JSON.parse(mv.log); } catch (e) {} }
        moveLog[seat].push(entry || { category: key, remote: true });
      }
    }
    renderAll();
  }
  // host-only in-game control: flip a (dropped) player to AI play, or hand it back
  function renderAiTakeover() {
    var box = $('menuAiTk');
    if (!netMode || !net || !net.isHost) { box.classList.add('hidden'); box.innerHTML = ''; return; }
    var others = net.roster.filter(function (m) { return m.id !== localPid; });
    if (!others.length) { box.classList.add('hidden'); box.innerHTML = ''; return; }
    box.classList.remove('hidden');
    box.innerHTML = '<div class="aitk-hd">Отпаднал боец: AI или пауза</div>' + others.map(function (m) {
      var ctl = m.isAI
        ? '<span class="pp-tag">🤖 винаги AI</span>'
        : '<button class="toggle aitk-tg' + ((net.takeover || {})[m.id] ? ' on' : '') + '" data-tk="' + m.id + '"><span class="switch"></span><span>AI</span></button>'
        + '<button class="toggle aitk-tg' + ((net.paused || {})[m.id] ? ' on' : '') + '" data-ps="' + m.id + '"><span class="switch"></span><span>Пауза</span></button>';
      return '<div class="aitk-row"><span class="netdot" style="background:' + m.color + '"></span><span class="ai-nm">' + esc(m.name) + '</span>' + ctl + '</div>';
    }).join('');
    // AI and pause are mutually exclusive: turning one on clears the other
    box.querySelectorAll('.toggle[data-tk]').forEach(function (t) {
      t.onclick = function () { var id = +t.getAttribute('data-tk'), on = !(net.takeover || {})[id]; if (on) net.setPaused(id, false); net.setTakeover(id, on); netActiveSave(); renderAiTakeover(); };
    });
    box.querySelectorAll('.toggle[data-ps]').forEach(function (t) {
      t.onclick = function () { var id = +t.getAttribute('data-ps'), on = !(net.paused || {})[id]; if (on) net.setTakeover(id, false); net.setPaused(id, on); netActiveSave(); renderAiTakeover(); };
    });
  }
  // host (WebRTC): show the game code in-game so a dropped player can read it and rejoin
  function renderMenuNetCode() {
    var box = $('menuNetCode'); if (!box) return;
    if (!netMode || !net || !net.isHost || !wrCode) { box.classList.add('hidden'); box.innerHTML = ''; return; }
    box.classList.remove('hidden');
    box.innerHTML = '<div class="netcode-lbl">Код за връщане в играта</div><div class="netcodeqr"></div>' + codeCopyLine(wrCode) + '<div class="mnc-hint">Разпаднал се боец може да влезе пак с този код — или да сканира QR-а.</div>';
    wireCodeCopy(box, wrCode);
    renderCodeQRInto(box.querySelector('.netcodeqr'), joinURL(wrCode));
  }
  // in-game WebRTC log export: same payload as wrCapCopy, but reachable mid-game from the Щаб menu
  // (shown only with the debug toggle on) so a connection hiccup can be captured the moment it happens.
  function renderMenuWrLog() {
    var btn = $('menuWrLog'); if (!btn) return;
    var show = netMode && net && settings.webrtcDebug;
    btn.classList.toggle('hidden', !show);
    if (!show) return;
    btn.onclick = function () {
      var payload = { v: 1, app: APP_VERSION, role: wrRole, code: wrCode, ts: Date.now(), log: wrLog };
      var b64; try { b64 = 'GENWRCAP1:' + btoa(unescape(encodeURIComponent(JSON.stringify(payload)))); } catch (e) { b64 = 'грешка: ' + e.message; }
      copyToClipboard(b64); flashCopied(btn, '📋 Копирай WebRTC лог');
    };
  }

