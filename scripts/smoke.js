'use strict';
// App-level file:// smoke: the game-loop has no unit tests, so this drives a real headless
// browser over file:// and asserts ZERO pageerror across both rulesets in BOTH modes
// (dice + manual/ОТЧЕТ). Run after every change: `node scripts/smoke.js`.
const puppeteer = require('puppeteer');
const path = require('path');

(async () => {
  const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => {
    // resource-load failures over file:// (analytics count.js, PeerJS CDN) are expected, not bugs
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console.error: ' + m.text());
  });
  const url = 'file://' + path.join(process.cwd(), 'index.html');

  async function play(ruleset, manual) {
    const before = errors.length;
    await page.goto(url, { waitUntil: 'load' });
    await page.evaluate((rs) => { settings.ruleset = rs; }, ruleset);
    // a solo human game: deterministic, no AI timers to fight
    await page.evaluate((manual) => {
      var me = G.createPlayer('Тест', '#d4a02e', false);
      startGame([me], manual);
    }, manual);
    // play every category to reach the end-game summary
    const reached = await page.evaluate(async (manual) => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const exp = gExp();
      const cats = exp ? G.CATEGORIES_EXP : G.CATEGORIES;
      const scoreFn = exp ? G.scoreForExp : G.scoreFor;
      const roll = exp ? expFirstRoll : firstRoll;
      const commit = exp ? expCommit : commitScore;
      let didReroll = false;   // exercise the reroll path (selected/diceNew/diceGen/applyReroll) once per game
      // one commit per turn: after a commit `locked` stays true until endTurn→beginTurn re-arms,
      // so wait for readiness each step instead of a fixed delay.
      for (let n = 0; n < cats.length * 3; n++) {
        const p = G.currentPlayer(game);
        const cat = cats.find(c => !G.isCategoryFilled(p, c.key));
        if (!cat) break;
        // wait until the turn is interactive again (not locked, hand entered/rolled)
        for (let w = 0; w < 40 && game.turn.locked; w++) await sleep(50);
        if (manual) { while (game.turn.dice.length < G.DICE_COUNT) tapManualDie(1); }   // tap the 5-die hand in
        else {
          if (game.turn.awaitingRoll) roll();
          if (!didReroll && game.turn.throwsLeft > 0) {   // mark one die and re-throw the rest
            game.turn.selected = [true, false, false, false, false];
            humanFire(); didReroll = true;
          }
        }
        commit(cat.key, scoreFn(cat.key, game.turn.dice));
        await sleep(60);
      }
      // the final commit hands off to endTurn on a timer (END_DELAY, longer if a roast fires)
      for (let w = 0; w < 60 && $('overModal').classList.contains('hidden'); w++) await sleep(100);
      return !$('overModal').classList.contains('hidden');   // summary visible?
    }, manual);
    const tag = ruleset + '/' + (manual ? 'manual' : 'dice');
    const newErrs = errors.slice(before);
    if (newErrs.length) { console.error('FAIL ' + tag + '\n  ' + newErrs.join('\n  ')); return false; }
    console.log('ok   ' + tag + (reached ? ' (reached summary)' : ' (no summary — check)'));
    return true;
  }

  // resume round-trip: play a few turns, reload, and continue from the resume snapshot — this is the
  // real coverage for the unified serialize/deserialize (saveResume → loadResume → resume(Exp)Game).
  async function resumeRoundTrip(ruleset) {
    const before = errors.length;
    await page.goto(url, { waitUntil: 'load' });
    await page.evaluate((rs) => { settings.ruleset = rs; }, ruleset);
    await page.evaluate(() => { startGame([G.createPlayer('Тест', '#d4a02e', false)], false); });
    // play 3 turns so the snapshot carries scores + (standard) moveLog
    await page.evaluate(async () => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const exp = gExp(), cats = exp ? G.CATEGORIES_EXP : G.CATEGORIES;
      const scoreFn = exp ? G.scoreForExp : G.scoreFor, roll = exp ? expFirstRoll : firstRoll, commit = exp ? expCommit : commitScore;
      for (let n = 0; n < 3; n++) {
        const p = G.currentPlayer(game), cat = cats.find(c => !G.isCategoryFilled(p, c.key));
        for (let w = 0; w < 40 && game.turn.locked; w++) await sleep(50);
        if (game.turn.awaitingRoll) roll();
        commit(cat.key, scoreFn(cat.key, game.turn.dice)); await sleep(60);
      }
    });
    // reload (drops all in-memory state) then rebuild from the persisted snapshot
    await page.goto(url, { waitUntil: 'load' });
    const resumed = await page.evaluate(() => {
      const snap = loadResume(); if (!snap) return { ok: false };
      resumeGame(snap);
      return { ok: !!(game && game.players && game.turn), filled: Object.keys(game.players[0].scores).length };
    });
    const tag = ruleset + '/resume';
    const newErrs = errors.slice(before);
    if (newErrs.length) { console.error('FAIL ' + tag + '\n  ' + newErrs.join('\n  ')); return false; }
    // saveResume snapshots at each turn START (before that turn's commit), so a 3-commit game
    // persists ≥2 filled cells — enough to prove scores + players round-tripped through the schema.
    if (!resumed.ok || resumed.filled < 2) { console.error('FAIL ' + tag + ' — snapshot not restored (' + JSON.stringify(resumed) + ')'); return false; }
    console.log('ok   ' + tag + ' (restored ' + resumed.filled + ' cells)');
    return true;
  }

  // replay round-trip: play a standard game to the end, then open its archived record in the
  // replay viewer and step through every action. This is the real coverage for slice 5c — the
  // viewer reconstructs each board via the shared reducer (rpStateAt → GReduce APPLY_SCORE), a
  // path no unit test drives end-to-end. Asserts no pageerror AND that the final reconstructed
  // board matches the record's own scores.
  async function replayRoundTrip() {
    const before = errors.length;
    await page.goto(url, { waitUntil: 'load' });
    await page.evaluate(() => { settings.ruleset = 'standard'; startGame([G.createPlayer('Тест', '#d4a02e', false)], false); });
    await page.evaluate(async () => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      for (let n = 0; n < G.CATEGORIES.length * 2; n++) {
        const p = G.currentPlayer(game), cat = G.CATEGORIES.find(c => !G.isCategoryFilled(p, c.key));
        if (!cat) break;
        for (let w = 0; w < 40 && game.turn.locked; w++) await sleep(50);
        if (game.turn.awaitingRoll) firstRoll();
        commitScore(cat.key, G.scoreFor(cat.key, game.turn.dice)); await sleep(60);
      }
      for (let w = 0; w < 60 && $('overModal').classList.contains('hidden'); w++) await sleep(100);
    });
    const res = await page.evaluate(() => {
      const recs = loadHistory(); if (!recs.length) return { ok: false, why: 'no archived game' };
      openReplay(recs[recs.length - 1]); rpPause();        // open the latest game, stop the auto-play timer
      if (!replay || !replay.actions.length) return { ok: false, why: 'replay did not open' };
      for (let i = 0; i < replay.actions.length; i++) { replay.idx = i; renderReplay(); }   // step every frame (drives rpStateAt)
      // the final reconstructed board must equal the record's stored scores
      const grid = rpStateAt(replay.actions.length - 1);
      const want = replay.rec.players.map(p => p.scores);
      let match = true;
      for (let s = 0; s < want.length; s++) for (const k in want[s]) if (grid[s][k] !== want[s][k]) match = false;
      return { ok: match, frames: replay.actions.length };
    });
    const newErrs = errors.slice(before);
    if (newErrs.length) { console.error('FAIL standard/replay\n  ' + newErrs.join('\n  ')); return false; }
    if (!res.ok) { console.error('FAIL standard/replay — ' + (res.why || 'reconstructed board mismatch')); return false; }
    console.log('ok   standard/replay (stepped ' + res.frames + ' frames, board matches)');
    return true;
  }

  let ok = true;
  for (const rs of ['standard', 'experimental'])
    for (const manual of [false, true])
      ok = (await play(rs, manual)) && ok;
  for (const rs of ['standard', 'experimental'])
    ok = (await resumeRoundTrip(rs)) && ok;
  ok = (await replayRoundTrip()) && ok;

  await browser.close();
  if (!ok) { console.error('SMOKE FAILED'); process.exit(1); }
  console.log('SMOKE PASS');
})().catch(e => { console.error(e); process.exit(1); });
