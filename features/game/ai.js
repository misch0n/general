'use strict';
// Bots, speech bubbles, and the combo-reminder tooltip.
  // ---------- AI ----------
  // engine-backed persona policy when the EV table is ready; else heuristic.
  function aiKeepMask(p) {
    if (evReady && p.persona) {
      var keep = EV.botKeep(p.scores, dice, throwsLeft, p.persona.policy, Math.random);
      return keep; // boolean[5], true = keep
    }
    return G.aiChooseHolds(dice); // heuristic fallback (true = keep)
  }
  function aiCategory(p) {
    if (evReady && p.persona) {
      var key = EV.botCategory(p.scores, dice, p.persona.policy, Math.random);
      return { category: key, value: G.scoreFor(key, dice) };
    }
    return G.aiChooseCategory(p, dice);
  }
  function runAiTurn() { aiBusy = true; renderFire(); setTimeout(aiStep, AI_DELAY); }
  function aiStep() {
    var p = G.currentPlayer(game);
    if (throwsLeft > 0) {
      var holds = aiKeepMask(p);                    // true = keep this die
      // mark the dice the same way a human would under the active setting (keep vs throw)
      selected = activeKeep() ? holds.slice() : holds.map(function (h) { return !h; });
      var rr = rerollMask();
      if (rr.some(Boolean)) {
        renderDice();
        setTimeout(function () {
          var kept = rr.map(function (x) { return !x; });
          applyReroll(rr);
          if (curLog) { curLog.keeps.push(kept); curLog.rolls.push(dice.slice()); }
          selected = [false,false,false,false,false]; throwsLeft--;
          renderAll(); shakeDice();
          netSendAct();   // clients watch the AI seat's reroll
          setTimeout(throwsLeft > 0 ? aiStep : aiFinish, AI_DELAY);
        }, AI_DELAY * 0.65);
        return;
      }
    }
    setTimeout(aiFinish, AI_DELAY);
  }
  function aiFinish() {
    var p = G.currentPlayer(game);
    var choice = aiCategory(p);
    aiBusy = false;
    if (choice.value > 0) G.assignScore(p, choice.category, dice, choice.value);
    else G.forfeitScore(p, choice.category);
    afterCommit(choice.category, choice.value);
  }

  // ---------- speech bubbles ----------
  var ROAST_MS = 2600, ORDER_MS = 4000;

  // the general's order at turn start: aim for a still-open category
  function showOrder(player) {
    if (!fun()) return;                            // callouts off outside казарма mode
    // the general's wager is rare — and ramps up over the last 1-3 rounds
    var left = G.CATEGORIES.length - game.round;   // rounds remaining (0 on the final one)
    var chance = left >= 3 ? 0.06 : left === 2 ? 0.22 : left === 1 ? 0.38 : 0.55;
    if (Math.random() >= chance) return;
    var open = G.CATEGORIES.filter(function (c) { return !G.isCategoryFilled(player, c.key); });
    if (!open.length) return;
    var cat = open[Math.floor(Math.random() * open.length)];
    var addressee = player.name.trim().split(/\s+/)[0]; // their military title
    var box = $('roast');
    box.className = 'roast show order';
    box.innerHTML = '<span class="bubble">🎖 ' + esc(G.orderText(addressee, cat.key)) + '</span>';
    box.querySelector('.bubble').onclick = clearRoast; // tap to dismiss
    clearTimeout(roastTimer);
    roastTimer = setTimeout(clearRoast, ORDER_MS);
  }

  function showRoast(key, value) {
    if (!fun()) return false;                      // roasts off outside казарма mode
    // combo-dependent floor shame (names the combo + the rock-bottom value)
    var line = G.floorShame(key, value, G.currentPlayer(game).gender);
    // fill any extra metadata placeholders a dev added (%name%, %turn%, %total%, …)
    line = fillTemplate(line, gameVarCtx({ combo: G.ORDER_NAMES[key] || 'комбинация', val: value, catval: value, catmax: catMaxFor(key) }));
    var box = $('roast');
    box.className = 'roast show';
    box.innerHTML = '<span class="bubble">' + esc(line) + '</span>';
    box.querySelector('.bubble').onclick = clearRoast; // tap to dismiss
    clearTimeout(roastTimer);
    roastTimer = setTimeout(clearRoast, ROAST_MS);
    return true;
  }
  function clearRoast() { var b = $('roast'); b.className = 'roast'; b.innerHTML = ''; clearTimeout(roastTimer); }

  // ---------- combo reminder tooltip + a random (non-permanent) penalty ----------
  var shameIx = 0, TIP_MS = 5000, PEN_EXTRA = 3000;
  function shuffled(arr) { arr = arr.slice(); for (var i = arr.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = arr[i]; arr[i] = arr[j]; arr[j] = t; } return arr; }
  function catLabel(key) { var c = G.CATEGORIES.filter(function (x) { return x.key === key; })[0]; return c ? c.label : key; }

  // Several penalties can be live at once; each expires on its OWN timer (relative
  // to when it was triggered) and only ever targets something not already taken.
  var penalties = [], tipHideTimer = null, refundTimer = null;

  function comboReminder(key, anchor) {
    if (locked || !fun()) return;
    // measure the anchor BEFORE the penalty re-renders the board (which would
    // detach it and zero its rect, dumping the tooltip in the top-left corner)
    var r = anchor.getBoundingClientRect();
    var pen = applyPenalty(key);                 // pick + register a fresh penalty
    var shame = G.SHAME_LINES[shameIx % G.SHAME_LINES.length]; shameIx++;
    var tip = $('comboTip');
    tip.innerHTML = '<div class="shame">' + esc(shame) + '</div>'
      + '<div class="cdesc">' + esc(G.COMBO_DESC[key] || '') + '</div>'
      + '<div class="cfine">⚠ ' + esc(pen.desc) + '</div>';   // in-game: reveal the penalty
    tip.classList.remove('hidden');
    tip.style.left = Math.min(Math.max(8, r.left + r.width / 2 - tip.offsetWidth / 2), window.innerWidth - tip.offsetWidth - 8) + 'px';
    tip.style.top = (r.bottom + 8) + 'px';
    // a newer reminder replaces this tooltip; the penalty itself stays on its own clock
    clearTimeout(tipHideTimer);
    tipHideTimer = setTimeout(function () { tip.classList.add('hidden'); }, TIP_MS);
  }
  // any bubble can be tapped away (no lingering screen obstruction)
  $('comboTip').onclick = function () { $('comboTip').classList.add('hidden'); clearTimeout(tipHideTimer); };
  $('fxBubble').onclick = function () { $('fxBubble').classList.add('hidden'); clearTimeout(refundTimer); };

  // where on screen a penalty lives — used to float its expiry bubble there
  function penAnchor(pen) {
    if (pen.type === 'points') return $('curTotal');
    if (pen.type === 'changeDice' || pen.type === 'removeDice') return $('dice');
    if (pen.type === 'pretend') return $('curName');
    if (pen.key) {                                 // combo penalties → the tile itself
      var cat = CAT_BY_KEY[pen.key];
      var host = cat.group === 'upper' ? $('boardUpper') : $('boardLower');
      var keys = boardKeys(cat.group).filter(function (k) { return (fx.hide || []).indexOf(k) < 0; });
      var i = keys.indexOf(pen.key);
      if (i >= 0 && host.children[i]) return host.children[i];
    }
    return $('dockHead');                            // shuffle / youlose → the board middle
  }
  var guideTimer = null;
  function showGuide(anchor, text) {
    var g = $('guideTip'); g.textContent = text; g.classList.remove('hidden');
    var r = anchor.getBoundingClientRect();
    g.style.left = Math.min(Math.max(8, r.left + r.width / 2 - g.offsetWidth / 2), window.innerWidth - g.offsetWidth - 8) + 'px';
    var above = r.top - g.offsetHeight - 6;
    g.style.top = (above >= 8 ? above : r.bottom + 6) + 'px';
    clearTimeout(guideTimer);
    guideTimer = setTimeout(function () { g.classList.add('hidden'); }, 1900);
  }
  function showFxBubble(text, anchor) {
    var b = $('fxBubble');
    b.textContent = text;
    b.classList.remove('hidden');
    var r = (anchor || $('dockHead')).getBoundingClientRect();
    b.style.left = Math.min(Math.max(8, r.left + r.width / 2 - b.offsetWidth / 2), window.innerWidth - b.offsetWidth - 8) + 'px';
    var above = r.top - b.offsetHeight - 8;        // prefer above the target, flip below if cramped
    b.style.top = (above >= 8 ? above : r.bottom + 8) + 'px';
    clearTimeout(refundTimer);
    refundTimer = setTimeout(function () { b.classList.add('hidden'); }, 2600);
  }

  function applyPenalty(reqKey) {
    var p = G.currentPlayer(game);
    // tally what the already-live penalties have claimed, so we never double-target
    var usedHide = {}, usedBlank = {}, usedForfeit = {}, usedIdx = {}, removed = 0, hasPretend = false, hasLose = false;
    penalties.forEach(function (q) {
      if (q.type === 'hideReq' || q.type === 'hideRand') usedHide[q.key] = 1;
      else if (q.type === 'blank') usedBlank[q.key] = 1;
      else if (q.type === 'forfeit') usedForfeit[q.key] = 1;
      else if (q.type === 'changeDice') usedIdx[q.index] = 1;
      else if (q.type === 'removeDice') removed += q.n;
      else if (q.type === 'pretend') hasPretend = true;
      else if (q.type === 'youlose') hasLose = true;
    });
    var allKeys = G.CATEGORIES.map(function (c) { return c.key; });
    var openK = allKeys.filter(function (k) { return !G.isCategoryFilled(p, k) && !usedForfeit[k]; });
    var filledK = allKeys.filter(function (k) { return G.isCategoryFilled(p, k) && !usedBlank[k]; });
    var hideK = allKeys.filter(function (k) { return !usedHide[k]; });
    var remaining = G.DICE_COUNT - removed;
    var diceMode = !manualMode && dice.length === G.DICE_COUNT && !awaitingRoll;
    var freeIdx = []; for (var i = 0; i < remaining; i++) if (!usedIdx[i]) freeIdx.push(i);

    // the full prank set (penalties only fire in казарма mode, gated upstream).
    // A points fine and a temporary zero-out are non-intrusive (no lock); the rest
    // freeze play until they expire.
    var pool = ['points'];                              // a fine always stacks
    if (filledK.length) pool.push('blank');
    if (!usedHide[reqKey]) pool.push('hideReq');
    if (hideK.length) pool.push('hideRand');
    if (openK.length) pool.push('forfeit');
    pool.push('shuffle');
    if (!hasPretend) pool.push('pretend');
    if (!hasLose) pool.push('youlose');
    if (diceMode && remaining > 0) pool.push('removeDice');
    if (diceMode && freeIdx.length) pool.push('changeDice');

    var t = pool[Math.floor(Math.random() * pool.length)];
    var pen = { type: t };
    if (t === 'points') { pen.points = Math.random() < 0.18 ? 9999999 : 3 + Math.floor(Math.random() * 45); pen.desc = 'Глоба: −' + pen.points + ' точки!'; }
    else if (t === 'hideReq') { pen.key = reqKey; pen.desc = 'Скрих ти полето „' + catLabel(reqKey) + '“.'; }
    else if (t === 'hideRand') { pen.key = hideK[Math.floor(Math.random() * hideK.length)]; pen.desc = 'Скрих ти полето „' + catLabel(pen.key) + '“.'; }
    else if (t === 'blank') { pen.key = filledK[Math.floor(Math.random() * filledK.length)]; pen.desc = 'Нулирах ти временно „' + catLabel(pen.key) + '“ (−' + (p.scores[pen.key] || 0) + ' т.).'; }
    else if (t === 'forfeit') { pen.key = openK[Math.floor(Math.random() * openK.length)]; pen.desc = 'Жертвам ти „' + catLabel(pen.key) + '“.'; }
    else if (t === 'shuffle') { pen.order = { upper: shuffled(boardKeys('upper')), lower: shuffled(boardKeys('lower')) }; pen.desc = 'Разбърках ти таблото.'; }
    else if (t === 'changeDice') { pen.index = freeIdx[Math.floor(Math.random() * freeIdx.length)]; pen.face = 1 + Math.floor(Math.random() * 6); pen.desc = 'Смених ти един зар.'; }
    else if (t === 'removeDice') { pen.n = 1; pen.desc = 'Взех ти един зар.'; }
    else if (t === 'pretend') { pen.desc = 'Сега играе другарят до теб.'; }
    else { pen.desc = 'Обявявам те за загубил!'; }   // youlose

    penalties.push(pen);
    pen.timer = setTimeout(function () { expirePenalty(pen); }, TIP_MS + PEN_EXTRA);
    syncPenalties();
    return pen;
  }

  function expirePenalty(pen) {
    var i = penalties.indexOf(pen); if (i < 0) return;
    penalties.splice(i, 1);
    syncPenalties();
    // the "just kidding" bubble floats next to the area the penalty hit
    showFxBubble('Ебавам се, ей ти ги пак.', penAnchor(pen));
  }

  function clearAllPenalties() {           // hard reset (e.g. on restart)
    penalties.forEach(function (q) { clearTimeout(q.timer); });
    penalties = [];
    fx = {};
    $('youLose').classList.add('hidden');
    $('comboTip').classList.add('hidden');
    $('fxBubble').classList.add('hidden');
  }

  function rebuildFx() {                    // fold the live penalties into one override
    var f = {}, hide = [], blank = [], forfeit = [], points = 0, removed = 0, order = null, faces = [], pretend = false, lose = false;
    penalties.forEach(function (q) {
      if (q.type === 'points') points += q.points;
      else if (q.type === 'hideReq' || q.type === 'hideRand') hide.push(q.key);
      else if (q.type === 'blank') blank.push(q.key);
      else if (q.type === 'forfeit') forfeit.push(q.key);
      else if (q.type === 'shuffle') order = q.order;
      else if (q.type === 'removeDice') removed += q.n;
      else if (q.type === 'changeDice') faces.push(q);
      else if (q.type === 'pretend') pretend = true;
      else if (q.type === 'youlose') lose = true;
    });
    // only INTRUSIVE penalties freeze play; a fine or a temporary zero-out don't
    if (penalties.some(function (q) { return q.type !== 'points' && q.type !== 'blank'; })) f.lock = true;
    if (points) f.points = points;
    if (hide.length) f.hide = hide;
    if (blank.length) f.blank = blank;
    if (forfeit.length) f.forfeit = forfeit;
    if (order) f.order = order;
    if (pretend) f.pretendNext = true;
    if (lose) f.youlose = true;
    if (faces.length || removed > 0) {
      var shown = dice.slice();
      faces.forEach(function (q) { if (q.index < shown.length) shown[q.index] = q.face; });
      if (faces.length) f.dice = shown;
      if (removed > 0) f.diceKeep = Math.max(0, G.DICE_COUNT - removed);
    }
    fx = f;
  }
  function syncPenalties() {
    rebuildFx();
    $('youLose').classList.toggle('hidden', !fx.youlose);
    renderAll();
  }

