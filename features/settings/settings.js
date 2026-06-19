'use strict';
// Settings actions: export/import (text), owner name, ruleset picker, storage gauge, bulk-clear.
  // ---- export / import a game (share local history across devices) ----
  var currentExportRec = null;
  function exportGame(rec) {
    track('export');
    currentExportRec = rec;
    $('exportText').value = JSON.stringify(rec, null, 2);
    $('exportCopied').classList.add('hidden');
    $('exportModal').classList.remove('hidden');
  }
  function copyExport() {
    var ta = $('exportText'), txt = ta.value;
    function done() { $('exportCopied').classList.remove('hidden'); }
    function legacy() { ta.removeAttribute('readonly'); ta.focus(); ta.select(); try { document.execCommand('copy'); } catch (e) {} ta.setAttribute('readonly', ''); ta.blur(); done(); }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(done, legacy);
    else legacy();
  }
  $('exportCopy').onclick = copyExport;
  $('exportClose').onclick = function () { $('exportModal').classList.add('hidden'); };
  $('exportModal').onclick = function (e) { if (e.target === $('exportModal')) $('exportModal').classList.add('hidden'); };
  function validateGameJSON(o) {
    if (!o || typeof o !== 'object') return 'Невалиден JSON обект.';
    if (!Array.isArray(o.players) || !o.players.length) return 'Липсват играчи.';
    // partial games are welcome: moveLog may be absent or shorter — sanitizeRecord
    // pads/truncates per player safely, so we only reject an outright wrong type
    if (o.moveLog != null && !Array.isArray(o.moveLog)) return 'moveLog е невалиден.';
    for (var i = 0; i < o.players.length; i++) {
      var p = o.players[i];
      if (!p || typeof p.name !== 'string' || !p.scores || typeof p.scores !== 'object') return 'Играч ' + (i + 1) + ' е невалиден.';
    }
    return null;
  }
  var importParsed = null;     // the sanitised record being imported
  var importStage = 'parse';   // parse → choice → owner | merge
  function importReset() {
    $('importChoice').innerHTML = ''; $('importChoice').classList.add('hidden');
    $('importOwner').innerHTML = ''; $('importOwner').classList.add('hidden');
    $('importMerge').innerHTML = ''; $('importMerge').classList.add('hidden');
    $('importErr').classList.add('hidden'); $('importErr').textContent = '';
  }
  function openImport() {
    importParsed = null; importStage = 'parse';
    $('importText').value = ''; $('importText').classList.remove('hidden');
    importReset();
    $('importDo').textContent = 'Провери'; $('importDo').classList.remove('hidden');
    $('historyModal').classList.add('hidden');
    $('importModal').classList.remove('hidden');
  }
  function importError(msg) { $('importErr').textContent = '⚠ ' + msg; $('importErr').classList.remove('hidden'); }
  function importSelect(scope, sel, b) { $(scope).querySelectorAll(sel).forEach(function (x) { x.classList.remove('on'); }); b.classList.add('on'); }

  // step 2: with games already in the archive, offer to file the whole game OR to
  // graft one of its players onto an existing battle (handy for partial games)
  function showImportChoice(rec) {
    importParsed = rec; importStage = 'choice';
    $('importText').classList.add('hidden'); importReset();
    if (!loadHistory().length) { showImportOwner(rec); return; }   // nothing to merge into yet
    $('importChoice').innerHTML = '<div class="iolbl">Какво да направя с играта?</div>'
      + '<div class="iochoice">'
      + '<button type="button" class="btn" id="impWhole">📥 Внеси като нова битка</button>'
      + '<button type="button" class="btn" id="impMerge">➕ Добави играч към друга битка</button>'
      + '</div>';
    $('importChoice').classList.remove('hidden');
    $('importDo').classList.add('hidden');
    $('impWhole').onclick = function () { importReset(); showImportOwner(importParsed); };
    $('impMerge').onclick = function () { importReset(); showImportMerge(importParsed); };
  }
  // file the whole record: pick which seat is the старшина (device owner)
  function showImportOwner(rec) {
    importParsed = rec; importStage = 'owner';
    $('importText').classList.add('hidden');
    var chips = rec.players.map(function (p, i) {
      return '<button type="button" class="iochip' + (i === 0 ? ' on' : '') + '" data-val="' + i + '" style="--c:' + p.color + '"><span class="iodot"></span>' + esc(p.name) + '</button>';
    }).join('') + '<button type="button" class="iochip io-none" data-val="-1"><span class="iodot"></span>Никой (само в архива)</button>';
    $('importOwner').innerHTML = '<div class="iolbl">Кой играч си ти (старшината)?</div><div class="iogrid">' + chips + '</div>';
    $('importOwner').querySelectorAll('.iochip').forEach(function (b) {
      b.onclick = function () { importSelect('importOwner', '.iochip', b); };
    });
    $('importOwner').classList.remove('hidden');
    $('importDo').textContent = 'Импортирай';
    $('importDo').classList.remove('hidden');
    $('importModal').classList.remove('hidden');
  }
  // merge path: choose a player from the imported game + a target battle to add them to
  function showImportMerge(rec) {
    importParsed = rec; importStage = 'merge';
    $('importText').classList.add('hidden');
    var pchips = rec.players.map(function (p, i) {
      return '<button type="button" class="iochip iop' + (i === 0 ? ' on' : '') + '" data-val="' + i + '" style="--c:' + p.color + '"><span class="iodot"></span>' + esc(p.name) + '</button>';
    }).join('');
    var games = loadHistory().slice().reverse();   // newest first
    var gchips = games.map(function (g, i) {
      var lbl = fmtDate(g.ts) + ' · ' + g.players.length + ' бойци' + (g.manualMode ? ' · отчет' : '');
      return '<button type="button" class="iochip iog' + (i === 0 ? ' on' : '') + '" data-gid="' + esc(g.id) + '" style="--c:#c8a64b"><span class="iodot"></span>' + esc(lbl) + '</button>';
    }).join('');
    $('importMerge').innerHTML = '<div class="iolbl">Кой играч да добавя?</div><div class="iogrid">' + pchips + '</div>'
      + '<div class="iolbl">Към коя битка?</div><div class="iogrid iogames">' + gchips + '</div>';
    $('importMerge').querySelectorAll('.iop').forEach(function (b) { b.onclick = function () { importSelect('importMerge', '.iop', b); }; });
    $('importMerge').querySelectorAll('.iog').forEach(function (b) { b.onclick = function () { importSelect('importMerge', '.iog', b); }; });
    $('importMerge').classList.remove('hidden');
    $('importDo').textContent = 'Слей';
    $('importDo').classList.remove('hidden');
    $('importModal').classList.remove('hidden');
  }
  function importStep() {
    $('importErr').classList.add('hidden');
    if (importStage === 'parse') {               // step 1: parse + validate + SANITISE
      var obj; try { obj = JSON.parse($('importText').value); } catch (e) { importError('JSON не може да се прочете.'); return; }
      var err = validateGameJSON(obj); if (err) { importError(err); return; }
      var clean = MP.sanitizeRecord(obj, CAT_KEYS);          // never trust the input — whitelist it
      if (!clean) { importError('Данните са невалидни.'); return; }
      showImportChoice(clean);
      return;
    }
    if (importStage === 'merge') { doMergePlayer(); return; }
    fileImportedRecord();
  }
  // graft the chosen player onto the chosen battle as an extra seat
  function doMergePlayer() {
    var psel = $('importMerge').querySelector('.iop.on'), gsel = $('importMerge').querySelector('.iog.on');
    if (!psel || !gsel) { importError('Избери играч и битка.'); return; }
    var err = mergePlayerIntoGame(importParsed, +psel.getAttribute('data-val'), gsel.getAttribute('data-gid'));
    if (err) { importError(err); return; }
    track('import');
    $('importModal').classList.add('hidden');
    openHistory();
  }
  function mergePlayerIntoGame(srcRec, playerIdx, targetId) {
    var arr = loadHistory(), target = arr.filter(function (r) { return r.id === targetId; })[0];
    if (!target) return 'Целевата битка не е намерена.';
    if (target.players.length >= 8) return 'Битката е пълна (8 бойци).';
    var src = srcRec.players[playerIdx]; if (!src) return 'Невалиден играч.';
    var clone = JSON.parse(JSON.stringify(src)); clone.owner = false;   // target keeps its own старшина
    target.players.push(clone);
    if (!Array.isArray(target.moveLog)) target.moveLog = [];
    while (target.moveLog.length < target.players.length - 1) target.moveLog.push([]);
    var srcLog = (Array.isArray(srcRec.moveLog) && Array.isArray(srcRec.moveLog[playerIdx])) ? srcRec.moveLog[playerIdx] : [];
    target.moveLog.push(JSON.parse(JSON.stringify(srcLog)));
    persistHistory(arr);
    return null;
  }
  // step 3: assign the chosen owner and file the (already sanitised) record
  function fileImportedRecord() {
    var sel = $('importOwner').querySelector('.iochip.on');
    var owner = sel ? +sel.getAttribute('data-val') : -1, rec = importParsed;
    rec.players.forEach(function (p, i) { p.owner = (i === owner); });
    rec.ownerSkipped = owner < 0;
    rec.id = 'g' + Date.now() + '_' + Math.floor(Math.random() * 1e4);
    rec.ts = rec.ts || Date.now();
    rec.manualMode = !!rec.manualMode;
    var arr = loadHistory(); arr.push(rec); arr.sort(function (a, b) { return (a.ts || 0) - (b.ts || 0); }); persistHistory(arr);
    track('import');
    $('importModal').classList.add('hidden');
    openHistory();
  }
  $('importBtn').onclick = function () { openImport(); };
  $('importDo').onclick = importStep;
  $('importCancel').onclick = function () { $('importModal').classList.add('hidden'); openHistory(); };
  $('importClose').onclick = function () { $('importModal').classList.add('hidden'); openHistory(); };
  $('importModal').onclick = function (e) { if (e.target === $('importModal')) { $('importModal').classList.add('hidden'); openHistory(); } };

  function syncWebrtcUI() {
    document.querySelectorAll('.wrfeature').forEach(function (el) { el.classList.toggle('hidden', !settings.webrtc); });
  }
  // a FRESH open (from the start screen / menu) resets to the default ruleset section + page 1
  function openHistory() {
    histTab = (settings.ruleset === 'experimental') ? 'experimental' : 'standard';   // default to the active ruleset
    histDateFilter = null;   // a fresh open clears any calendar date filter
    histShown = 5;           // fresh open starts at the first page
    histPlayFilter = 'all';  // and clears the manual/engine filter
    histPulsePending = true;  // pulse the first row's right edge once on this open
    showHistory();
  }
  // (re)display the archive WITHOUT touching the tab / paging / date filter — used when
  // returning from a game's details or a replay, so loaded games + section persist
  function showHistory() {
    $('calModal').classList.add('hidden');
    renderHistory();
    $('settingsModal').classList.add('hidden'); $('menuModal').classList.add('hidden');
    $('historyModal').classList.remove('hidden');
    if (histPulsePending) {   // first row's right-edge intro animation — only on a fresh open
      histPulsePending = false;
      var first = $('historyList').querySelector('.histgame'); if (first) pulseFirstRow(first);
    }
  }
  $('historyClose').onclick = function () { $('historyModal').classList.add('hidden'); };
  $('historyModal').onclick = function (e) { if (e.target === $('historyModal')) $('historyModal').classList.add('hidden'); };
  $('archiveBtn').onclick = openHistory; // archive lives only on the start screen now

  // ---------- owner name + clear-archive controls (settings) ----------
  var OWNER_INFO = '<b>Старшината си ти</b> — собственикът на устройството.<br>'
    + 'Това винаги е играч №1, но може да се размести на друга позиция преди да започне играта.<br>'
    + 'Използва се, за да играеш с име, което ти харесва, и за да се изготвя личен анализ на игрите от архива.';
  $('ownerHelp').onclick = function () {
    var b = $('ownerBubble');
    if (!b.classList.contains('hidden')) { b.classList.add('hidden'); return; }
    b.innerHTML = OWNER_INFO; b.classList.remove('hidden');
  };
  $('ownerBubble').onclick = function () { $('ownerBubble').classList.add('hidden'); };
  // tapping the ★ owner token (in setup) pops a dismissible explainer + skip control
  function skipBtnLabel() { return skipOwnerNext ? '✓ Старшината е пропуснат за следващата игра' : 'Пропусни старшината за следващата игра'; }
  function showOwnerInfo(anchor) {
    var b = $('ownerInfo');
    if (!b.classList.contains('hidden')) { b.classList.add('hidden'); return; }
    b.innerHTML = OWNER_INFO
      + '<div class="oi-cust">'
      +   '<div class="oi-crow"><span>Зарове</span><div class="keepseg" id="oiKeep"><button class="klabel" data-keep="1">дръж</button><button class="klabel" data-keep="0">хвърли</button></div></div>'
      +   '<div class="oi-crow"><span>Нови зарове</span><div class="keepseg" id="oiBatch"><button class="klabel" data-batch="0">подреди</button><button class="klabel" data-batch="1">раздели</button></div></div>'
      + '</div>'
      + '<div class="oi-skip-note">Друг играе на телефона? Пропусни старшината — тази игра няма да влезе в личната статистика.</div>'
      + '<button class="oi-skip' + (skipOwnerNext ? ' on' : '') + '" id="ownerSkipBtn">' + skipBtnLabel() + '</button>';
    b.classList.remove('hidden');
    // owner default dice mechanics, editable straight from the token (mirrors the settings owner box)
    function oiSyncSegs() {
      $('oiKeep').querySelectorAll('.klabel').forEach(function (x) { x.classList.toggle('on', (x.getAttribute('data-keep') === '1') === !!settings.selectKeep); });
      $('oiBatch').querySelectorAll('.klabel').forEach(function (x) { x.classList.toggle('on', (x.getAttribute('data-batch') === '1') === !!settings.newDiceBatch); });
    }
    $('oiKeep').querySelectorAll('.klabel').forEach(function (x) { x.onclick = function (e) { e.stopPropagation(); settings.selectKeep = x.getAttribute('data-keep') === '1'; saveSettings(); oiSyncSegs(); }; });
    $('oiBatch').querySelectorAll('.klabel').forEach(function (x) { x.onclick = function (e) { e.stopPropagation(); settings.newDiceBatch = x.getAttribute('data-batch') === '1'; saveSettings(); oiSyncSegs(); }; });
    oiSyncSegs();
    $('ownerSkipBtn').onclick = function (e) {
      e.stopPropagation();
      skipOwnerNext = !skipOwnerNext;
      this.textContent = skipBtnLabel(); this.classList.toggle('on', skipOwnerNext);
      // re-render so the owner card picks up its new removability + muted-token state
      if (!$('setup').classList.contains('hidden')) renderSetup();
    };
    var r = anchor.getBoundingClientRect();
    b.style.left = Math.min(Math.max(8, r.left + r.width / 2 - b.offsetWidth / 2), window.innerWidth - b.offsetWidth - 8) + 'px';
    var below = r.bottom + 8;
    b.style.top = (below + b.offsetHeight < window.innerHeight - 8 ? below : r.top - b.offsetHeight - 8) + 'px';
  }
  $('ownerInfo').onclick = function () { $('ownerInfo').classList.add('hidden'); };
  // shared 14-swatch colour popover for the setup cards (replaces the system <input type=color>)
  function hideColorPop() { $('colorPop').classList.add('hidden'); }
  // the swatches to offer: only colours nobody else is using (plus the current pick),
  // so the picker can't create a collision in the first place
  function freeSwatches(curColor, usedLower) {
    var cur = (curColor || '').toLowerCase();
    var out = PRESET_COLORS.filter(function (c) { var lc = c.toLowerCase(); return lc === cur || usedLower.indexOf(lc) < 0; });
    if (cur && out.map(function (c) { return c.toLowerCase(); }).indexOf(cur) < 0) out = [curColor].concat(out);   // keep a legacy colour visible
    return out;
  }
  // generic swatch popover: anchor + current colour + a pick callback + the colours to show
  function openColorPop(anchor, curColor, token, onPick, colors) {
    var b = $('colorPop');
    if (!b.classList.contains('hidden') && b._for === token) { hideColorPop(); return; }
    b._for = token;
    var cur = (curColor || '').toLowerCase();
    b.innerHTML = (colors || PRESET_COLORS).map(function (c) {
      return '<button type="button" class="pswatch' + (c.toLowerCase() === cur ? ' on' : '') + '" data-c="' + c + '" style="background:' + c + '" aria-label="' + c + '"></button>';
    }).join('');
    b.querySelectorAll('.pswatch').forEach(function (sw) {
      sw.onclick = function (e) { e.stopPropagation(); hideColorPop(); onPick(sw.getAttribute('data-c')); };
    });
    b.classList.remove('hidden');
    var r = anchor.getBoundingClientRect();
    b.style.left = Math.min(Math.max(8, r.left + r.width / 2 - b.offsetWidth / 2), window.innerWidth - b.offsetWidth - 8) + 'px';
    var below = r.bottom + 8;
    b.style.top = (below + b.offsetHeight < window.innerHeight - 8 ? below : Math.max(8, r.top - b.offsetHeight - 8)) + 'px';
  }
  function showColorPop(anchor, p) {
    // free = every colour not held by the OTHER seats (owner included) — picking can't collide
    var used = setupPlayers.filter(function (q) { return q !== p; }).map(function (q) { return (q.color || '').toLowerCase(); });
    openColorPop(anchor, p.color, p, function (c) { p.color = c; dedupeColors(); renderSetup(); }, freeSwatches(p.color, used));
  }
  $('ownerName').oninput = function () {
    settings.ownerName = $('ownerName').value; saveSettings();
    if (settings.useOwnerName && !$('setup').classList.contains('hidden')) renderSetup();
  };
  $('ownerToggle').onclick = function () {
    settings.useOwnerName = !settings.useOwnerName;
    $('ownerToggle').classList.toggle('on', settings.useOwnerName);
    saveSettings();
    if (!$('setup').classList.contains('hidden')) {
      if (!settings.useOwnerName && setupPlayers.length) regenName(ownerOf(setupPlayers)); // give the owner a fresh random name
      renderSetup();
    }
  };
  // default colour for the старшина — a single swatch opening the SAME popover as player seats
  $('ownerColorBtn').onclick = function (e) {
    e.stopPropagation();
    var used = setupPlayers.filter(function (p) { return !p.owner; }).map(function (p) { return (p.color || '').toLowerCase(); });
    openColorPop($('ownerColorBtn'), settings.ownerColor, 'owner', function (c) {
      settings.ownerColor = c; syncOwnerColor(); saveSettings();
      if (setupPlayers.length) { ownerOf(setupPlayers).color = c; dedupeColors(); if (!$('setup').classList.contains('hidden')) renderSetup(); }
    }, freeSwatches(settings.ownerColor, used));
  };
  function syncOwnerColor() { $('ownerColorBtn').style.background = settings.ownerColor || PRESET_COLORS[0]; }
  // ---- ruleset picker (Стандартен / Експериментален) ----
  function syncRuleset() { $('ruleSeg').querySelectorAll('.rlabel').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-rs') === (settings.ruleset || 'standard')); }); }
  $('ruleSeg').querySelectorAll('.rlabel').forEach(function (b) {
    b.onclick = function () {
      settings.ruleset = b.getAttribute('data-rs'); syncRuleset(); syncStartRuleSel(); saveSettings();
      // experimental gameplay (the three-column card) is still being built — be honest
      if (settings.ruleset === 'experimental') showRuleBubble();
      else $('ruleBubble').classList.add('hidden');
    };
  });
  function showRuleBubble() {
    $('ruleBubble').innerHTML = '<b>С минуси</b> — българският „Генерал“: една карта, '
      + 'попълваш редовете в произволен ред. Числовата част (1-6) се точкува със знак около три '
      + '(−50, ако завърши на минус), плюс комбинация „два чифта“. <b>Без минуси</b> е класическата игра.';
    $('ruleBubble').classList.remove('hidden');
  }
  $('ruleHelp').onclick = function (e) { e.preventDefault(); e.stopPropagation(); $('ruleBubble').classList.toggle('hidden'); if (!$('ruleBubble').innerHTML) showRuleBubble(); };
  // default gender for the старшина (applied to the owner seat)
  function syncOwnerGender() { $('ownerGender').querySelectorAll('.glabel').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-g') === settings.ownerGender); }); }
  $('ownerGender').querySelectorAll('.glabel').forEach(function (b) {
    b.onclick = function () {
      settings.ownerGender = b.getAttribute('data-g'); syncOwnerGender(); saveSettings();
      if (setupPlayers.length) {
        var o = ownerOf(setupPlayers);
        if (settings.useOwnerName) { o.gender = settings.ownerGender; applyOwnerName(); }
        else setGender(o, settings.ownerGender);   // re-cohere a random owner name to the new gender
        if (!$('setup').classList.contains('hidden')) renderSetup();
      }
    };
  });
  // default dice-selection flavour for the старшина (also the default for any human seat)
  function syncOwnerKeep() { $('ownerKeep').querySelectorAll('.klabel').forEach(function (b) { b.classList.toggle('on', (b.getAttribute('data-keep') === '1') === !!settings.selectKeep); }); }
  $('ownerKeep').querySelectorAll('.klabel').forEach(function (b) {
    b.onclick = function () { settings.selectKeep = b.getAttribute('data-keep') === '1'; syncOwnerKeep(); saveSettings(); };
  });
  function syncOwnerBatch() { $('ownerBatch').querySelectorAll('.klabel').forEach(function (b) { b.classList.toggle('on', (b.getAttribute('data-batch') === '1') === !!settings.newDiceBatch); }); }
  $('ownerBatch').querySelectorAll('.klabel').forEach(function (b) {
    b.onclick = function () { settings.newDiceBatch = b.getAttribute('data-batch') === '1'; syncOwnerBatch(); saveSettings(); };
  });
  // ---- localStorage fullness gauge (next to the clear-archive control) ----
  var LS_QUOTA = 5 * 1024 * 1024;   // typical per-origin localStorage cap (~5 MB)
  function lsBytes() {
    var t = 0;
    try { for (var i = 0; i < window.localStorage.length; i++) { var k = window.localStorage.key(i); var v = window.localStorage.getItem(k); t += k.length + (v ? v.length : 0); } } catch (e) {}
    return t * 2;   // UTF-16 ≈ 2 bytes/char
  }
  function updateStorageInfo() {
    if (!$('storeInfo')) return;
    var used = lsBytes(), pct = Math.min(100, Math.round(100 * used / LS_QUOTA)), kb = Math.max(1, Math.round(used / 1024));
    var games = loadHistory().length, cls = pct >= 85 ? 'crit' : pct >= 60 ? 'hi' : '';
    $('storeInfo').innerHTML = 'Памет: <b>' + pct + '%</b> · ' + kb + ' KB · <b>' + games + '</b> ' + (games === 1 ? 'игра' : 'игри')
      + '<span class="sbar"><i class="' + cls + '" style="width:' + pct + '%"></i></span>';
  }
  // ---- bulk-clear: pick which saved games to delete (all preselected) ----
  var cpSel = {};
  function openClearPanel() {
    cpSel = {}; loadHistory().forEach(function (g) { cpSel[g.id] = 1; });   // all preselected
    $('cpConfirm').classList.add('hidden');
    renderClearList();
    $('clearPanel').classList.remove('hidden');
  }
  function renderClearList() {
    var games = loadHistory().slice().reverse();   // newest first
    if (!games.length) { $('cpList').innerHTML = '<div class="cp-empty">Архивът е празен.</div>'; }
    else $('cpList').innerHTML = games.map(function (g) {
      var top = g.players && g.players.length ? Math.max.apply(null, g.players.map(function (p) { return recTotal(p, recIsExp(g)); })) : 0;
      return '<label class="cp-row"><input type="checkbox" data-id="' + esc(g.id) + '"' + (cpSel[g.id] ? ' checked' : '') + '>'
        + '<span class="cp-when">' + esc(fmtDate(g.ts)) + ' · ' + esc(fmtTime(g.ts)) + '</span>'
        + '<span class="cp-meta">' + (g.players ? g.players.length : '?') + ' бойци</span>'
        + '<span class="cp-pts">' + top + '</span></label>';
    }).join('');
    $('cpList').querySelectorAll('input[type=checkbox]').forEach(function (cb) {
      cb.onchange = function () { var id = cb.getAttribute('data-id'); if (cb.checked) cpSel[id] = 1; else delete cpSel[id]; syncDeleteBtn(); };
    });
    syncDeleteBtn();
  }
  function syncDeleteBtn() { var n = Object.keys(cpSel).length; $('cpDelete').disabled = n === 0; $('cpDelete').textContent = '🔥 Изтрий избраните (' + n + ')'; }
  $('clearHistory').onclick = openClearPanel;
  $('cpCancel').onclick = function () { $('clearPanel').classList.add('hidden'); };
  $('cpSelAll').onclick = function () { loadHistory().forEach(function (g) { cpSel[g.id] = 1; }); renderClearList(); };
  $('cpSelNone').onclick = function () { cpSel = {}; renderClearList(); };
  $('cpDelete').onclick = function () {
    var n = Object.keys(cpSel).length; if (!n) return;
    $('cpConfirmTxt').textContent = n + (n === 1 ? ' игра ще изгори завинаги.' : ' игри ще изгорят завинаги.') + ' Сигурен ли си, командире?';
    $('cpConfirm').classList.remove('hidden');
  };
  $('cpConfirmNo').onclick = function () { $('cpConfirm').classList.add('hidden'); };
  $('cpConfirmYes').onclick = function () {
    var keep = loadHistory().filter(function (g) { return !cpSel[g.id]; });
    if (keep.length) persistHistory(keep); else lsDel(HISTORY_KEY);
    cpSel = {}; $('cpConfirm').classList.add('hidden');
    updateStorageInfo(); renderClearList();
    if (!$('historyModal').classList.contains('hidden')) renderHistory();
  };

  $('playAgain').onclick = function () {
    if (viewingHistory) { exitHistoryGame(false); }
    resetNet();
    $('overModal').classList.add('hidden'); $('game').classList.add('hidden'); $('setup').classList.remove('hidden');
  };
  // tear down any net session (returning to the muster screen)
  function resetNet() {
    if (net) { try { net.dispose(); } catch (e) {} }
    netActiveClear();   // leaving on purpose → don't offer to rejoin
    net = null; netMode = false; localPid = null; netMyTurn = false;
    netActiveId = null; specSelf = false; specAct = null; resetSpecPlay(); if ($('specReturn')) $('specReturn').classList.add('hidden');
    $('netLink').classList.add('hidden'); $('netLink').innerHTML = '';
  }

