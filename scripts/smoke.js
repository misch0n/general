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
      // one commit per turn: after a commit `locked` stays true until endTurn→beginTurn re-arms,
      // so wait for readiness each step instead of a fixed delay.
      for (let n = 0; n < cats.length * 3; n++) {
        const p = G.currentPlayer(game);
        const cat = cats.find(c => !G.isCategoryFilled(p, c.key));
        if (!cat) break;
        // wait until the turn is interactive again (not locked, hand entered/rolled)
        for (let w = 0; w < 40 && locked; w++) await sleep(50);
        if (manual) { while (dice.length < G.DICE_COUNT) tapManualDie(1); }   // tap the 5-die hand in
        else if (awaitingRoll) roll();
        commit(cat.key, scoreFn(cat.key, dice));
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

  let ok = true;
  for (const rs of ['standard', 'experimental'])
    for (const manual of [false, true])
      ok = (await play(rs, manual)) && ok;

  await browser.close();
  if (!ok) { console.error('SMOKE FAILED'); process.exit(1); }
  console.log('SMOKE PASS');
})().catch(e => { console.error(e); process.exit(1); });
