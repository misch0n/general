'use strict';
// Modals: how-to-play, combo reference sheet, settings panel, developer string editor.
  // ---------- how to play + in-game menu ----------
  function buildHowTo() {
    var exp = uiRuleset() === 'experimental';
    var scoring = exp
      ? '<h3 class="hth">Точкуване „с минуси“</h3>'
        + '<p class="ht">Числовата част (1-6) се точкува <b>около три</b>: три еднакви = 0, четири = +стойността, пет = +2×; <b>по-малко</b> от три вади минус. Събери шестте реда — ако сборът завърши на минус, отнемат ти <b>−50</b>. В комбинациите има и <b>2x2</b> (два различни чифта).</p>'
      : '';
    return '<h2><i class="ic-book"></i>Правила</h2>'
      + '<p class="ht">Печели бойният, който събере най-много точки — и грабва чин <b>Генерал</b>. Последният получава <b>Редник</b>.</p>'
      + '<h3 class="hth">Ходът</h3>'
      + '<p class="ht">Имаш 5 зара и до <b>3 хвърляния</b>. Натисни <b>ХВЪРЛИ!</b> за първото хвърляне. После маркирай зарове и стреляй — или спри по-рано. Кои зарове маркираш зависи от твоя избор (докосни <b>?</b> на бутона за огън): по подразбиране маркираш <b>тези за хвърляне</b> (✛) и натискаш <b>ХВЪРЛИ!</b>; в другия режим маркираш <b>тези за задържане</b> (✓) и натискаш <b>ДРЪЖ!</b>, а останалите се хвърлят. Всеки ход записваш точно <b>една</b> категория; всяка се пълни само веднъж. Ако нищо не става, отказваш се (0 точки).</p>'
      + scoring
      + '<h3 class="hth">Категориите и какво искат</h3>'
      + '<button id="howtoCombos" class="btn">📋 Виж комбинациите</button>'
      + '<h3 class="hth">Полеви отчет</h3>'
      + '<p class="ht">Режим за игра на маса с истински зарове: удряш долу <b>петте зара</b> от хвърлянето си и таблото само ти предлага всички възможни категории — избираш една, точно както в нормална игра. Така не пропускаш комбинация и щабът пак ти прави рапорт накрая. <b>ОПА!</b> връща назад действие по действие.</p>';
  }
  // the analytics-reading guide now lives behind the «?» on the end-game screen
  var combosFromHowto = false;   // came into the combo sheet via the how-to page?
  function openHowto() {
    $('howtoBody').innerHTML = buildHowTo();
    $('howtoCombos').onclick = function () { combosFromHowto = true; $('howtoModal').classList.add('hidden'); openCombos(); };
    $('howtoModal').classList.remove('hidden');
  }
  $('howtoBtn').onclick = openHowto;
  $('howtoClose').onclick = function () { $('howtoModal').classList.add('hidden'); };
  $('howtoModal').onclick = function (e) { if (e.target === $('howtoModal')) $('howtoModal').classList.add('hidden'); };

  // ---------- combo reference sheet (quick-glance scoring table) ----------
  var COMBO_SCORE = {
    ones: '1 × брой', twos: '2 × брой', threes: '3 × брой', fours: '4 × брой', fives: '5 × брой', sixes: '6 × брой',
    twoKind: 'сбор на 2-те', threeKind: 'сбор на 3-те', fourKind: 'сбор на 4-те', fullHouse: 'сбор на петте',
    smallStraight: '15 т.', largeStraight: '20 т.', general: '50 + сбора', chance: 'сбор на петте',
  };
  var COMBO_EXAMPLE = {
    ones: [1, 1, 1, 3, 5], twos: [2, 2, 4, 5, 6], threes: [3, 3, 3, 2, 6], fours: [4, 4, 1, 2, 6], fives: [5, 5, 5, 1, 3], sixes: [6, 6, 2, 3, 4],
    twoKind: [4, 4, 1, 3, 6], threeKind: [5, 5, 5, 2, 3], fourKind: [2, 2, 2, 2, 6], fullHouse: [3, 3, 3, 6, 6],
    smallStraight: [1, 2, 3, 4, 5], largeStraight: [2, 3, 4, 5, 6], general: [4, 4, 4, 4, 4], chance: [1, 3, 4, 5, 6],
  };
  function miniDie(v) { return '<span class="csdie">' + pipFace(v) + '</span>'; }
  // which ruleset the help screens describe: the live game's, else the picked setting
  function uiRuleset() {
    var inGame = !$('game').classList.contains('hidden');
    if (inGame) return (game && game.ruleset === 'experimental') ? 'experimental' : 'standard';
    return settings.ruleset === 'experimental' ? 'experimental' : 'standard';
  }
  var COMBO_SCORE_EXP = {
    ones: '(брой−3)×1', twos: '(брой−3)×2', threes: '(брой−3)×3', fours: '(брой−3)×4', fives: '(брой−3)×5', sixes: '(брой−3)×6',
    twoKind: 'сбор на 2-те', twoPair: 'сбор на 2+2', threeKind: 'сбор на 3-те', fourKind: 'сбор на 4-те', fullHouse: 'сбор на петте',
    smallStraight: '15 т.', largeStraight: '20 т.', general: '50 + сбора', chance: 'сбор на петте',
  };
  var COMBO_EXAMPLE_EXP = {
    ones: [1, 1, 1, 3, 5], twos: [2, 2, 4, 5, 6], threes: [3, 3, 3, 2, 6], fours: [4, 4, 1, 2, 6], fives: [5, 5, 5, 1, 3], sixes: [6, 6, 2, 3, 4],
    twoKind: [4, 4, 1, 3, 6], twoPair: [6, 6, 3, 3, 1], threeKind: [5, 5, 5, 2, 3], fourKind: [2, 2, 2, 2, 6], fullHouse: [3, 3, 3, 6, 6],
    smallStraight: [1, 2, 3, 4, 5], largeStraight: [2, 3, 4, 5, 6], general: [4, 4, 4, 4, 4], chance: [1, 3, 4, 5, 6],
  };
  var COMBO_DESC_EXP = {
    ones: 'около 3: повече +, по-малко −', twos: 'около 3: повече +, по-малко −', threes: 'около 3: повече +, по-малко −',
    fours: 'около 3: повече +, по-малко −', fives: 'около 3: повече +, по-малко −', sixes: 'около 3: повече +, по-малко −',
    twoKind: 'два еднакви зара', twoPair: 'два различни чифта', threeKind: 'три еднакви', fourKind: 'четири еднакви',
    fullHouse: '3 + 2 еднакви', smallStraight: '1-2-3-4-5', largeStraight: '2-3-4-5-6', general: 'пет еднакви', chance: 'кои да е пет',
  };
  function buildComboSheet() {
    var exp = uiRuleset() === 'experimental';
    var CATS = exp ? G.CATEGORIES_EXP : G.CATEGORIES, SCORE = exp ? COMBO_SCORE_EXP : COMBO_SCORE;
    var EX = exp ? COMBO_EXAMPLE_EXP : COMBO_EXAMPLE, DESC = exp ? COMBO_DESC_EXP : G.COMBO_DESC;
    function rows(group) {
      return CATS.filter(function (c) { return c.group === group; }).map(function (c) {
        return '<div class="csitem">'
          + '<div class="csrow"><span class="cslab">' + esc(c.label) + '</span>'
          + '<span class="csdesc">' + esc(DESC[c.key] || '') + '</span>'
          + '<span class="csval">' + esc(SCORE[c.key] || '') + '</span></div>'
          + '<div class="csex">' + (EX[c.key] || []).map(miniDie).join('') + '</div>'
          + '</div>';
      }).join('');
    }
    var note = exp ? '<p class="ht" style="margin:2px 16px 6px">3 еднакви = 0, всеки над/под три мести точките с ±стойността; ако сборът на числовата част е минус → <b>−50</b>.</p>' : '';
    return '<div class="cssec">' + (exp ? 'Числова част' : 'Горна секция') + '</div>' + note + rows('upper')
      + '<div class="cssec">' + (exp ? 'Комбинации' : 'Долна секция') + '</div>' + rows('lower');
  }
  function openCombos() { $('combosBody').innerHTML = buildComboSheet(); $('combosModal').classList.remove('hidden'); }
  // closing the combo sheet returns to the how-to page when we arrived from there
  function closeCombos() {
    $('combosModal').classList.add('hidden');
    if (combosFromHowto) { combosFromHowto = false; openHowto(); }
  }
  $('combosClose').onclick = closeCombos;
  $('combosModal').onclick = function (e) { if (e.target === $('combosModal')) closeCombos(); };
  $('menuCombos').onclick = function () { combosFromHowto = false; $('menuModal').classList.add('hidden'); openCombos(); };

  $('menuBtn').onclick = function () {
    // bring the menu above any floating bubbles (tooltips/penalties/roasts)
    ['comboTip', 'fxBubble', 'guideTip'].forEach(function (id) { $(id).classList.add('hidden'); });
    clearRoast();
    renderAiTakeover();   // host: per-player AI-takeover controls (network game only)
    renderMenuNetCode();  // host: the game code so a dropped boец can rejoin
    renderMenuWrLog();    // debug: in-game WebRTC log capture (only with the toggle on)
    $('menuModal').classList.remove('hidden');
  };
  $('menuClose').onclick = function () { $('menuModal').classList.add('hidden'); };
  $('menuModal').onclick = function (e) { if (e.target === $('menuModal')) $('menuModal').classList.add('hidden'); };
  $('menuHowto').onclick = function () { $('menuModal').classList.add('hidden'); openHowto(); };
  // aborting a live battle to the muster screen — keeps the SAME roster so the lineup can be tweaked
  function abortToStart() {
    if (game) trackGame('abort');   // before resetNet() clears netMode (manual rode on game.manual)
    $('menuModal').classList.add('hidden'); $('abortModal').classList.add('hidden');
    $('overModal').classList.add('hidden');
    resetNet();
    clearAllPenalties();
    $('game').classList.add('hidden'); $('setup').classList.remove('hidden');
    renderSetup();
  }
  // начало mid-game asks for confirmation first (it ends the current battle)
  $('menuRestart').onclick = function () { $('menuModal').classList.add('hidden'); $('abortModal').classList.remove('hidden'); };
  $('abortYes').onclick = abortToStart;
  $('abortNo').onclick = function () { $('abortModal').classList.add('hidden'); $('menuModal').classList.remove('hidden'); };
  $('abortModal').onclick = function (e) { if (e.target === $('abortModal')) { $('abortModal').classList.add('hidden'); $('menuModal').classList.remove('hidden'); } };

  // ---------- settings (with a secret developer mode) ----------
  function syncHintBtn() { $('hintBtn').classList.toggle('hidden', !evReady || gManual() || !settings.advice); }
  var SETTINGS_ROWS = [
    // master switch for the goofy layer (off = core only; on enables
    // callouts, penalties, combo tooltips and bets). Rare-name titles are separate.
    { key: 'barracks', label: 'Сол и хранилки', onChange: function () {
        if (game) (gExp() ? expRenderAll : renderAll)();
        if (!$('setup').classList.contains('hidden')) renderSetup();
      } },
    // Облози — the wager flavour; its own switch now (used to ride on КАЗАРМА). Pre-game only:
    // assigned at game start, so it's hidden in-game (for every mode/ruleset).
    // gameShared: broadcast to all devices in a net game → shown in the lobby's game-settings view
    { key: 'bets', label: 'Облози', preGameOnly: true, gameShared: true, onChange: function () {
        if (!$('setup').classList.contains('hidden')) renderSetup();
      } },
    // Титли — rare-name notifications (own switch, independent of КАЗАРМА); its hidden
    // sub-toggle „Бонус точки“ turns the rare-name extra points on
    { key: 'titles', label: 'Титли', preGameOnly: true, gameShared: true,
      sub: { key: 'titlePoints', label: 'Бонус точки', onChange: function () { if (!$('setup').classList.contains('hidden')) renderSetup(); } },
      onChange: function () { if (!$('setup').classList.contains('hidden')) renderSetup(); } },
    { key: 'advice', label: 'Съвети', preGameOnly: true, onChange: function () { if (game) { syncHintBtn(); (gExp() ? expRenderAll : renderAll)(); } } },
    // (the tap-to-throw / tap-to-keep flavour moved to the ? on the in-game fire button)
    // Глупости — ON = profanity (NSFW words allowed); OFF = censored to the SFW set
    { key: 'glupost', label: 'Глупости', onChange: function () {
        G.setCensor(!settings.glupost);
        // swap to the cached name for the new state (don't reroll — flipping back reverts)
        setupPlayers.forEach(swapCensorName);
        if (!$('setup').classList.contains('hidden')) renderSetup();
      } },
    // (Нови зарове — tray display — moved out of the general settings; it now lives on the owner
    //  token/owner defaults and the in-game „?“ keep/throw bubble, so it's not duplicated here.)
    // (Акустична мрежа + Дебъг режим moved to the developer menu — Debug / Experimental)
  ];
  function buildSettingsRows(inGame, lobbyOnly) {
    var host = $('settingsRows'); host.innerHTML = '';
    SETTINGS_ROWS.forEach(function (row, idx) {
      // lobby (net prep): show only the shared game settings, not the per-device/general ones
      if (lobbyOnly && !row.gameShared) return;
      // pre-game-only rows (Титли, Съвети) are hidden once a battle is on
      var div = document.createElement('div'); div.className = 'setrow' + (inGame && row.preGameOnly ? ' hidden' : '');
      var span = document.createElement('span'); span.textContent = row.labelFn ? row.labelFn(settings[row.key]) : row.label;
      var tog = document.createElement('button'); tog.className = 'toggle' + (settings[row.key] ? ' on' : ''); tog.innerHTML = '<span class="switch"></span>';
      tog.onclick = function () {
        settings[row.key] = !settings[row.key]; tog.classList.toggle('on', settings[row.key]);
        if (row.labelFn) span.textContent = row.labelFn(settings[row.key]);
        if (row.onChange) row.onChange(); saveSettings();
        if (row.sub) buildSettingsRows(inGame); // reveal/hide the sub-toggle as the parent flips
      };
      div.appendChild(span); div.appendChild(tog);
      host.appendChild(div);
      // hidden mini-toggle (e.g. „Бонус точки“ under Титли) — shown only when the parent is on
      if (row.sub && settings[row.key]) {
        var sub = document.createElement('div'); sub.className = 'setrow setrow-sub' + (inGame && row.preGameOnly ? ' hidden' : '');
        var sspan = document.createElement('span'); sspan.textContent = row.sub.label;
        var stog = document.createElement('button'); stog.className = 'toggle' + (settings[row.sub.key] ? ' on' : ''); stog.innerHTML = '<span class="switch"></span>';
        stog.onclick = function () { settings[row.sub.key] = !settings[row.sub.key]; stog.classList.toggle('on', settings[row.sub.key]); if (row.sub.onChange) row.sub.onChange(); saveSettings(); };
        sub.appendChild(sspan); sub.appendChild(stog);
        host.appendChild(sub);
      }
    });
  }
  function clearSelection() { try { var s = window.getSelection && window.getSelection(); if (s && s.removeAllRanges) s.removeAllRanges(); } catch (e) {} }
  // secret developer mode: press-and-hold the ГЕНЕРАЛ title for 3s to UNLOCK; once unlocked the
  // title itself becomes tappable and a quick tap opens the dev panel (no extra icon is added).
  (function () {
    var t = $('setupTitle'); if (!t) return;
    var timer = null, sx = 0, sy = 0, moved = false, downAt = 0;
    function start(e) {
      sx = e.clientX; sy = e.clientY; moved = false; downAt = Date.now(); clearSelection();
      if (!settings.dev) { clearTimeout(timer); timer = setTimeout(activateDev, 3000); }   // 3s STATIC hold to unlock
    }
    function cancel() { clearTimeout(timer); timer = null; }
    function move(e) { if (Math.abs(e.clientX - sx) > 10 || Math.abs(e.clientY - sy) > 10) { moved = true; cancel(); } }   // moving cancels the hold
    function up() {
      cancel();
      // once unlocked, a quick still tap (not the long unlock-hold) opens the dev panel
      if (settings.dev && !moved && Date.now() - downAt < 600) openDevModal();
    }
    // the long-press would otherwise start an (invisible, user-select:none) text selection — suppress it
    t.addEventListener('selectstart', function (e) { e.preventDefault(); });
    t.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    t.addEventListener('pointerdown', start);
    t.addEventListener('pointermove', move);
    t.addEventListener('pointerup', up);
    ['pointerleave', 'pointercancel'].forEach(function (ev) { t.addEventListener(ev, cancel); });
  })();
  // unlock: build the editor data up front and mark the title as tappable (its tap opens the panel)
  function activateDev() { clearSelection(); settings.dev = true; buildDevCats(); $('setupTitle').classList.add('dev-on'); }

  // the title's „Е" glyph: tap to pop a QR of THIS page (a friend scans it to open the game).
  // its own pointer handlers swallow the event so the surrounding title's press-hold / dev-tap never fires.
  function pageShareURL() { return location.origin + location.pathname; }
  function openQrShare() {
    var url = pageShareURL();
    $('qrShareUrl').textContent = url; $('qrShareUrl').dataset.url = url;
    $('qrShareModal').classList.remove('hidden');
    renderCodeQRInto($('qrShareBox'), url);
  }
  (function () {
    var lit = $('qrLetter'); if (!lit) return;
    lit.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    lit.addEventListener('click', function (e) { e.stopPropagation(); openQrShare(); });
    lit.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openQrShare(); } });
  })();
  $('qrShareClose').onclick = function () { $('qrShareModal').classList.add('hidden'); };
  $('qrShareModal').onclick = function (e) { if (e.target === $('qrShareModal')) $('qrShareModal').classList.add('hidden'); };
  // tap the url line to copy it (no text selection) — flash green and show „копирано!" like the host code
  $('qrShareUrl').onclick = function () {
    var el = this, url = el.dataset.url || el.textContent;
    copyToClipboard(url);
    el.textContent = 'копирано!'; el.classList.add('copied'); clearTimeout(el._t);
    el._t = setTimeout(function () { el.classList.remove('copied'); el.textContent = url; }, 1600);
  };
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  // dev modal controls
  $('devClose').onclick = function () { closeDevModal(); };
  $('devModal').onclick = function (e) { if (e.target === $('devModal')) closeDevModal(); };
  $('devApplyAll').onclick = function () { devApplyAllBtn(); var b = $('devApplyAll'); b.textContent = '↻ Приложено!'; setTimeout(function () { b.textContent = '↻ Приложи всичко'; }, 1300); };
  $('devCopy').onclick = function () {
    var txt = serializeDevDiff();
    var ok = copyToClipboard(txt);
    flashCopied($('devCopy'), '📋 Копирай diff');
    var out = $('devOut'); out.value = txt; out.classList.toggle('hidden', ok);   // reveal only if copy failed
  };

  // ---- dev-mode editor: ALL game strings, edit-on-touch, diff-only copy ----
  // Every item tracks its original, so „Копирай“ emits only the CHANGES (modified
  // / added / removed) with an executable identifier. Touching an item opens an
  // edit panel with Приложи / Отказ / Възстанови.
  var devCats = null;
  function bracketRank(b) { var i = G.BRACKETS.indexOf(b || '10+'); return i < 0 ? G.BRACKETS.length : i; }
  function cloneVal(v) { return v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v; }
  // a text box that grows to show ALL of its content (no sideways scroll)
  function devArea(val, ph, on) {
    var t = document.createElement('textarea'); t.className = 'devta'; t.rows = 1;
    t.value = val || ''; t.placeholder = ph;
    function grow() { t.style.height = 'auto'; t.style.height = Math.max(t.scrollHeight, 26) + 'px'; }
    t.oninput = function () { on(t.value.trim()); grow(); };
    setTimeout(grow, 0);
    return t;
  }
  // ===================== placeholder template editor (chips + variable picker) =====================
  // In-game strings carry placeholder tokens (e.g. %combo%, %val%). In the editor they render as
  // tappable LABELS — a chip per token — while the stored/exported string keeps the real token.
  // Available variables come from the live game metadata; tapping a chip switches its variable.
  var DEV_VARS = [
    { token: '%name%', label: 'име', desc: 'името на играча' },
    { token: '%combo%', label: 'комбо', desc: 'име на комбинацията' },
    { token: '%val%', label: 'точки', desc: 'точки от хода' },
    { token: '%catmax%', label: 'макс точки', desc: 'максимум за категорията' },
    { token: '%catval%', label: 'вписани', desc: 'вписани точки в категорията' },
    { token: '%turn%', label: 'рунд', desc: 'номер на текущия рунд' },
    { token: '%total%', label: 'сбор', desc: 'общ резултат на играча' },
    { token: '%players%', label: 'играчи', desc: 'брой играчи' },
    { token: '%dice%', label: 'зарове', desc: 'хвърлените зарове' },
    { token: '%same%', label: 'еднакви', desc: 'брой еднакви зарове' },
    { token: '%rerolls%', label: 'презамятания', desc: 'използвани презамятания' },
    { token: '%ps%', label: 'негово/нейно', desc: 'притежателно за комбото' },
    { token: '%po%', label: 'го/я', desc: 'кратко местоимение' },
  ];
  // legacy tokens (older syntax) still recognised so existing strings show as chips
  var VAR_LABEL = { '{c}': 'комбо (фраза)', '{ps}': 'негово/нейно', '{po}': 'го/я', '%combo%': 'комбо', '%val%': 'точки' };
  DEV_VARS.forEach(function (v) { VAR_LABEL[v.token] = v.label; });
  function varLabelFor(tok) { return VAR_LABEL[tok] || tok.replace(/[%{}]/g, ''); }
  // split a template string into text / variable segments
  function parseTemplate(str) {
    var re = /%[a-zA-Z]+%|\{[a-zA-Z]+\}/g, segs = [], last = 0, m;
    while ((m = re.exec(str)) !== null) {
      if (m.index > last) segs.push({ t: 'text', v: str.slice(last, m.index) });
      segs.push({ t: 'var', token: m[0] }); last = m.index + m[0].length;
    }
    if (last < str.length) segs.push({ t: 'text', v: str.slice(last) });
    return segs;
  }
  function devChip(token) {
    var c = document.createElement('span'); c.className = 'ph-chip'; c.contentEditable = 'false';
    c.setAttribute('data-token', token); c.textContent = varLabelFor(token); c.title = token;
    return c;
  }
  // serialise a contenteditable back to a token string (chips → their real token)
  function serializeEditable(box) {
    var out = '';
    (function walk(node) {
      for (var i = 0; i < node.childNodes.length; i++) {
        var n = node.childNodes[i];
        if (n.nodeType === 3) out += n.textContent;
        else if (n.nodeType === 1) {
          if (n.classList && n.classList.contains('ph-chip')) out += n.getAttribute('data-token');
          else if (n.tagName === 'BR') out += '\n';
          else { if (out && !/\n$/.test(out) && /^(DIV|P)$/.test(n.tagName)) out += '\n'; walk(n); }
        }
      }
    })(box);
    return out.replace(/ /g, ' ');
  }
  function devTemplateEditor(initial, onChange) {
    var wrap = document.createElement('div'); wrap.className = 'tmpl-ed';
    var box = document.createElement('div'); box.className = 'tmpl-box'; box.contentEditable = 'true';
    box.setAttribute('role', 'textbox'); box.setAttribute('aria-label', 'текст със заместители');
    parseTemplate(initial || '').forEach(function (s) { box.appendChild(s.t === 'text' ? document.createTextNode(s.v) : devChip(s.token)); });
    function emit() { onChange(serializeEditable(box).replace(/^\s+|\s+$/g, '')); }
    box.addEventListener('input', emit);
    box.addEventListener('click', function (e) {
      var chip = e.target && e.target.closest ? e.target.closest('.ph-chip') : null;
      if (chip) { e.preventDefault(); devVarPop(chip, chip.getAttribute('data-token'), function (tok) { chip.setAttribute('data-token', tok); chip.textContent = varLabelFor(tok); chip.title = tok; emit(); }); }
    });
    wrap.appendChild(box);
    var bar = document.createElement('div'); bar.className = 'tmpl-bar';
    var sel = document.createElement('select'); sel.className = 'tmpl-varsel';
    DEV_VARS.forEach(function (v) { var o = document.createElement('option'); o.value = v.token; o.textContent = v.label + ' — ' + v.desc; sel.appendChild(o); });
    var add = el('button', 'btn small', '+ заместител');
    add.onclick = function () {
      var cur = serializeEditable(box);
      if (cur && !/\s$/.test(cur)) box.appendChild(document.createTextNode(' '));   // keep a space before the new chip
      box.appendChild(devChip(sel.value)); box.appendChild(document.createTextNode(' ')); emit();
    };
    bar.appendChild(sel); bar.appendChild(add);
    wrap.appendChild(bar);
    return wrap;
  }
  // floating variable picker (anchored to the tapped chip)
  function devVarPop(anchor, current, onPick) {
    closeVarPop();
    var pop = document.createElement('div'); pop.className = 'varpop'; pop.id = 'varPop';
    DEV_VARS.forEach(function (v) {
      var b = document.createElement('button'); b.type = 'button'; b.className = 'varopt' + (v.token === current ? ' on' : '');
      b.innerHTML = '<b>' + esc(v.label) + '</b><span>' + esc(v.desc) + '</span>';
      b.onclick = function () { onPick(v.token); closeVarPop(); };
      pop.appendChild(b);
    });
    document.body.appendChild(pop);
    var r = anchor.getBoundingClientRect();
    pop.style.left = Math.min(Math.max(8, r.left), window.innerWidth - pop.offsetWidth - 8) + 'px';
    pop.style.top = (r.bottom + 4) + 'px';
    setTimeout(function () { document.addEventListener('pointerdown', varPopOutside, true); }, 0);
  }
  function varPopOutside(e) { var p = $('varPop'); if (p && !p.contains(e.target)) closeVarPop(); }
  function closeVarPop() { var p = $('varPop'); if (p) p.remove(); document.removeEventListener('pointerdown', varPopOutside, true); }
  // fill a template's variables from the live game (used at render time so the new vars actually show)
  function maxSameCount(d) { if (!d || !d.length) return 0; var c = {}, best = 0; d.forEach(function (v) { c[v] = (c[v] || 0) + 1; if (c[v] > best) best = c[v]; }); return best; }
  var CAT_MAX = { ones: 5, twos: 10, threes: 15, fours: 20, fives: 25, sixes: 30, twoKind: 30, threeKind: 30, fourKind: 30, fullHouse: 28, smallStraight: 15, largeStraight: 20, general: 80, chance: 30 };
  function catMaxFor(key) { return CAT_MAX[key] != null ? CAT_MAX[key] : 0; }
  function gameVarCtx(extra) {
    var p = (game && G.currentPlayer(game)) || {};
    var ctx = {
      name: ((p.name || '') + '').trim(), players: game ? game.players.length : 0, turn: game ? game.round : 0,
      total: game ? total(p) : 0, dice: ((game && game.turn.dice) || []).join(' '), same: maxSameCount((game && game.turn.dice) || []),
      rerolls: (game && typeof game.turn.throwsLeft === 'number') ? Math.max(0, (ROLLS - 1) - game.turn.throwsLeft) : 0,
    };
    if (extra) for (var k in extra) ctx[k] = extra[k];
    return ctx;
  }
  function fillTemplate(str, ctx) { return String(str).replace(/%([a-zA-Z]+)%/g, function (m, k) { var v = ctx[k.toLowerCase()]; return v == null ? m : String(v); }); }

  function buildDevCats() {
    var src = G.dumpSource();
    function words(arr) { return arr.map(function (o, i) { return { id: i, orig: cloneVal(o), val: cloneVal(o), status: 'unchanged' }; }); }
    function texts(arr) { return arr.map(function (s, i) { return { id: i, orig: s, val: s, status: 'unchanged' }; }); }
    function keyed(pairs) { return pairs.map(function (p) { return { id: p[0], orig: p[1], val: p[1], status: 'unchanged' }; }); }
    var personas = [], playstyles = [];
    G.PERSONAS.forEach(function (p) { personas.push([p.id + '.name', p.name], [p.id + '.flavor', p.flavor]); });
    Object.keys(G.PLAYSTYLES).forEach(function (k) { var s = G.PLAYSTYLES[k]; playstyles.push([k + '.name', s.name], [k + '.desc', s.desc]); });
    devCats = [
      { key: 'titles', label: 'Титли', kind: 'word', items: words(src.titles) },
      { key: 'adjs', label: 'Прилагателни', kind: 'word', adj: true, items: words(src.adjs) },
      { key: 'nouns', label: 'Съществителни', kind: 'word', items: words(src.nouns) },
      { key: 'aiAdjs', label: 'AI прилагателни', kind: 'word', adj: true, items: words(src.aiAdjs) },
      { key: 'aiNouns', label: 'AI съществителни', kind: 'word', items: words(src.aiNouns) },
      { key: 'roasts.flop', label: 'Подигравки (флоп)', kind: 'text', items: texts(G.ROASTS.flop) },
      { key: 'roasts.risk', label: 'Подигравки (риск)', kind: 'text', items: texts(G.ROASTS.risk) },
      { key: 'roasts.fail', label: 'Подигравки (провал)', kind: 'text', items: texts(G.ROASTS.fail) },
      { key: 'shames', label: 'Засрамвания', kind: 'text', items: texts(G.SHAME_LINES) },
      { key: 'bets', label: 'Облози', kind: 'text', items: texts(G.BETS) },
      { key: 'ranks', label: 'Чинове', kind: 'text', items: texts(G.RANKS) },
      { key: 'combos', label: 'Описания на комбо', kind: 'keyed', items: keyed(G.CATEGORIES.map(function (c) { return [c.key, G.COMBO_DESC[c.key] || '']; })) },
      { key: 'orders', label: 'Заповеди (имена)', kind: 'keyed', items: keyed(Object.keys(G.ORDER_NAMES).map(function (k) { return [k, G.ORDER_NAMES[k]]; })) },
      { key: 'excl', label: 'Възклицания за рядкост', kind: 'keyed', items: keyed(Object.keys(G.RARITY_EXCL).map(function (k) { return [k, G.RARITY_EXCL[k]]; })) },
      { key: 'personas', label: 'AI стилове', kind: 'keyed', items: keyed(personas) },
      { key: 'playstyles', label: 'Почерци', kind: 'keyed', items: keyed(playstyles) },
    ];
  }
  function devItemText(cat, it) {
    if (cat.kind === 'word') { var v = it.val; return [v.m, v.n, v.f].filter(Boolean).join(' / ') || '∅'; }
    return it.val || '∅';
  }
  function devBadge(st) {
    if (st === 'added') return '<span class="devbadge add">+ ново</span>';
    if (st === 'modified') return '<span class="devbadge mod">~ променено</span>';
    if (st === 'removed') return '<span class="devbadge rem">− премахнато</span>';
    return '';
  }
  // ----- developer string editor (its own modal; in-place expand/collapse editing) -----
  var DEV_GROUPS = [
    { label: 'Имена', keys: ['titles', 'adjs', 'nouns', 'aiAdjs', 'aiNouns'] },
    { label: 'Закачки', keys: ['roasts.flop', 'roasts.risk', 'roasts.fail', 'shames', 'bets'] },
    { label: 'Игра', keys: ['combos', 'orders', 'ranks', 'excl'] },
    { label: 'AI', keys: ['personas', 'playstyles'] },
  ];
  function valEqual(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
  function recomputeStatus(it) { return it._isNew ? 'added' : (valEqual(it.val, it.orig) ? 'unchanged' : 'modified'); }
  function devSecLabelHTML(cat) {
    var changed = cat.items.filter(function (i) { return i.status !== 'unchanged'; }).length;
    return esc(cat.label) + ' (' + cat.items.length + ')' + (changed ? ' <span class="devbadge mod">' + changed + ' промени</span>' : '');
  }
  // collapsed preview: render placeholder tokens as (read-only) chips, exactly like the editor
  function tmplPreviewHTML(str) {
    if (!str) return '∅';
    return parseTemplate(str).map(function (s) {
      return s.t === 'text' ? esc(s.v) : '<span class="ph-chip mini">' + esc(varLabelFor(s.token)) + '</span>';
    }).join('') || '∅';
  }
  function devItemHeadHTML(cat, it) {
    var body = cat.kind === 'word' ? esc(devItemText(cat, it)) : tmplPreviewHTML(it.val);
    return '<span class="diword">' + body + '</span>'
      + (cat.kind === 'word' && it.val.b && it.val.b !== '10+' ? '<span class="devbk r' + bracketRank(it.val.b) + '" style="pointer-events:none">' + it.val.b + '</span>' : '')
      + (cat.kind === 'word' && it.val.nsfw ? '<span class="dinsfw">NSFW</span>' : '')
      + devBadge(it.status);
  }
  function itemsSorted(cat) { return cat.kind === 'word' ? cat.items.slice().sort(function (a, b) { return bracketRank(a.val.b) - bracketRank(b.val.b); }) : cat.items; }
  function refreshDevHead(cat, it) { if (it._head) { it._head.className = 'devitem st-' + it.status; it._head.innerHTML = devItemHeadHTML(cat, it); } }
  function refreshDevSecBadge(cat) { if (cat._sum) cat._sum.innerHTML = devSecLabelHTML(cat); }
  function addDevItem(cat) { var it = { id: 'new', orig: null, val: cat.kind === 'word' ? { b: '10+' } : '', status: 'added', _isNew: true }; cat.items.push(it); return it; }
  function collapseDevEdit(it) { if (it._editEl) { it._editEl.remove(); it._editEl = null; } it._open = false; it._draft = null; }
  function buildDevEditForm(cat, it) {
    var ed = document.createElement('div'); ed.className = 'di-edit';
    var box = document.createElement('div'); box.className = 'deveditbox'; var d = it._draft;
    if (cat.kind === 'word') {
      var fields = document.createElement('div'); fields.className = 'devfields';
      [['m', 'м (база)'], ['n', 'ср'], ['f', 'ж']].forEach(function (f) {
        var w = document.createElement('label'); w.className = 'devf'; w.appendChild(document.createTextNode(f[1]));
        w.appendChild(devArea(d[f[0]], f[1], function (v) { if (v) d[f[0]] = v; else delete d[f[0]]; }));
        fields.appendChild(w);
      });
      box.appendChild(fields);
      var ctr = document.createElement('div'); ctr.className = 'devctrls';
      var bsel = document.createElement('select'); bsel.className = 'devbk r' + bracketRank(d.b);
      G.BRACKETS.forEach(function (b) { var o = document.createElement('option'); o.value = b; o.textContent = b; if ((d.b || '10+') === b) o.selected = true; bsel.appendChild(o); });
      bsel.onchange = function () { d.b = bsel.value; bsel.className = 'devbk r' + bracketRank(d.b); };
      ctr.appendChild(bsel);
      if (cat.adj) { var iL = document.createElement('label'); iL.className = 'devchk'; var ic = document.createElement('input'); ic.type = 'checkbox'; ic.checked = !!d.inv; ic.onchange = function () { if (ic.checked) d.inv = true; else delete d.inv; }; iL.appendChild(ic); iL.appendChild(document.createTextNode('неизм.')); ctr.appendChild(iL); }
      var nL = document.createElement('label'); nL.className = 'devchk nsfw'; var nc = document.createElement('input'); nc.type = 'checkbox'; nc.checked = !!d.nsfw; nc.onchange = function () { if (nc.checked) d.nsfw = true; else delete d.nsfw; }; nL.appendChild(nc); nL.appendChild(document.createTextNode('NSFW')); ctr.appendChild(nL);
      box.appendChild(ctr);
    } else {
      box.appendChild(devTemplateEditor(d, function (v) { it._draft = v; }));
    }
    ed.appendChild(box);
    var bar = document.createElement('div'); bar.className = 'devbar';
    var apply = el('button', 'btn primary', '✓ Приложи'); apply.onclick = function () { devApply(cat, it); };
    var cancel = el('button', 'btn', '✕ Отказ'); cancel.onclick = function () { devCancel(cat, it); };
    bar.appendChild(apply); bar.appendChild(cancel);
    if (!it._isNew && it.status === 'modified') { var rest = el('button', 'btn', '↺ Възстанови'); rest.onclick = function () { devRestore(cat, it); }; bar.appendChild(rest); }
    if (!it._isNew) { var rem = el('button', 'btn devrem', '🗑 Премахни'); rem.onclick = function () { devRemove(cat, it); }; bar.appendChild(rem); }
    ed.appendChild(bar);
    return ed;
  }
  function toggleDevEdit(cat, it) {
    if (it.status === 'removed') { it.status = recomputeStatus(it); refreshDevHead(cat, it); refreshDevSecBadge(cat); devApplyAll(); return; }
    if (it._editEl) { collapseDevEdit(it); return; }
    it._open = true; it._draft = cloneVal(it.val);
    it._editEl = buildDevEditForm(cat, it); it._wrap.appendChild(it._editEl);
  }
  function devApply(cat, it) { it.val = cloneVal(it._draft); it._isNew = false; it.status = recomputeStatus(it); collapseDevEdit(it); refreshDevHead(cat, it); refreshDevSecBadge(cat); devApplyAll(); }
  function devCancel(cat, it) { collapseDevEdit(it); if (it._isNew) { var i = cat.items.indexOf(it); if (i >= 0) cat.items.splice(i, 1); if (it._wrap) it._wrap.remove(); refreshDevSecBadge(cat); } }
  function devRestore(cat, it) { it.val = cloneVal(it.orig); it.status = 'unchanged'; collapseDevEdit(it); refreshDevHead(cat, it); refreshDevSecBadge(cat); devApplyAll(); }
  function devRemove(cat, it) { it.status = 'removed'; collapseDevEdit(it); refreshDevHead(cat, it); refreshDevSecBadge(cat); devApplyAll(); }
  // swipe a row left to mark removed (right to restore) — reversible, part of the diff
  function attachDevSwipe(cat, it, head, wrap) {
    var sx = 0, sy = 0, w = 0, dx = 0, tracking = false;
    head.addEventListener('pointerdown', function (e) { if (e.target.closest('.di-edit')) return; sx = e.clientX; sy = e.clientY; w = wrap.offsetWidth || 300; dx = 0; tracking = true; it._swiping = false; });
    head.addEventListener('pointermove', function (e) {
      if (!tracking) return;
      dx = e.clientX - sx; var dy = e.clientY - sy;
      if (!it._swiping) {
        // decide the gesture: horizontal-dominant → swipe; clearly vertical → let the list scroll
        if (Math.abs(dx) > 6 && Math.abs(dx) >= Math.abs(dy)) { it._swiping = true; try { head.setPointerCapture(e.pointerId); } catch (x) {} }
        else if (Math.abs(dy) > 10) { tracking = false; return; }
        else return;
      }
      // claimed as a swipe: stop the browser from scrolling/cancelling, and ignore vertical drift entirely
      if (e.cancelable) e.preventDefault();
      wrap.style.transform = dx < 0 ? 'translateX(' + Math.max(dx, -0.5 * w) + 'px)' : 'none';
      head.classList.toggle('del-arm', -dx >= 0.4 * w);
    }, { passive: false });
    function end() {
      if (!tracking) return; tracking = false; wrap.style.transform = 'none'; head.classList.remove('del-arm');
      if (-dx >= 0.4 * w) { it.status = it.status === 'removed' ? recomputeStatus(it) : 'removed'; devApplyAll(); refreshDevHead(cat, it); refreshDevSecBadge(cat); }
      else if (dx >= 0.4 * w && it.status === 'removed') { it.status = recomputeStatus(it); devApplyAll(); refreshDevHead(cat, it); refreshDevSecBadge(cat); }
      setTimeout(function () { it._swiping = false; }, 0);
    }
    head.addEventListener('pointerup', end); head.addEventListener('pointercancel', end);
  }
  function buildDevItem(cat, it) {
    var wrap = document.createElement('div'); wrap.className = 'devitem-wrap'; it._wrap = wrap;
    var head = document.createElement('div'); head.className = 'devitem st-' + it.status; it._head = head;
    head.innerHTML = devItemHeadHTML(cat, it);
    head.onclick = function () { if (it._swiping) return; toggleDevEdit(cat, it); };
    wrap.appendChild(head); attachDevSwipe(cat, it, head, wrap);
    return wrap;
  }
  function buildDevSection(cat) {
    var sec = document.createElement('details'); sec.className = 'devsec';
    var sum = document.createElement('summary'); cat._sum = sum; sum.innerHTML = devSecLabelHTML(cat); sec.appendChild(sum);
    var list = document.createElement('div'); list.className = 'devlist'; cat._list = list; sec.appendChild(list);
    itemsSorted(cat).forEach(function (it) { list.appendChild(buildDevItem(cat, it)); });
    var add = el('button', 'devadd', '+ добави');
    add.onclick = function () { var it = addDevItem(cat); list.insertBefore(buildDevItem(cat, it), add); refreshDevSecBadge(cat); toggleDevEdit(cat, it); };
    list.appendChild(add);
    return sec;
  }
  // ----- dev control sections (toggles / actions) above the string editor -----
  function devControlSection(label) {
    var sec = document.createElement('details'); sec.className = 'devsec'; sec.open = true;
    var sum = document.createElement('summary'); sum.textContent = label; sec.appendChild(sum);
    var list = document.createElement('div'); list.className = 'devlist'; sec.appendChild(list);
    return { sec: sec, list: list };
  }
  function devToggleRow(label, key, onChange) {
    var row = document.createElement('div'); row.className = 'devctrl-row';
    row.appendChild(el('span', null, label));
    var tog = document.createElement('button'); tog.type = 'button'; tog.className = 'toggle' + (settings[key] ? ' on' : ''); tog.innerHTML = '<span class="switch"></span>';
    tog.onclick = function () { if (tog.disabled) return; settings[key] = !settings[key]; tog.classList.toggle('on', settings[key]); saveSettings(); if (onChange) onChange(); };
    row.appendChild(tog); return row;
  }
  // a debug toggle stays visible but is greyed/inert until its parent feature is enabled
  function greyDevRow(rowId, on) {
    var r = $(rowId); if (!r) return;
    r.classList.toggle('devrow-disabled', !on);
    var tog = r.querySelector('.toggle'); if (tog) tog.disabled = !on;
  }
  function renderDevControls(body) {
    // ---- Debug: the diagnostic sub-switches ----
    var dbg = devControlSection('Debug');
    var wrd = devToggleRow('Дебъг WebRTC', 'webrtcDebug', function () { syncWrCapVis(); }); wrd.id = 'devWebrtcDebugRow';
    dbg.list.appendChild(wrd);
    body.appendChild(dbg.sec);
    // ---- Experimental: the features themselves ----
    var exp = devControlSection('Experimental');
    var tutRow = document.createElement('div'); tutRow.className = 'devctrl-row';
    tutRow.appendChild(el('span', null, 'Обучение'));
    var tutBtn = el('button', 'btn small', '📚 Започни'); tutBtn.onclick = function () { closeDevModal(true); tutStart(); };
    tutRow.appendChild(tutBtn); exp.list.appendChild(tutRow);
    var mlRow = document.createElement('div'); mlRow.className = 'devctrl-row';
    mlRow.appendChild(el('span', null, 'Мок лоби'));
    var mlBtn = el('button', 'btn small', '🧪 Хост'); mlBtn.onclick = function () { closeDevModal(true); devMockLobby(); };
    var mlcBtn = el('button', 'btn small', '🧪 Гост'); mlcBtn.onclick = function () { closeDevModal(true); devMockLobbyClient(); };
    mlRow.appendChild(mlBtn); mlRow.appendChild(mlcBtn); exp.list.appendChild(mlRow);
    // internet play (WebRTC) is now a release feature — no enable toggle here.
    // (Нови зарове moved out of dev → the keep/throw „?“ bubble, regular settings, and owner defaults)
    body.appendChild(exp.sec);
  }
  function renderDevModal() {
    if (!devCats) buildDevCats();
    var body = $('devBody'); body.innerHTML = '';
    renderDevControls(body);
    DEV_GROUPS.forEach(function (grp) {
      body.appendChild(el('div', 'devgrp', grp.label));
      grp.keys.forEach(function (k) { var cat = devCats.filter(function (c) { return c.key === k; })[0]; if (cat) body.appendChild(buildDevSection(cat)); });
    });
  }
  function devApplyAllBtn() {
    if (!devCats) return;
    devCats.forEach(function (cat) {
      cat.items.forEach(function (it) { if (it._open && it._draft != null) { it.val = cloneVal(it._draft); it._isNew = false; it.status = recomputeStatus(it); collapseDevEdit(it); refreshDevHead(cat, it); } });
      refreshDevSecBadge(cat);
    });
    devApplyAll();
  }
  function openDevModal() { clearSelection(); renderDevModal(); $('devModal').classList.remove('hidden'); }
  function closeDevModal(force) {
    var open = [];
    if (devCats) devCats.forEach(function (cat) { cat.items.forEach(function (it) { if (it._open) open.push({ cat: cat, it: it }); }); });
    if (!force && open.length) { showDevClosePrompt(open); return; }
    $('devModal').classList.add('hidden');
  }
  function showDevClosePrompt(open) {
    if ($('devClosePrompt')) return;
    var ov = document.createElement('div'); ov.id = 'devClosePrompt'; ov.className = 'devcloseprompt';
    ov.innerHTML = '<div class="dcp-box"><div class="dcp-txt">Има <b>' + open.length + '</b> отворени за редакция. Какво да правя с тях?</div>'
      + '<div class="dcp-btns"><button class="btn primary" id="dcpApply">↻ Приложи всичко</button>'
      + '<button class="btn" id="dcpDiscard">Изхвърли</button><button class="btn" id="dcpBack">Назад</button></div></div>';
    $('devModal').querySelector('.modal').appendChild(ov);
    $('dcpApply').onclick = function () { devApplyAllBtn(); ov.remove(); $('devModal').classList.add('hidden'); };
    $('dcpDiscard').onclick = function () { open.forEach(function (o) { devCancel(o.cat, o.it); }); ov.remove(); $('devModal').classList.add('hidden'); };
    $('dcpBack').onclick = function () { ov.remove(); };
  }
  // ----- copy: only the changes, with an executable identifier -----
  function wordJSON(v) { var r = {}; ['m', 'n', 'f'].forEach(function (k) { if (v[k]) r[k] = v[k]; }); if (v.inv) r.inv = true; if (v.nsfw) r.nsfw = true; if (v.b && v.b !== '10+') r.b = v.b; return JSON.stringify(r); }
  function diffVal(cat, v) { return cat.kind === 'word' ? wordJSON(v) : JSON.stringify(v); }
  function serializeDevDiff() {
    var lines = [];
    devCats.forEach(function (cat) {
      cat.items.forEach(function (it) {
        if (it.status === 'unchanged') return;
        var ref = cat.kind === 'keyed' ? cat.key + '.' + it.id : cat.key + '[' + it.id + ']';
        if (it.status === 'removed') lines.push('- ' + ref);
        else if (it.status === 'added') lines.push('+ ' + cat.key + ': ' + diffVal(cat, it.val));
        else lines.push('~ ' + ref + ': ' + diffVal(cat, it.val));
      });
    });
    return lines.length ? lines.join('\n') : '(няма промени)';
  }
  // ----- live preview of the applyable subset (word pools + roast/shame/combos/bets) -----
  function devApplyAll() {
    function cat(key) { return devCats.filter(function (c) { return c.key === key; })[0]; }
    function liveWords(key) { return cat(key).items.filter(function (i) { return i.status !== 'removed'; }).map(function (i) { return i.val; }); }
    G.rebuildFromSource({ titles: liveWords('titles'), adjs: liveWords('adjs'), nouns: liveWords('nouns'), aiAdjs: liveWords('aiAdjs'), aiNouns: liveWords('aiNouns') });
    function liveTexts(key, target) { target.length = 0; cat(key).items.forEach(function (i) { if (i.status !== 'removed' && i.val && i.val.trim()) target.push(i.val); }); }
    liveTexts('roasts.flop', G.ROASTS.flop); liveTexts('roasts.risk', G.ROASTS.risk); liveTexts('roasts.fail', G.ROASTS.fail);
    liveTexts('shames', G.SHAME_LINES); liveTexts('bets', G.BETS);
    cat('combos').items.forEach(function (i) { if (i.status !== 'removed' && i.val) G.COMBO_DESC[i.id] = i.val; });
    if (!$('setup').classList.contains('hidden')) { setupPlayers.forEach(regenName); renderSetup(); }
  }
  function openSettings() {
    // mid-game: hide the pre-game-only bits (старшина, name-bonus + advice toggles,
    // archive housekeeping) — those are decisions to make before a battle.
    // lobby (net prep): show ONLY the shared game settings — owner/ruleset/archive are
    // general, per-device config and don't belong to configuring THIS game.
    var lobbyOnly = netSettCtx;
    var inGame = !$('game').classList.contains('hidden');
    buildSettingsRows(inGame, lobbyOnly);
    // owner/ruleset/archive are general, per-device config — hidden mid-game AND in the lobby's game-settings view
    $('ownerBox').classList.toggle('hidden', inGame || lobbyOnly);
    $('ruleBox').classList.add('hidden');   // ruleset lives on the start screen now — never shown in settings
    $('clearArchiveRow').classList.toggle('hidden', inGame || lobbyOnly);
    $('settingsTitle').innerHTML = '<i class="cog-ic"></i>' + (lobbyOnly ? 'Настройки на играта' : 'Настройки');
    // the version marker (tap = changelog) belongs to the pre-game start screen only
    $('appVer').classList.toggle('hidden', inGame || lobbyOnly);
    // reflect persisted owner controls
    $('ownerName').value = settings.ownerName || '';
    $('ownerToggle').classList.toggle('on', !!settings.useOwnerName);
    syncOwnerGender(); syncOwnerColor(); syncRuleset(); syncOwnerKeep(); syncOwnerBatch();
    $('clearPanel').classList.add('hidden'); $('ownerBubble').classList.add('hidden'); $('ruleBubble').classList.add('hidden'); updateStorageInfo();
    $('settingsModal').classList.remove('hidden');
  }
  $('setupMenuBtn').onclick = openSettings;
  $('menuSettings').onclick = function () { $('menuModal').classList.add('hidden'); openSettings(); };
  function closeSettings() {
    $('settingsModal').classList.add('hidden');
    // host edited pre-game settings from the lobby → publish the new summary
    if (netSettCtx) { netSettCtx = false; if (net && net.isHost && netPhase === 'prep') { net.setSettings(settingsBits()); renderSettSummary(settingsBits()); } }
  }
  $('settingsClose').onclick = closeSettings;
  $('settingsModal').onclick = function (e) { if (e.target === $('settingsModal')) closeSettings(); };

  // ---------- peek (mini scoreboard, like the in-game one) ----------
  function miniBoard(p) {
    function tile(c, up) {
      var f = G.isCategoryFilled(p, c.key);
      var val = f ? p.scores[c.key] : '–';
      if (up) return '<div class="mtile up' + (f ? '' : ' empty') + '"><span class="mlab">' + c.label + '</span><span class="mval">' + val + '</span></div>';
      return '<div class="mtile low' + (f ? '' : ' empty') + '"><span class="mlab">' + c.label + '</span><span class="mval">' + val + '</span></div>';
    }
    var up = G.CATEGORIES.filter(function (c) { return c.group === 'upper'; }).map(function (c) { return tile(c, true); }).join('');
    var low = G.CATEGORIES.filter(function (c) { return c.group === 'lower'; }).map(function (c) { return tile(c, false); }).join('');
    return '<div class="miniboard"><div class="upper">' + up + '</div><div class="lower">' + low + '</div></div>';
  }
  function openPeek(i) {
    var p = game.players[i];
    $('peekTitle').innerHTML = (isOwnerP(p) ? ownerTokenHTML(true) : '') + esc(p.name) + (p.isAI && p.persona ? ' <span class="badge-ai">' + esc(p.persona.name) + '</span>' : '');
    $('peekBody').innerHTML = miniBoard(p);
    $('peekTotal').textContent = total(p);
    $('peekModal').classList.remove('hidden');
    if (tut) tutEvent('peek');
  }
  $('peekClose').onclick = function () { $('peekModal').classList.add('hidden'); };
  $('peekModal').onclick = function (e) { if (e.target === $('peekModal')) $('peekModal').classList.add('hidden'); };

