'use strict';
// Scripted tutorial (guided dice + coach bubbles).
  // ========================================================== TUTORIAL (scripted dice + coach bubbles)
  // A fully-filled „Новобранец" opponent sits beside the learner so every nextTurn bounces
  // straight back to the learner (the opponent is „done"), and so peeking shows a real board.
  var TUT_OPP_STD = { ones:3, twos:6, threes:9, fours:8, fives:15, sixes:12, twoKind:10, threeKind:18, fourKind:0, fullHouse:25, smallStraight:30, largeStraight:0, general:0, chance:21 };
  var TUT_OPP_EXP = { ones:-2, twos:0, threes:3, fours:4, fives:5, sixes:6, twoKind:10, twoPair:14, threeKind:12, fourKind:0, fullHouse:18, smallStraight:30, largeStraight:40, general:0, chance:17 };
  var TUT_HINT = { roll:'👆 натисни ХВЪРЛИ!', reroll:'👆 хвърли заровете', rerollAll:'👆 маркирай всички и хвърли', commit:'👆 докосни полето', peek:'👆 докосни маркера', chooser:'👆 натисни ?' };
  var TUT_STD = [
    { t:'Добре дошъл в <b>Генерал</b>! Имаш <b>14 полета</b> — всеки ход пълниш по едно. Целта е най-много точки.', at:null },
    { t:'Горе са играчите. <b>Светналият</b> маркер е този, който е на ход — сега си <b>ти</b>.', at:'pills' },
    { t:'Всеки ход хвърляш <b>до 3 пъти</b>. Натисни <b>ХВЪРЛИ!</b>, за да започнеш.', at:'fire', gate:'roll', dice:[2,3,1,4,2] },
    { t:'Слаб начален зар. Можеш да <b>маркираш</b> зарове с докосване — в режим „дръж" пазиш маркираните, а останалите се хвърлят пак.', at:'dice' },
    { t:'С бутона <b>?</b> сменяш режима: маркираш кои да <b>държиш</b> или кои да <b>хвърлиш</b>. Отвори го да видиш.', at:'fireQ', gate:'chooser' },
    { t:'Избери <b>„хвърли"</b> и затвори балончето — така маркираните зарове се хвърлят наново.', at:'fireQ' },
    { t:'Този път <b>хвърли всичко</b> наново: маркирай и петте зара и натисни ХВЪРЛИ!', at:'dice', gate:'rerollAll', dice:[6,2,6,3,6] },
    { t:'<b>Три шестици!</b> Запиши ги в полето <b>„шестици"</b> (18 т.) от таблото горе.', at:'up', gate:'commit', key:'sixes' },
    { t:'Браво! Сега ще гоним <b>ГЕНЕРАЛ</b> — пет еднакви. Хвърли отново.', at:'fire', gate:'roll', dice:[4,4,1,4,2] },
    { t:'Имаш <b>три четворки</b> — задръж тях и хвърли другите два.', at:'dice', gate:'reroll', dice:[4,4,4,5,4] },
    { t:'Още една четворка! Хвърли последния зар.', at:'dice', gate:'reroll', dice:[4,4,4,4,4] },
    { t:'<b>ГЕНЕРАЛ! 70 точки.</b> Запиши го в полето <b>„генерал"</b>.', at:'low', gate:'commit', key:'general' },
    { t:'Един и същ зар често става за <b>няколко полета</b>. Хвърли.', at:'fire', gate:'roll', dice:[5,5,3,3,1] },
    { t:'Тези зарове стават за <b>„2 еднакви"</b> (10 т.), но и за „петици". <b>Ти избираш</b> къде да ги запишеш. Сега избери <b>„2 еднакви"</b>.', at:'low', gate:'commit', key:'twoKind' },
    { t:'Нов ход. Хвърли.', at:'fire', gate:'roll', dice:[1,2,4,6,1] },
    { t:'Не можеш да направиш <b>голяма кента</b>. Понякога си <b>принуден да жертваш</b> поле за <b>0</b> точки. Докосни „голяма кента", за да я зачеркнеш.', at:'low', gate:'commit', key:'largeStraight' },
    { t:'Последен ход за обучението. Хвърли.', at:'fire', gate:'roll', dice:[3,3,3,3,6] },
    { t:'Преди да запишеш — <b>надникни</b> в дъската на съперника. Докосни неговия маркер горе.', at:'pills', gate:'peek' },
    { t:'Това е неговата дъска. Затвори я и се върни към твоя ход.', at:null },
    { t:'Имаш <b>каре</b> (четири еднакви). Запиши го в <b>„4 еднакви"</b> (12 т.).', at:'low', gate:'commit', key:'fourKind' },
    { t:'<b>Готово, командире!</b> Хвърляш, държиш/хвърляш зарове и пълниш по едно поле всеки ход. На бой!', at:null },
  ];
  var TUT_EXP = [
    { t:'Това е <b>Генерал „с минуси"</b>! <b>15 полета</b>, по едно на ход. Внимавай — числовата част може и да <b>отнема</b> точки.', at:null },
    { t:'Горе са играчите. <b>Светналият</b> маркер е на ход — сега си <b>ти</b>.', at:'pills' },
    { t:'Хвърляш <b>до 3 пъти</b> на ход. Натисни <b>ХВЪРЛИ!</b>.', at:'fire', gate:'roll', dice:[2,3,1,4,2] },
    { t:'Маркирай зарове с докосване. С бутона <b>?</b> сменяш дали маркираш кои да <b>държиш</b> или кои да <b>хвърлиш</b>. Отвори го.', at:'fireQ', gate:'chooser' },
    { t:'Избери режим, затвори, после <b>хвърли всичко</b> наново — маркирай и петте зара и натисни ХВЪРЛИ!', at:'dice', gate:'rerollAll', dice:[6,6,6,4,2] },
    { t:'<b>Три шестици!</b> Задръж ги и хвърли другите два за още.', at:'dice', gate:'reroll', dice:[6,6,6,6,2] },
    { t:'<b>Числата</b> (горе) се броят като <b>(брой − 3) × лицето</b>: четири шестици = <b>+6</b>. Запиши „шестици". ⚠ Ако сборът на числата завърши под нулата — <b>−50</b>!', at:'up', gate:'commit', key:'sixes' },
    { t:'Браво! Сега <b>ГЕНЕРАЛ</b> — пет еднакви. Хвърли.', at:'fire', gate:'roll', dice:[4,4,1,4,2] },
    { t:'Три четворки — задръж ги и хвърли другите.', at:'dice', gate:'reroll', dice:[4,4,4,5,4] },
    { t:'Още един! Хвърли последния зар.', at:'dice', gate:'reroll', dice:[4,4,4,4,4] },
    { t:'<b>ГЕНЕРАЛ! 70 точки.</b> Запиши „генерал".', at:'low', gate:'commit', key:'general' },
    { t:'Един зар може да става за <b>няколко полета</b>. Хвърли.', at:'fire', gate:'roll', dice:[5,5,3,3,1] },
    { t:'Имаш <b>два чифта</b>: стават за <b>„2x2"</b> (16 т.) или само „2x" (10 т.). Ти избираш. Запиши <b>„2x2"</b>.', at:'low', gate:'commit', key:'twoPair' },
    { t:'Нов ход. Хвърли.', at:'fire', gate:'roll', dice:[1,2,4,6,1] },
    { t:'Не става за <b>голяма кента</b>. Понякога си <b>принуден да жертваш</b> поле за <b>0</b>. Докосни „голяма кента", за да я зачеркнеш.', at:'low', gate:'commit', key:'largeStraight' },
    { t:'Последен ход. Хвърли.', at:'fire', gate:'roll', dice:[6,6,6,6,2] },
    { t:'Преди да запишеш — <b>надникни</b> в дъската на съперника. Докосни неговия маркер горе.', at:'pills', gate:'peek' },
    { t:'Това е неговата дъска. Затвори я и се върни.', at:null },
    { t:'<b>Каре</b> (четири еднакви) се пише в <b>„4x"</b> (24 т.). Запиши го.', at:'low', gate:'commit', key:'fourKind' },
    { t:'<b>Готово!</b> Помни: пълниш по едно поле всеки ход, а числовата част да не завърши на минус. На бой!', at:null },
  ];
  function tutAnchor(at) {
    return at === 'fire' ? $('fireWrap') : at === 'dice' ? $('dice') : at === 'pills' ? $('pillWrap')
         : at === 'fireQ' ? $('fireQ') : at === 'up' ? $('boardUpper') : at === 'low' ? $('boardLower') : null;
  }
  // the bubble lives in its OWN fixed overlay layer in a STATIC spot — just above the
  // footer, in the gap below the combination cells (it may cover the points total; fine).
  // It never displaces in-game items; the related item is highlighted with the spotlight ring.
  function tutPlaceStatic() {
    var b = $('tutBubble'), bb = $('bottombar');
    b.style.transform = 'none'; b.style.top = 'auto'; b.style.left = '10px'; b.style.right = '10px'; b.style.maxWidth = 'none';
    b.style.bottom = ((bb ? bb.offsetHeight : 0) + 12) + 'px';
  }
  function tutClearSpot() { var e = document.querySelector('.tut-spot'); while (e) { e.classList.remove('tut-spot'); e = document.querySelector('.tut-spot'); } }
  function tutShow() {
    if (!tut) return;
    var st = tut.steps[tut.i];
    if (!st) { tutEnd(); return; }
    if (st.dice) tut.dice = st.dice.slice();
    tutClearSpot();
    var anchor = tutAnchor(st.at);
    if (anchor) anchor.classList.add('tut-spot');
    var last = tut.i === tut.steps.length - 1;
    var text = (tut.edits[tut.i] != null) ? tut.edits[tut.i] : st.t;   // keep any in-place wording edits
    var foot = st.gate ? '<span class="tb-hint">' + (TUT_HINT[st.gate] || '') + '</span>'
                       : '<button class="tb-next" id="tutNextBtn">' + (last ? 'Завърши' : 'Напред →') + '</button>';
    $('tutBubble').innerHTML = '<div class="tb-text" contenteditable="true" spellcheck="false">' + text + '</div>'
      + '<div class="tb-foot"><span class="tb-step">' + (tut.i + 1) + ' / ' + tut.steps.length + '</span>'
      + '<span class="tb-actions"><button type="button" class="tb-copy" id="tutCopyBtn" title="Копирай редактираните текстове">📋</button>'
      + '<button type="button" class="tb-skip" id="tutSkipBtn">пропусни</button>' + foot + '</span></div>';
    $('tutBubble').classList.remove('hidden');
    tutPlaceStatic();
    var txt = $('tutBubble').querySelector('.tb-text');
    txt.oninput = function () { tut.edits[tut.i] = txt.innerHTML; };   // capture wording tweaks live
    var nb = $('tutNextBtn'); if (nb) nb.onclick = tutAdvance;
    $('tutCopyBtn').onclick = tutCopyTexts;
    $('tutSkipBtn').onclick = tutEnd;
  }
  // dev convenience: copy ALL step texts (with edits applied) as a JSON array to paste back
  function tutCopyTexts() {
    if (!tut) return;
    var arr = tut.steps.map(function (st, i) { return (tut.edits[i] != null) ? tut.edits[i] : st.t; });
    var out = '// TUT_' + (tut.ruleset === 'experimental' ? 'EXP' : 'STD') + ' — текстове\n' + JSON.stringify(arr, null, 2);
    try { if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(out); } catch (e) {}
    var b = $('tutBubble');
    b.innerHTML = '<div class="tb-text">Копирано в клипборда. Или избери и копирай оттук:</div>'
      + '<textarea class="tb-copybox" readonly></textarea>'
      + '<div class="tb-foot"><span class="tb-step"></span><button type="button" class="tb-next" id="tutCopyBack">Назад</button></div>';
    var ta = b.querySelector('.tb-copybox'); ta.value = out; try { ta.focus(); ta.select(); } catch (e) {}
    $('tutCopyBack').onclick = tutShow;
  }
  function tutAdvance() { if (!tut) return; tut.i++; tutShow(); }
  function tutGate(name) { var st = tut && tut.steps[tut.i]; return !!(st && st.gate === name); }
  function tutCommitOk(key) { var st = tut.steps[tut.i]; return !!(st && st.gate === 'commit' && (!st.key || st.key === key)); }
  function tutEvent(ev) {
    if (!tut) return;
    var st = tut.steps[tut.i]; if (!st || !st.gate) return;
    var ok = st.gate === ev || (st.gate === 'reroll' && ev === 'rerollAll');   // any reroll satisfies a generic reroll step
    if (ok) tutAdvance();
  }
  function tutNudge() { var b = $('tutBubble'); b.classList.remove('nudge'); void b.offsetWidth; b.classList.add('nudge'); }
  function tutReroll() {
    var st = tut.steps[tut.i];
    if (!st || (st.gate !== 'reroll' && st.gate !== 'rerollAll')) return;
    var rr = rerollMask();
    if (!rr.some(Boolean)) return;
    var all = rr.every(Boolean);
    if (st.gate === 'rerollAll' && !all) { tutNudge(); return; }
    dice = (tut.dice || dice).slice(); sortDice();
    diceNew = [false, false, false, false, false]; diceGen = [];
    if (curLog) { curLog.keeps.push(rr.map(function (x) { return !x; })); curLog.rolls.push(dice.slice()); }
    selected = [false, false, false, false, false];
    throwsLeft--;
    (gExp() ? expRenderAll : renderAll)(); shakeDice();
    tutEvent(all ? 'rerollAll' : 'reroll');
  }
  function tutStart() {
    var exp = settings.ruleset === 'experimental';
    $('settingsModal').classList.add('hidden');
    clearResume(); viewingHistory = false; netMode = false;   // game.manual is set by startGame below
    var me = G.createPlayer('Ти', settings.ownerColor || '#d4a02e', false);
    me.owner = true; me.gender = settings.ownerGender || 'm'; me.selectKeep = !!settings.selectKeep;
    me.ribbons = RIBBON_COLORS.slice().sort(function () { return Math.random() - 0.5; }).slice(0, 6);
    var opp = G.createPlayer('Новобранец', '#cf4f2e', true);
    opp.gender = 'm'; opp.ribbons = RIBBON_COLORS.slice(0, 6); opp.persona = G.PERSONAS ? G.PERSONAS[0] : null;
    var CATS = exp ? G.CATEGORIES_EXP : G.CATEGORIES, OPP = exp ? TUT_OPP_EXP : TUT_OPP_STD;
    CATS.forEach(function (c) { opp.scores[c.key] = (OPP[c.key] != null ? OPP[c.key] : 0); });
    tut = { ruleset: settings.ruleset, steps: exp ? TUT_EXP : TUT_STD, i: 0, dice: null, edits: {} };
    startGame([me, opp], false);   // routes to expStartGame when the ruleset is experimental
    tutShow();
  }
  window.addEventListener('resize', function () { if (tut) tutPlaceStatic(); });
  function tutEnd() {
    tut = null;
    $('tutBubble').classList.add('hidden'); tutClearSpot();
    $('peekModal').classList.add('hidden');
    clearResume();
    $('game').classList.add('hidden'); $('overModal').classList.add('hidden'); $('setup').classList.remove('hidden');
  }
  function confirmDeleteGame(row, id) {
    if (row.querySelector('.hg-confirm')) return;
    var c = document.createElement('div'); c.className = 'hg-confirm';
    c.innerHTML = '<span>Изтрий тази битка?</span><button class="hgc-no">Не</button><button class="hgc-yes">🔥 Да</button>';
    c.onclick = function (e) { e.stopPropagation(); };
    c.querySelector('.hgc-yes').onclick = function (e) { e.stopPropagation(); deleteGame(id); };
    c.querySelector('.hgc-no').onclick = function (e) { e.stopPropagation(); c.remove(); row.classList.remove('menu-open'); };
    row.appendChild(c);
  }
  function deleteGame(id) {
    persistHistory(loadHistory().filter(function (r) { return r.id !== id; }));
    renderHistory();
  }
  // toggle a game out of (back into) the career summary via its ranking marker
  function toggleExcludeGame(id) {
    var arr = loadHistory(), r = arr.filter(function (x) { return x.id === id; })[0];
    if (!r) return;
    r.excluded = !r.excluded;
    persistHistory(arr);
    renderHistory();
  }
