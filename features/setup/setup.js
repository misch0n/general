'use strict';
// Setup / muster screen: player roster, start-screen ruleset & local/network selectors, play button.
  // ===================================================== SETUP
  var humanNames = G.nameGenerator('human');
  var aiNames = G.nameGenerator('ai');
  var setupPlayers = [];

  // (re)generate a name for a setup player and capture its rarity + bonus + the
  // chosen parts (so a later gender switch can re-cohere without re-rolling)
  function regenName(p) {
    var r = G.randomNameRarity(p.isAI ? 'ai' : 'human', p.gender);
    p.name = r.name; p.pct = r.pct; p.tier = r.tier; p.bonus = r.bonus; p.parts = r.parts; p.bubbleDismissed = false; p.typed = false;
    // a freshly rolled name resets the per-censor cache; record which censor state it belongs to
    p._nameCache = {}; p._nameState = settings.glupost ? 'nsfw' : 'sfw';
  }
  // flipping Глупости swaps between a cached SFW and NSFW name (deterministic — flipping
  // back returns the original) instead of rerolling a brand-new name each time
  function swapCensorName(p) {
    if (p.typed) return;                                  // typed/owner names aren't touched
    var newKey = settings.glupost ? 'nsfw' : 'sfw', oldKey = p._nameState || (newKey === 'nsfw' ? 'sfw' : 'nsfw');
    if (!p._nameCache) p._nameCache = {};
    if (oldKey !== newKey) p._nameCache[oldKey] = { name: p.name, pct: p.pct, tier: p.tier, bonus: p.bonus, parts: p.parts };
    var c = p._nameCache[newKey];
    if (c) { p.name = c.name; p.pct = c.pct; p.tier = c.tier; p.bonus = c.bonus; p.parts = c.parts; p.bubbleDismissed = true; p._nameState = newKey; }
    else { var keep = p._nameCache; regenName(p); p._nameCache = keep; p._nameCache[newKey] = { name: p.name, pct: p.pct, tier: p.tier, bonus: p.bonus, parts: p.parts }; }
  }
  // §1 switching gender keeps the SAME name/rarity, only re-cohering grammatically
  // (the noun morphs in place when it can, else swaps for a same-rarity sibling).
  function setGender(p, g) {
    p.gender = g;
    // morph the SAME name in place only when the noun has a form for the new
    // gender (rarity unchanged); otherwise roll a fresh name + refreshed rarity.
    if (p.parts && G.nounRenders(p.parts, g)) {
      var r = G.recohereName(p.isAI ? 'ai' : 'human', p.parts, g);
      p.name = r.name; p.parts = r.parts; // p.pct / p.tier / p.bonus untouched
    } else {
      regenName(p);
    }
  }
  // build the rare-name brag bubble for a player (or null)
  function rarityBubbleEl(p) {
    if (!p.tier || p.bubbleDismissed || !settings.titles) return null; // rarity notifications gated by Титли
    var eff = namePointsOn() ? p.bonus : 0;                            // award line only when points are on
    var bub = document.createElement('div');
    bub.className = 'rarebubble rt' + p.tier;                // colour = frequency tier
    var intro = p.typed ? '🎯 Позна! ' : '🏅 ';
    // two lines: «exclamation, 1 на X — топ Y%» then the award on its own line
    var award = G.rarityAward(eff);
    bub.innerHTML = '<span>' + intro + esc(G.rarityLine(p.pct, p.tier))
      + (award ? '<br>' + esc(award) : '') + '</span><button class="rbx" title="Скрий">✕</button>';
    bub.querySelector('.rbx').onclick = function () { p.bubbleDismissed = true; bub.remove(); };
    return bub;
  }
  // refresh just the bubble in a card (used by the debounced custom-name check)
  function updateCardBubble(card, p) {
    var old = card.querySelector('.rarebubble'); if (old) old.remove();
    var bub = rarityBubbleEl(p); if (bub) card.appendChild(bub);
  }
  function addSetupPlayer(isAI) {
    var n = setupPlayers.length;
    // the owner seat (#1, human) starts at the старшина's default gender + colour
    var isOwnerSeat = n === 0 && !isAI;
    var g = isOwnerSeat ? (settings.ownerGender || 'm') : G.randomGender();
    var col = isOwnerSeat ? (settings.ownerColor || PRESET_COLORS[0]) : pickFreeColor(null);
    var p = { isAI: !!isAI, gender: g, color: col, bet: G.randomBet() };
    regenName(p);
    setupPlayers.push(p);
    renderSetup();
    // reveal the new card + keep the add button in view
    var sc = document.querySelector('.setup-scroll');
    if (sc) requestAnimationFrame(function () { sc.scrollTop = sc.scrollHeight; });
  }
  // removing a card. The owner can be removed ONLY while skipped; doing so DETACHES the owner —
  // seat #1 then shows a muted token but keeps its own identity until the token is re-activated.
  function removeSetupPlayer(p) {
    var ix = setupPlayers.indexOf(p); if (ix < 0) return;
    if (isOwnerP(p)) ownerDetached = true;
    setupPlayers.splice(ix, 1);
    renderSetup();
  }
  // re-activate the muted token on seat #1: bring the owner (and its defaults) back
  function reclaimOwner() {
    if (!setupPlayers.length) return;
    ownerDetached = false; skipOwnerNext = false;
    var p = setupPlayers[0]; p.owner = true;
    p.gender = settings.ownerGender || p.gender;
    p.color = settings.ownerColor || p.color;
    regenName(p);                 // a fresh owner-style name (applyOwnerName overrides if the toggle is on)
    renderSetup();
  }
  // gender selector swipe: a horizontal drag shifts the choice ONE step in the swipe direction
  // (left → мъжко, right → женско). X is read until the finger LIFTS; the shift fires on lift based
  // on the NET displacement, and vertical scroll is never locked.
  var suppressGenderClick = false;
  function attachGenderSwipe(gsw, p) {
    var GENS = ['m', 'n', 'f'], sx = null, sy = null, pid = null, lastX = 0, lastY = 0, capturing = false;
    gsw.style.touchAction = 'pan-y';                            // vertical scroll passes through
    gsw.addEventListener('pointerdown', function (e) { sx = e.clientX; sy = e.clientY; lastX = e.clientX; lastY = e.clientY; pid = e.pointerId; capturing = false; });
    gsw.addEventListener('pointermove', function (e) {
      if (sx == null || e.pointerId !== pid) return;
      lastX = e.clientX; lastY = e.clientY;
      if (!capturing && Math.abs(e.clientX - sx) > 8 && Math.abs(e.clientX - sx) > Math.abs(e.clientY - sy)) {
        capturing = true; try { gsw.setPointerCapture(pid); } catch (x) {}
      }
    });
    gsw.addEventListener('pointerup', function (e) {
      if (sx == null) return;
      var ex = (e.pointerId === pid && e.clientX != null) ? e.clientX : lastX, ey = (e.pointerId === pid && e.clientY != null) ? e.clientY : lastY;
      var dx = ex - sx, dy = ey - sy; sx = null;
      if (Math.abs(dx) >= 18 && Math.abs(dx) > Math.abs(dy)) {
        var idx = GENS.indexOf(p.gender), ni = dx > 0 ? Math.min(2, idx + 1) : Math.max(0, idx - 1);
        if (ni !== idx) { suppressGenderClick = true; setGender(p, GENS[ni]); renderSetup(); setTimeout(function () { suppressGenderClick = false; }, 400); }
      }
    });
    gsw.addEventListener('pointercancel', function () { sx = null; });
  }
  function renderSetup() {
    applyOwnerName(); // seat #1 carries the owner's name when the toggle is on
    dedupeColors(); dedupeNames();   // keep colours + names unique across the roster
    var list = $('playerList'); list.innerHTML = '';
    setupPlayers.forEach(function (p, i) {
      var card = document.createElement('div'); card.className = 'pcard';
      card.__player = p;
      var owner = isOwnerP(p);
      var detachedSeat = ownerDetached && i === 0;                   // muted token on the new first seat (no owner data)
      var removable = setupPlayers.length > 1 && (!owner || skipOwnerNext);   // owner removable only while skipped

      var top = document.createElement('div'); top.className = 'pcardtop';
      if (setupPlayers.length > 1) {
        var grip = document.createElement('div'); grip.className = 'grip'; grip.title = 'Влачи, за да подредиш';
        grip.innerHTML = '<span class="gripdots"><i></i><i></i><i></i><i></i><i></i><i></i></span>';
        grip.onpointerdown = function (e) { armCardDrag(card, e); };
        top.appendChild(grip);
      }
      var name = document.createElement('input');
      name.type = 'text'; name.className = 'name'; name.value = p.name; name.placeholder = 'Име на боеца';
      var nameLocked = owner && settings.useOwnerName && settings.ownerName.trim();
      if (nameLocked) { name.readOnly = true; name.title = 'Заключено от настройките (твоето име)'; }
      // a hand-typed name is checked against the seed (debounced); a matching
      // (and rare) Title+Adj+Noun still earns the bonus, otherwise it forfeits it
      name.oninput = function () {
        p.name = name.value;
        clearTimeout(p._seedTimer);
        p._seedTimer = setTimeout(function () {
          var m = G.matchSeed(p.name, p.gender);
          p.pct = m.matched ? m.pct : null;
          p.tier = m.matched ? m.tier : 0;
          p.bonus = m.matched ? m.bonus : 0;
          p.parts = m.matched ? m.parts : null; // a matched name can still re-cohere on gender switch
          p.typed = true; p.bubbleDismissed = false;
          // the name fixes its own gender — adopt it so callouts stay coherent
          if (m.matched && m.gender && m.gender !== p.gender) {
            p.gender = m.gender;
            ['m', 'n', 'f'].forEach(function (g) {
              var gb = card.querySelector('.g-' + g); if (gb) gb.classList.toggle('on', g === p.gender);
            });
          }
          updateCardBubble(card, p);
        }, 450);
      };
      top.appendChild(name);
      card.appendChild(top);

      var row = document.createElement('div'); row.className = 'prow2';
      var color = document.createElement('button'); color.type = 'button'; color.className = 'cbtn';
      color.style.background = p.color; color.title = 'Избери цвят'; color.setAttribute('aria-label', 'Избери цвят');
      color.onclick = function (e) { e.stopPropagation(); showColorPop(color, p); };   // custom swatch popover — no system dialog

      // gender switch (мъжко / то / женско) — changes the name + callouts. Locked when the owner's
      // name is fixed from settings (the gender is forced to settings too), and then visually muted.
      // the gender is locked (and muted) only when the owner's name is fixed AND the owner isn't
      // skipped — once skipped, the seat is up for grabs so the gender becomes editable again
      var genderLocked = nameLocked && !skipOwnerNext;
      var gsw = document.createElement('div'); gsw.className = 'gender' + (genderLocked ? ' locked' : '');
      [['m', 'мъжко'], ['n', 'то'], ['f', 'женско']].forEach(function (g) {
        var gb = document.createElement('button');
        gb.className = 'glabel g-' + g[0] + (p.gender === g[0] ? ' on' : '');
        gb.textContent = g[1];
        if (genderLocked) { gb.disabled = true; }
        else gb.onclick = function () {
          if (suppressGenderClick) return;             // a swipe just handled it
          if (p.gender === g[0]) return;
          setGender(p, g[0]); // re-cohere the SAME name, keep its rarity (§1)
          renderSetup();
        };
        gsw.appendChild(gb);
      });
      if (!genderLocked) attachGenderSwipe(gsw, p);   // horizontal swipe shifts the gender one step in that direction

      var toggle = document.createElement('button');
      toggle.className = 'toggle' + (p.isAI ? ' on' : '');
      toggle.innerHTML = '<span class="switch"></span><span>AI</span>';
      if (owner && !skipOwnerNext) {
        // the device owner (старшина) is always human — the AI switch is disabled on that seat,
        // UNLESS the owner is skipped for the next game (then the seat is up for grabs, incl. AI)
        toggle.disabled = true; toggle.title = 'Старшината играе сам — не може да е AI';
      } else {
        toggle.onclick = function () {
          p.isAI = !p.isAI;
          // persona is the PLAYSTYLE; the AI keeps a generated metallic/electric name
          if (p.isAI) p.personaId = p.personaId || 'lelia';
          if (p.isAI) p.personaOpen = true;
          regenName(p);
          renderSetup();
        };
      }
      row.appendChild(color); row.appendChild(gsw); row.appendChild(toggle);
      // right end of prow2: the owner token (where the delete button used to be) — tap for the
      // explainer/skip, or re-activate a detached owner; non-owner removable cards get the delete ✕
      if (owner || detachedSeat) {
        var tk = document.createElement('button'); tk.className = 'ownerstar' + ((skipOwnerNext || detachedSeat) ? ' skipped' : '');
        tk.title = detachedSeat ? 'Старшината е пропуснат — докосни, за да го върнеш' : 'Старшината — ти';
        tk.setAttribute('aria-label', 'Старшината');
        tk.onclick = detachedSeat
          ? function (e) { e.stopPropagation(); reclaimOwner(); }      // re-activate → owner defaults come back
          : function (e) { e.stopPropagation(); showOwnerInfo(tk); };
        row.appendChild(tk);
      } else if (removable) {
        var del = document.createElement('button'); del.className = 'del'; del.textContent = '✕';
        del.onclick = function () { removeSetupPlayer(p); };
        row.appendChild(del);
      }
      card.appendChild(row);

      // persona list (only for AI seats) — collapses to the chosen line
      if (p.isAI) {
        var box = document.createElement('div'); box.className = 'personas';
        var cap = document.createElement('div'); cap.className = 'pcap'; cap.textContent = 'Стил на игра';
        box.appendChild(cap);
        var shown = p.personaOpen ? G.PERSONAS : G.PERSONAS.filter(function (x) { return x.id === p.personaId; });
        shown.forEach(function (per) {
          var b = document.createElement('button');
          b.className = 'persona' + (per.id === p.personaId ? ' sel' : '');
          b.innerHTML = '<span class="pn2">' + per.name + '</span><span class="pf">' + per.flavor + '</span>'
            + '<span class="pstr">' + Math.round(per.strength * 100) + '%</span>';
          b.onclick = function () {
            // selecting a persona sets the playstyle only — the AI's name is unchanged
            if (p.personaOpen) { p.personaId = per.id; p.personaOpen = false; }
            else { p.personaOpen = true; }
            renderSetup();
          };
          box.appendChild(b);
        });
        card.appendChild(box);
      }

      if (settings.bets) { // the stupid wager — its own toggle now
        var bet = document.createElement('div'); bet.className = 'betline';
        bet.innerHTML = 'Залага <span class="betval fixed">' + esc(p.bet) + '</span>';
        card.appendChild(bet);
      }

      // rare-name brag bubble (dismissable); awards the bonus unless disabled
      var bub0 = rarityBubbleEl(p); if (bub0) card.appendChild(bub0);
      // wrap the content in a sliding foreground so the card can be swiped left to remove it
      var fg = document.createElement('div'); fg.className = 'pc-fg';
      while (card.firstChild) fg.appendChild(card.firstChild);
      if (removable) {
        var rmbg = document.createElement('div'); rmbg.className = 'pc-bg'; rmbg.innerHTML = '<span class="pcrm">МАХНИ</span>';
        card.appendChild(rmbg); card.classList.add('swipeable');
        attachSwipeRemove(card, fg, rmbg, p);
      }
      card.appendChild(fg);
      list.appendChild(card);
    });
  }
  // swipe a player card left to remove it; it completes past 50% of the width, else snaps back.
  // the red underlay is only as wide as the swipe (no bleed-through behind the transparent card).
  function attachSwipeRemove(card, fg, bg, p) {
    var sx = 0, sy = 0, w = 1, active = false, decided = false, swiping = false, pid = null;
    function settle() { setTimeout(function () { fg.classList.remove('snap'); bg.classList.remove('snap'); fg.style.transform = ''; bg.style.width = ''; }, 240); }
    card.addEventListener('pointerdown', function (e) {
      if (drag) return;                                            // a reorder drag is running
      if (e.target.closest && e.target.closest('.grip')) return;  // the grip owns reorder
      if (e.target.closest && e.target.closest('.gender')) return; // the gender selector owns its own swipe
      if (e.button != null && e.button > 0) return;
      active = true; decided = false; swiping = false; sx = e.clientX; sy = e.clientY; w = card.offsetWidth || 1; pid = e.pointerId;
      fg.classList.remove('snap'); bg.classList.remove('snap');
    });
    card.addEventListener('pointermove', function (e) {
      if (!active || e.pointerId !== pid) return;
      var dx = e.clientX - sx, dy = e.clientY - sy;
      if (!decided) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        decided = true; swiping = (Math.abs(dx) > Math.abs(dy)) && dx < 0;   // a clear horizontal-left gesture
        if (swiping) { try { card.setPointerCapture(pid); } catch (x) {} }   // own the horizontal drag (vertical scroll stays free)
        else { active = false; return; }                           // vertical → leave it for scroll
      }
      if (!swiping) return;
      e.preventDefault();
      var t = Math.min(0, dx);
      fg.style.transform = 'translateX(' + t + 'px)';   // foreground follows the finger (left only)
      bg.style.width = (-t) + 'px';                      // underlay grows to match — only what's exposed
    });
    function end(e) {
      if (!active || (e.pointerId != null && e.pointerId !== pid)) return;
      if (!swiping) { active = false; return; }
      var dx = e.clientX - sx; active = false; fg.classList.add('snap'); bg.classList.add('snap');
      if (-dx >= w * 0.5) {   // past halfway → remove
        fg.style.transform = 'translateX(-100%)'; bg.style.width = '100%';
        setTimeout(function () { removeSetupPlayer(p); }, 200);
      } else { fg.style.transform = 'translateX(0)'; bg.style.width = '0'; settle(); }   // not far enough → snap back
    }
    card.addEventListener('pointerup', end);
    card.addEventListener('pointercancel', function () { if (active && swiping) { fg.classList.add('snap'); bg.classList.add('snap'); fg.style.transform = 'translateX(0)'; bg.style.width = '0'; settle(); } active = false; });
  }
  $('addPlayer').onclick = function () { addSetupPlayer(false); };

  // drag-to-reorder player cards: press the grip and HOLD ~0.5s (selection disabled the whole time),
  // then drag up/down. Crossing a neighbour's midpoint swaps the two cards with a slide (FLIP)
  // animation. Moving before the hold elapses is treated as a scroll and cancels the arming.
  var drag = null;
  var HOLD_MS = 500, HOLD_SLOP = 8;
  function dragAfter(list, y, card) {
    var result = null, closest = -Infinity;
    [].forEach.call(list.children, function (c) {
      if (c === card) return;
      var box = c.getBoundingClientRect();
      var offset = y - box.top - box.height / 2;
      if (offset < 0 && offset > closest) { closest = offset; result = c; }
    });
    return result;
  }
  // FLIP: snapshot every card's top, reorder the DOM, then animate each from its old spot to the new one
  function flipReorder(list, card, before) {
    var kids = [].slice.call(list.children), firsts = kids.map(function (c) { return c.getBoundingClientRect().top; });
    if (before == null) list.appendChild(card); else list.insertBefore(card, before);
    kids.forEach(function (c, i) {
      var dy = firsts[i] - c.getBoundingClientRect().top;
      if (!dy) return;
      c.style.transition = 'none'; c.style.transform = 'translateY(' + dy + 'px)';
      void c.offsetHeight;                                   // force reflow so the next frame animates
      c.style.transition = 'transform .18s cubic-bezier(.3,.7,.4,1)'; c.style.transform = '';
    });
  }
  // press-and-hold on the grip to arm reorder; a move before the timer fires aborts it (scroll)
  function armCardDrag(card, e) {
    if (e.button != null && e.button > 0) return;
    var pid = e.pointerId, sx = e.clientX, sy = e.clientY, armed = false, holdTimer = null;
    document.body.style.userSelect = 'none';                 // no text selection while the grip is touched
    function cleanupPre() {
      clearTimeout(holdTimer); holdTimer = null;
      document.removeEventListener('pointermove', preMove);
      document.removeEventListener('pointerup', preEnd);
      document.removeEventListener('pointercancel', preEnd);
    }
    function preMove(ev) {
      if (ev.pointerId !== pid || armed) return;
      if (Math.abs(ev.clientX - sx) > HOLD_SLOP || Math.abs(ev.clientY - sy) > HOLD_SLOP) {
        cleanupPre(); document.body.style.userSelect = '';   // moved too soon → treat as a scroll, not a hold
      }
    }
    function preEnd(ev) { if (ev.pointerId !== pid) return; cleanupPre(); if (!armed) document.body.style.userSelect = ''; }
    document.addEventListener('pointermove', preMove, { passive: true });
    document.addEventListener('pointerup', preEnd);
    document.addEventListener('pointercancel', preEnd);
    holdTimer = setTimeout(function () { armed = true; cleanupPre(); beginCardDrag(card, pid); }, HOLD_MS);
  }
  function beginCardDrag(card, pid) {
    drag = { card: card, list: $('playerList'), pid: pid };
    card.classList.add('dragging');
    if (navigator.vibrate) { try { navigator.vibrate(12); } catch (e) {} }   // a tap cue that move is live
    document.addEventListener('pointermove', onDragMove, { passive: false });
    document.addEventListener('pointerup', endCardDrag);
    document.addEventListener('pointercancel', endCardDrag);
  }
  function onDragMove(e) {
    if (!drag || e.pointerId !== drag.pid) return;
    e.preventDefault();
    var after = dragAfter(drag.list, e.clientY, drag.card);
    if (after !== drag.card && after !== drag.card.nextSibling) flipReorder(drag.list, drag.card, after);
  }
  function endCardDrag(e) {
    if (!drag || (e && e.pointerId != null && e.pointerId !== drag.pid)) return;
    drag.card.classList.remove('dragging');
    document.body.style.userSelect = '';
    document.removeEventListener('pointermove', onDragMove);
    document.removeEventListener('pointerup', endCardDrag);
    document.removeEventListener('pointercancel', endCardDrag);
    setupPlayers = [].map.call(drag.list.children, function (c) { return c.__player; });
    drag = null;
    renderSetup();
  }
  function buildPlayers() {
    applyOwnerName(); // ensure seat #1 carries the owner's name if the toggle is on
    return setupPlayers.map(function (p) {
      var pl = G.createPlayer(p.name.trim(), p.color, p.isAI); pl.bet = p.bet; pl.gender = p.gender || 'm';
      pl.owner = skipOwnerNext ? false : !!p.owner; // owner skipped → nobody carries the flag this game
      if (!p.isAI) { pl.selectKeep = !!settings.selectKeep; pl.diceBatch = !!settings.newDiceBatch; }   // each human starts on the defaults, then keeps their own
      pl.bonus = namePointsOn() ? (p.bonus || 0) : 0; // rare-name starting bonus (Титли + точки)
      pl.ribbons = RIBBON_COLORS.slice().sort(function () { return Math.random() - 0.5; }).slice(0, 6);
      if (p.isAI) pl.persona = G.personaById(p.personaId);
      return pl;
    });
  }
  function startFromSetup(manual) {
    if (setupPlayers.some(function (p) { return !(p.name || '').trim(); })) { $('setupErr').textContent = 'Всеки боец трябва да има име.'; return; }
    $('setupErr').textContent = '';
    startGame(buildPlayers(), manual);
  }
  // ---- start-screen selectors: ruleset (без/с минуси) + where (device/network) ----
  var netPlay = false;   // false = play on this device; true = launch the network host/join workflow
  function syncStartRuleSel() { $('startRuleSel').querySelectorAll('.ssel-opt').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-rs') === (settings.ruleset || 'standard')); }); }
  function syncStartWhereSel() {
    $('startWhereSel').querySelectorAll('.ssel-opt').forEach(function (b) { b.classList.toggle('on', (b.getAttribute('data-net') === '1') === netPlay); });
    syncStartRuleSel();
  }
  // transient bottom-of-screen note explaining a ruleset / network change (auto-hides after 5s)
  var infoToastTimer = null;
  function showInfoToast(text) {
    var t = $('infoToast'), tx = $('infoToastTxt'); if (!t || !tx) return;
    tx.textContent = text; t.classList.add('show');
    clearTimeout(infoToastTimer); infoToastTimer = setTimeout(function () { t.classList.remove('show'); }, 5000);
  }
  var RULE_NOTE = { experimental: 'С минуси: числата се точкуват със знак (−50 при провал) плюс „два чифта“.',
                    standard: 'Без минуси: класическата игра — само положителни точки.' };
  var WHERE_NOTE = { net: 'По мрежа: хостът дава код, останалите се присъединяват и играят по неговите правила.',
                     local: 'На устройството: всички играят на този телефон, един след друг.' };
  var MODE_NOTE = { dice: 'Със зарове: хвърляш заровете и трупаш точки по комбинации.',
                    manual: 'Отчет: ръчно вписване на точки без зарове — за игра на маса.' };
  function setStartRuleset(rs) {
    if (settings.ruleset === rs) return;
    settings.ruleset = rs; saveSettings(); syncStartRuleSel(); syncRuleset();
    showInfoToast(RULE_NOTE[rs] || '');
  }
  function setStartWhere(net) {
    if (netPlay === net) return;
    netPlay = net; syncStartWhereSel();
    showInfoToast(net ? WHERE_NOTE.net : WHERE_NOTE.local);
  }
  // swipe across a selector: any horizontal drag toward an option picks it (left option / right
  // option by direction). A tap still picks the tapped option; the post-swipe click is suppressed.
  // a horizontal swipe picks the option in the swipe direction. The X movement is read continuously
  // until the finger LIFTS; the switch fires on lift based on the NET displacement — never mid-gesture,
  // and vertical scroll is never locked.
  function attachSelSwipe(sel, pickLeft, pickRight) {
    var sx = null, sy = null, pid = null, lastX = 0, lastY = 0, capturing = false;
    sel.style.touchAction = 'pan-y';                            // vertical scroll passes through; we own horizontal
    sel.addEventListener('pointerdown', function (e) { sx = e.clientX; sy = e.clientY; lastX = e.clientX; lastY = e.clientY; pid = e.pointerId; capturing = false; sel._swiped = false; });
    sel.addEventListener('pointermove', function (e) {
      if (sx == null || e.pointerId !== pid) return;
      lastX = e.clientX; lastY = e.clientY;
      if (!capturing && Math.abs(e.clientX - sx) > 8 && Math.abs(e.clientX - sx) > Math.abs(e.clientY - sy)) {
        capturing = true; try { sel.setPointerCapture(pid); } catch (x) {}   // a horizontal drag → keep tracking until lift
      }
    });
    sel.addEventListener('pointerup', function (e) {
      if (sx == null) return;
      var ex = (e.pointerId === pid && e.clientX != null) ? e.clientX : lastX, ey = (e.pointerId === pid && e.clientY != null) ? e.clientY : lastY;
      var dx = ex - sx, dy = ey - sy; sx = null;
      if (Math.abs(dx) >= 18 && Math.abs(dx) > Math.abs(dy)) { sel._swiped = true; (dx > 0 ? pickRight : pickLeft)(); }
    });
    sel.addEventListener('pointercancel', function () { sx = null; });
  }
  $('startRuleSel').querySelectorAll('.ssel-opt').forEach(function (b) {
    b.onclick = function () { if ($('startRuleSel')._swiped) { $('startRuleSel')._swiped = false; return; } setStartRuleset(b.getAttribute('data-rs')); };
  });
  $('startWhereSel').querySelectorAll('.ssel-opt').forEach(function (b) {
    b.onclick = function () { if ($('startWhereSel')._swiped) { $('startWhereSel')._swiped = false; return; } setStartWhere(b.getAttribute('data-net') === '1'); };
  });
  // ruleset row: [с минуси | без минуси]; where row: [на устройството | по мрежа]
  attachSelSwipe($('startRuleSel'), function () { setStartRuleset('experimental'); }, function () { setStartRuleset('standard'); });
  attachSelSwipe($('startWhereSel'), function () { setStartWhere(false); }, function () { setStartWhere(true); });
  // the coffee mug lives inside the where-selector: a tap opens the link, but a swipe across it must not
  $('coffeeBtn').addEventListener('click', function (e) { if ($('startWhereSel')._swiped) { $('startWhereSel')._swiped = false; e.preventDefault(); } });
  // network: the play button picks the MODE (regular vs manual); ruleset comes from the selector
  function startNetFlow(manual) {
    $('setupErr').textContent = '';
    netManual = manual; openNetModal('webrtc', manual);
  }
  // ---- play button: one surface. Tap the ACTIVE end or the middle = старт; tap the INACTIVE end =
  //      switch to it; swipe ←/→ picks a mode (the gradient slides/floods to the new mode) ----
  var playManual = false;   // false = игра (със зарове), true = отчет (ръчно)
  function syncPlayBtn() { $('playBtn').classList.toggle('man', playManual); }
  function setPlayMode(manual) { if (playManual !== manual) { playManual = manual; syncPlayBtn(); showInfoToast(manual ? MODE_NOTE.manual : MODE_NOTE.dice); } }
  function startPlay() { if (netPlay) startNetFlow(playManual); else startFromSetup(playManual); }
  (function () {
    var pb = $('playBtn'), gold = pb.querySelector('.pb-gold');
    var MAX_TX = 34;                                  // matches .playbtn.man .pb-gold (translateX 0 → 34%)
    var sx = null, sy = null, pid = null, decided = false, dragging = false, baseTx = 0, blobW = 1, curTx = 0;
    function lockScroll(lock) { var sc = document.querySelector('.setup-scroll'); if (sc) sc.style.overflowY = lock ? 'hidden' : ''; }
    pb.addEventListener('pointerdown', function (e) {
      sx = e.clientX; sy = e.clientY; pid = e.pointerId; decided = false; dragging = false;
      blobW = gold.offsetWidth || 1; baseTx = playManual ? MAX_TX : 0; curTx = baseTx;
    });
    pb.addEventListener('pointermove', function (e) {
      if (sx == null || e.pointerId !== pid) return;
      var dx = e.clientX - sx, dy = e.clientY - sy;
      if (!decided) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        decided = true;
        dragging = Math.abs(dx) > Math.abs(dy);       // horizontal → the gold tracks the finger
        if (dragging) { try { pb.setPointerCapture(pid); } catch (x) {} gold.style.transition = 'none'; lockScroll(true); }   // freeze vertical scroll
        else { sx = null; return; }                   // vertical → ignore (leave for scrolling)
      }
      if (!dragging) return;
      e.preventDefault();
      curTx = Math.max(0, Math.min(MAX_TX, baseTx + (dx / blobW) * 100));   // 1:1 with the swipe, clamped to the ends
      gold.style.transform = 'translateX(' + curTx + '%)';
    });
    function settleDrag() {
      // snap to the nearer end (past the midpoint commits the switch) with the normal transition
      var manual = curTx > MAX_TX / 2, changed = manual !== playManual;
      playManual = manual; pb.classList.toggle('man', playManual);
      gold.style.transition = ''; void gold.offsetWidth; gold.style.transform = '';   // animate from curTx to the end
      if (changed) showInfoToast(playManual ? MODE_NOTE.manual : MODE_NOTE.dice);
    }
    pb.addEventListener('pointerup', function (e) {
      if (sx == null) return;
      var moved = decided; sx = null;
      if (dragging) { lockScroll(false); settleDrag(); return; }
      if (moved) return;                                        // a vertical drag — no tap
      var r = pb.getBoundingClientRect();                       // a tap: resolve the zone by pointer X
      var rel = r.width ? (e.clientX - r.left) / r.width : 0.5;
      // tapping the INACTIVE end switches to that mode; the active end (or the middle) starts the game
      if (rel < 0.24 && playManual) setPlayMode(false);         // inactive left → игра
      else if (rel > 0.76 && !playManual) setPlayMode(true);    // inactive right → отчет
      else startPlay();                                         // active end or middle → start
    });
    pb.addEventListener('pointercancel', function () {
      if (dragging) { lockScroll(false); gold.style.transition = ''; gold.style.transform = ''; }   // revert to the current mode
      sx = null; decided = false; dragging = false;
    });
    pb.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowLeft') { e.preventDefault(); setPlayMode(false); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); setPlayMode(true); }
      else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); startPlay(); }
    });
    syncPlayBtn();
    // fresh-load entrance hint: sway the gold so players notice the swipe affordance (every page load)
    pb.classList.add('pb-hint');
    pb.addEventListener('animationend', function h() { pb.classList.remove('pb-hint'); pb.removeEventListener('animationend', h); });
  })();

