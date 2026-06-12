/*
 * General (Генерал) — core game logic.
 *
 * DOM-free and dependency-free so every rule, the suggestion engine, the AI and
 * the name generators can be unit tested under Node (`node --test`).
 *
 * Loaded by the browser (index.html, as `window.General`) and by the test suite
 * (`require('./game.js')`) via the UMD wrapper below.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.General = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Fixed/bonus point values, gathered so scoring can be tuned in one place.
  var SCORING = {
    smallStraight: 15, // 1+2+3+4+5
    largeStraight: 20, // 2+3+4+5+6
    generalBonus: 50,  // added on top of the dice total for a general
  };

  // The scoreboard, in display order.
  var CATEGORIES = [
    { key: 'ones',          label: '1',           group: 'upper' },
    { key: 'twos',          label: '2',           group: 'upper' },
    { key: 'threes',        label: '3',           group: 'upper' },
    { key: 'fours',         label: '4',           group: 'upper' },
    { key: 'fives',         label: '5',           group: 'upper' },
    { key: 'sixes',         label: '6',           group: 'upper' },
    { key: 'twoKind',       label: '2x',          group: 'lower' },
    { key: 'threeKind',     label: '3x',          group: 'lower' },
    { key: 'fourKind',      label: '4x',          group: 'lower' },
    { key: 'fullHouse',     label: 'фул хаус',     group: 'lower' },
    { key: 'smallStraight', label: 'малка кента',  group: 'lower' },
    { key: 'largeStraight', label: 'голяма кента', group: 'lower' },
    { key: 'general',       label: 'генерал',      group: 'lower' },
    { key: 'chance',        label: 'шанс',         group: 'lower' },
  ];

  // Premium combinations — the ones worth roasting a player for gambling away.
  var PREMIUM = ['general', 'largeStraight', 'smallStraight', 'fullHouse', 'fourKind'];

  var FACE = { ones: 1, twos: 2, threes: 3, fours: 4, fives: 5, sixes: 6 };

  var DICE_COUNT = 5;
  var MAX_ROLLS = 3;

  // ----------------------------------------------------------------- helpers

  function counts(dice) {
    var c = [0, 0, 0, 0, 0, 0, 0];
    for (var i = 0; i < dice.length; i++) c[dice[i]]++;
    return c;
  }

  function sum(dice) {
    var t = 0;
    for (var i = 0; i < dice.length; i++) t += dice[i];
    return t;
  }

  function sumOfFace(dice, face) {
    var t = 0;
    for (var i = 0; i < dice.length; i++) if (dice[i] === face) t += face;
    return t;
  }

  // Faces (high to low) that appear at least n times.
  function facesWithCount(dice, n) {
    var c = counts(dice);
    var out = [];
    for (var f = 6; f >= 1; f--) if (c[f] >= n) out.push(f);
    return out;
  }

  // Strict full house: a triple of one face + a pair of another.
  function isFullHouse(dice) {
    var nz = counts(dice).filter(function (x) { return x > 0; })
                         .sort(function (a, b) { return a - b; });
    return nz.length === 2 && nz[0] === 2 && nz[1] === 3;
  }

  function sortedEquals(dice, target) {
    if (dice.length !== target.length) return false;
    var s = dice.slice().sort();
    for (var i = 0; i < s.length; i++) if (s[i] !== target[i]) return false;
    return true;
  }

  function isSmallStraight(dice) { return sortedEquals(dice, [1, 2, 3, 4, 5]); }
  function isLargeStraight(dice) { return sortedEquals(dice, [2, 3, 4, 5, 6]); }
  function isGeneral(dice) { return counts(dice).some(function (c) { return c === DICE_COUNT; }); }

  // ----------------------------------------------------------------- scoring

  // All candidate scores for a category given a dice roll, high to low.
  // A category may offer several entries (e.g. 2x with two different pairs).
  // When nothing qualifies the only candidate is 0 (it can be sacrificed).
  function candidates(category, dice) {
    if (FACE[category]) return [sumOfFace(dice, FACE[category])];

    var faces, total = sum(dice);
    switch (category) {
      case 'twoKind':
        faces = facesWithCount(dice, 2);
        return faces.length ? faces.map(function (f) { return 2 * f; }) : [0];
      case 'threeKind':
        faces = facesWithCount(dice, 3);
        return faces.length ? faces.map(function (f) { return 3 * f; }) : [0];
      case 'fourKind':
        faces = facesWithCount(dice, 4);
        return faces.length ? faces.map(function (f) { return 4 * f; }) : [0];
      case 'fullHouse':
        return isFullHouse(dice) ? [total] : [0];
      case 'smallStraight':
        return isSmallStraight(dice) ? [SCORING.smallStraight] : [0];
      case 'largeStraight':
        return isLargeStraight(dice) ? [SCORING.largeStraight] : [0];
      case 'general':
        return isGeneral(dice) ? [SCORING.generalBonus + total] : [0];
      case 'chance':
        return [total];
      default:
        throw new Error('Unknown category: ' + category);
    }
  }

  // The best (highest) score a category can take for this roll.
  function scoreFor(category, dice) {
    return Math.max.apply(null, candidates(category, dice));
  }

  // ----------------------------------------------------------------- dice

  function rollDie(rng) { return 1 + Math.floor((rng || Math.random)() * 6); }

  function rollAll(rng) {
    var out = [];
    for (var i = 0; i < DICE_COUNT; i++) out.push(rollDie(rng));
    return out;
  }

  function reroll(dice, holds, rng) {
    return dice.map(function (d, i) { return holds[i] ? d : rollDie(rng); });
  }

  // ----------------------------------------------------------------- players

  function createPlayer(name, color, isAI) {
    return { name: name, color: color, isAI: !!isAI, scores: {} };
  }

  function isCategoryFilled(player, category) {
    return typeof player.scores[category] === 'number';
  }

  function isBoardComplete(player) {
    return CATEGORIES.every(function (c) { return isCategoryFilled(player, c.key); });
  }

  function playerTotal(player) {
    return CATEGORIES.reduce(function (t, c) {
      var v = player.scores[c.key];
      return t + (typeof v === 'number' ? v : 0);
    }, 0);
  }

  // Lock in a category. `value` is optional; when omitted the best candidate is
  // used. A provided value must be one of the legal candidates for the roll.
  function assignScore(player, category, dice, value) {
    if (isCategoryFilled(player, category)) {
      throw new Error('Category already filled: ' + category);
    }
    var cands = candidates(category, dice);
    var v = (value === undefined || value === null) ? Math.max.apply(null, cands) : value;
    if (cands.indexOf(v) === -1) {
      throw new Error('Illegal score ' + v + ' for ' + category);
    }
    player.scores[category] = v;
    return v;
  }

  // Forfeit (scratch) a category for 0 points. Always legal for any unfilled
  // category, including one that could currently score — a deliberate sacrifice.
  function forfeitScore(player, category) {
    if (isCategoryFilled(player, category)) {
      throw new Error('Category already filled: ' + category);
    }
    player.scores[category] = 0;
    return 0;
  }

  // ----------------------------------------------------------------- game

  function createGame(players) { return { players: players, current: 0, round: 1 }; }
  function currentPlayer(game) { return game.players[game.current]; }

  function nextTurn(game) {
    game.current = (game.current + 1) % game.players.length;
    if (game.current === 0) game.round += 1;
    return game;
  }

  function isGameOver(game) { return game.players.every(isBoardComplete); }

  function ranking(game) {
    return game.players
      .map(function (p, i) { return { player: p, total: playerTotal(p), order: i }; })
      .sort(function (a, b) { return b.total - a.total || a.order - b.order; });
  }

  // ----------------------------------------------------------------- AI

  // Greedy holds: keep the largest matching group (going for x-of-a-kind /
  // general); with no pair at all, keep the high dice (5s and 6s).
  function aiChooseHolds(dice) {
    var c = counts(dice), best = 0, bestFace = 0;
    for (var f = 6; f >= 1; f--) if (c[f] > best) { best = c[f]; bestFace = f; }
    if (best >= 2) return dice.map(function (d) { return d === bestFace; });
    return dice.map(function (d) { return d >= 5; });
  }

  // Order in which the AI sacrifices a category when nothing scores.
  var SACRIFICE_ORDER = [
    'general', 'largeStraight', 'smallStraight', 'fourKind', 'fullHouse',
    'threeKind', 'twoKind', 'ones', 'twos', 'threes', 'fours', 'fives', 'sixes', 'chance',
  ];
  // Tie-break when several categories score the same: lock the rarer combo.
  var SCORE_PRIORITY = [
    'general', 'largeStraight', 'smallStraight', 'fullHouse', 'fourKind',
    'threeKind', 'twoKind', 'sixes', 'fives', 'fours', 'threes', 'twos', 'ones', 'chance',
  ];

  // Pick the category (and value) the AI will record for this roll.
  function aiChooseCategory(player, dice) {
    var open = CATEGORIES.filter(function (c) { return !isCategoryFilled(player, c.key); });
    var scored = open.map(function (c) {
      return { key: c.key, value: scoreFor(c.key, dice) };
    });
    var max = scored.reduce(function (m, s) { return Math.max(m, s.value); }, 0);

    if (max <= 0) {
      for (var i = 0; i < SACRIFICE_ORDER.length; i++) {
        var k = SACRIFICE_ORDER[i];
        if (open.some(function (c) { return c.key === k; })) {
          return { category: k, value: 0 };
        }
      }
    }
    var best = scored
      .filter(function (s) { return s.value === max; })
      .sort(function (a, b) { return SCORE_PRIORITY.indexOf(a.key) - SCORE_PRIORITY.indexOf(b.key); })[0];
    return { category: best.key, value: best.value };
  }

  // ----------------------------------------------------------- hit probabilities

  // For m re-rolled dice (0..5): every resulting sorted face-multiset with its
  // probability. Precomputed once so the recursion below is cheap.
  var REROLL_DIST = (function () {
    var dist = [];
    for (var m = 0; m <= DICE_COUNT; m++) {
      if (m === 0) { dist.push([{ faces: [], prob: 1 }]); continue; }
      var acc = {};
      (function rec(i, arr) {
        if (i === m) {
          var key = arr.slice().sort(function (a, b) { return a - b; }).join('');
          acc[key] = (acc[key] || 0) + 1;
          return;
        }
        for (var f = 1; f <= 6; f++) { arr.push(f); rec(i + 1, arr); arr.pop(); }
      })(0, []);
      var total = Math.pow(6, m), list = [];
      for (var key in acc) {
        list.push({ faces: key.split('').map(Number), prob: acc[key] / total });
      }
      dist.push(list);
    }
    return dist;
  })();

  function repeat(v, n) { var a = []; for (var i = 0; i < n; i++) a.push(v); return a; }

  // The dice a sensible player keeps when chasing `category`.
  function keepToward(category, dice) {
    var c = counts(dice), f;
    if (FACE[category]) {
      var face = FACE[category];
      return dice.filter(function (d) { return d === face; });
    }
    switch (category) {
      case 'chance':
        return dice.slice();
      case 'twoKind': case 'threeKind': case 'fourKind': case 'general': {
        var bestFace = 0, best = 0;
        for (f = 6; f >= 1; f--) if (c[f] > best) { best = c[f]; bestFace = f; }
        if (best >= 2) return dice.filter(function (d) { return d === bestFace; });
        return [Math.max.apply(null, dice)]; // all distinct: keep the highest
      }
      case 'fullHouse': {
        var order = [6, 5, 4, 3, 2, 1].sort(function (a, b) { return c[b] - c[a] || b - a; });
        return repeat(order[0], Math.min(3, c[order[0]]))
          .concat(repeat(order[1], Math.min(2, c[order[1]])));
      }
      case 'smallStraight': return keepStraight(dice, [1, 2, 3, 4, 5]);
      case 'largeStraight': return keepStraight(dice, [2, 3, 4, 5, 6]);
      default: return [];
    }
  }
  function keepStraight(dice, need) {
    var keep = [], seen = {};
    dice.forEach(function (d) {
      if (need.indexOf(d) > -1 && !seen[d]) { seen[d] = true; keep.push(d); }
    });
    return keep;
  }

  // Probability of eventually scoring `category` (> 0), starting from `dice`
  // with `rerolls` re-rolls left, keeping the dice that help the category.
  // Exact under that keep strategy (a sensible play, not provably optimal).
  function hitProbability(category, dice, rerolls, memo) {
    memo = memo || {};
    if (scoreFor(category, dice) > 0) return 1;
    if (rerolls <= 0) return 0;
    var key = dice.slice().sort().join('') + '|' + rerolls;
    if (memo[key] != null) return memo[key];
    var keep = keepToward(category, dice);
    var dist = REROLL_DIST[DICE_COUNT - keep.length];
    var p = 0;
    for (var i = 0; i < dist.length; i++) {
      p += dist[i].prob * hitProbability(category, keep.concat(dist[i].faces), rerolls - 1, memo);
    }
    memo[key] = p;
    return p;
  }

  // Probability from scratch (no dice yet) with the full allotment of rolls.
  function hitProbabilityFresh(category) {
    var dist = REROLL_DIST[DICE_COUNT], memo = {}, p = 0;
    for (var i = 0; i < dist.length; i++) {
      p += dist[i].prob * hitProbability(category, dist[i].faces, MAX_ROLLS - 1, memo);
    }
    return p;
  }

  // Probability of IMPROVING this category's current score, by keeping the dice
  // that help it and re-rolling some of the others over `rerolls` throws. This
  // is the number shown to the player: it answers "is it worth re-rolling for
  // this?", not "do I already have it". Notes:
  //   - already having a combo is NOT 100% — e.g. with one 2, this is the chance
  //     of rolling another 2 (a higher score), not certainty.
  //   - a made fixed-value combo (a straight, a five-of-a-kind) can't be bettered
  //     by re-rolling, so it reads 0.
  //   - it never re-rolls ALL the dice toward a fresh start; it keeps what helps.
  //   - `chance` is the guaranteed catch-all, so it always reads 1.
  function improveProbability(category, dice, rerolls) {
    if (category === 'chance') return 1;
    return probAbove(category, dice, rerolls, scoreFor(category, dice), {});
  }
  function probAbove(category, dice, rerolls, threshold, memo) {
    if (scoreFor(category, dice) > threshold) return 1; // already bettered — lock it in
    if (rerolls <= 0) return 0;
    var keep = keepToward(category, dice);
    if (keep.length >= DICE_COUNT) return 0; // nothing to re-roll toward improvement
    var key = dice.slice().sort().join('') + '|' + rerolls;
    if (memo[key] != null) return memo[key];
    var dist = REROLL_DIST[DICE_COUNT - keep.length];
    var p = 0;
    for (var i = 0; i < dist.length; i++) {
      p += dist[i].prob * probAbove(category, keep.concat(dist[i].faces), rerolls - 1, threshold, memo);
    }
    memo[key] = p;
    return p;
  }

  // ----------------------------------------------------------- risk & roasts

  // Best score available across a player's unfilled categories for these dice.
  function bestOpenScore(player, dice) {
    return CATEGORIES.reduce(function (m, c) {
      return isCategoryFilled(player, c.key) ? m : Math.max(m, scoreFor(c.key, dice));
    }, 0);
  }

  // Premium combos the player has MADE but is about to gamble away: made on the
  // full dice, but not preserved by the dice they're holding.
  function atRiskPremium(player, dice, holds) {
    var held = dice.filter(function (d, i) { return holds[i]; });
    return PREMIUM
      .filter(function (k) { return !isCategoryFilled(player, k); })
      .filter(function (k) { return scoreFor(k, dice) > 0 && scoreFor(k, held) === 0; })
      .map(function (k) {
        var cat = CATEGORIES.filter(function (c) { return c.key === k; })[0];
        return { key: k, label: cat.label, score: scoreFor(k, dice) };
      })
      .sort(function (a, b) { return b.score - a.score; });
  }

  // ------------------------------------------------- Bulgarian agreement engine
  //
  // Generated phrases (player names, roasts) must be grammatically coherent:
  // adjectives and possessives agree with the GENDER of the noun they modify.
  // Genders: 'm' (мъжки), 'f' (женски), 'n' (среден).

  function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  // Inflect a regular Bulgarian adjective for a gender. Our curated adjectives
  // follow the regular pattern (masc base + 'а' for f, + 'о' for n). Adjectives
  // flagged `inv` (indeclinable foreign prefixes like "електро") never change.
  // Inflect an adjective for a gender. Regular adjectives are a masculine base
  // (f = +а, n = +о). Irregular ones (fleeting vowel) carry explicit m/f/n forms;
  // indeclinable ones carry `inv`.
  function inflectAdj(adj, gender) {
    if (adj.inv) return adj.base;
    if (gender === 'f') return adj.f != null ? adj.f : adj.base + 'а';
    if (gender === 'n') return adj.n != null ? adj.n : adj.base + 'о';
    return adj.m != null ? adj.m : adj.base; // masculine
  }

  // Possessive "your" (2nd person singular), agreeing with gender.
  // `subject` form is used when the noun is the grammatical subject (твоят…),
  // the object/short form otherwise (твоя…).
  function possessive(gender, subject) {
    if (gender === 'f') return 'твоята';
    if (gender === 'n') return 'твоето';
    return subject ? 'твоят' : 'твоя'; // masculine: full vs short article
  }

  // Spoken grammar for each premium combo, so roasts can agree with it.
  var COMBO_GRAMMAR = {
    general:       { g: 'm', phrase: 'генерал' },
    fullHouse:     { g: 'm', phrase: 'фул хаус' },
    fourKind:      { g: 'n', phrase: 'каре' },
    smallStraight: { g: 'f', phrase: 'малка кента' },
    largeStraight: { g: 'f', phrase: 'голяма кента' },
  };

  // Roast templates. Tokens, filled by renderRoast for the staked combo:
  //   {c}  — the combo phrase (генерал / малка кента / каре)
  //   {ps} — possessive, subject form (твоят / твоята / твоето)
  //   {po} — possessive, object form  (твоя  / твоята / твоето)
  var ROASTS = {
    // shown the moment a player gambles a made combo away
    risk: [
      'Изглежда не цениш особено {po} {c}.',
      'Жертваш {po} {c}? Колко смело.',
      'Обичаш да губиш, а?',
      'Хвърляш {po} {c} на вятъра. Браво.',
      'Късметът бил с глупавите, разправят.',
      'Голям кураж. Заровете вече се хилят.',
      'Дързостта да мислиш, че заровете са на твоя страна.',
    ],
    // the brutal ones, shown when the gamble made things worse
    fail: [
      '{ps} {c} си стегна багажа и замина.',
      'Сбогом на {po} {c}. Дано си е струвало.',
      'Превърна злато в чакъл. Впечатляващо.',
      'Заровете говориха и са дълбоко разочаровани от теб.',
      '{ps} {c} вече е само спомен.',
      'Имаше го. Наистина го имаше. Сега нямаш нищо.',
      'Някъде един статистик тихо заплака.',
      'Смело. Катастрофално. Култово.',
      'Изпусна {po} {c}. Снимай този момент за поколенията.',
    ],
  };

  // Brutal, comic-book roasts shown when a turn ends in disappointment. Standalone
  // lines (no combo reference). A {word} token is gender-inflected for the player
  // (masculine as written, +а for feminine) so callouts agree with the player.
  ROASTS.flop = [
    'Майка ти съжалява, че те е родила.',
    'Това беше позор за целия род.',
    'Дори заровете ти се присмиват.',
    'Баба ти хвърля по-добре. И тя е покойница.',
    'Засрами се и си върни пагоните.',
    'Виждал съм по-сполучливи хвърляния на гробище.',
    'Щабът единодушно поиска да те разжалват.',
    'Късметът те погледна веднъж и си тръгна.',
    'Това хвърляне е обида към армията.',
    'Генералът въздъхна и се обърна на другата страна.',
    'Заровете те предадоха. Като всички останали.',
    'Дано поне в живота си по-{костелив} от това.',
    '{Роден} си за поражения, личи си.',
  ];

  // Fill a roast's {adj} tokens for the player's gender (m as written, f = +а,
  // n = +о).
  function genderFill(template, gender) {
    return template.replace(/\{([^}]+)\}/g, function (_, w) {
      if (gender === 'f') return w + 'а';
      if (gender === 'n') return w + 'о';
      return w;
    });
  }
  function randomGender(rng) { return (rng || Math.random)() < 0.5 ? 'm' : 'f'; }

  // Short rule reminders per category (shown in the shaming combo tooltip).
  var COMBO_DESC = {
    ones:   '1 — сборът от всички зарове със страна 1.',
    twos:   '2 — сборът от всички зарове със страна 2.',
    threes: '3 — сборът от всички зарове със страна 3.',
    fours:  '4 — сборът от всички зарове със страна 4.',
    fives:  '5 — сборът от всички зарове със страна 5.',
    sixes:  '6 — сборът от всички зарове със страна 6.',
    twoKind:   '2x — нужни са поне два еднакви зара; точки = сборът на двата.',
    threeKind: '3x — нужни са поне три еднакви; точки = сборът на трите.',
    fourKind:  '4x — нужни са поне четири еднакви; точки = сборът на четирите.',
    fullHouse: 'фул хаус — три еднакви + два еднакви (различни); точки = сборът на всички зарове.',
    smallStraight: 'малка кента — точно 1-2-3-4-5; фиксирани 15 точки.',
    largeStraight: 'голяма кента — точно 2-3-4-5-6; фиксирани 20 точки.',
    general: 'генерал — пет еднакви зара; 50 + сборът (между 55 и 80).',
    chance:  'шанс — сборът от всичките пет зара, каквото и да се падне.',
  };

  // Shaming intros for the combo reminder tooltip.
  var SHAME_LINES = [
    'Пак забрави, а? Гинкобилобата е в шкафа.',
    'Сериозно? Това го учат в казармата първия ден.',
    'Виж го ти — забрави устава.',
    'Маразъм ли те хвана? Чети внимателно.',
    'Ето ти подсказка, новобранец.',
    'Главата ти само за каска ли става?',
    'Стига си се правил на ударен. Запомни го.',
    'Дъртофелнико, пак ли не помниш?',
  ];

  // Was a commit genuinely disappointing (worth a roast)? Either the player
  // ended up with (next to) nothing, or they re-rolled everything and still
  // scraped together almost no points.
  function isDisappointing(value, rerolledAll) {
    if (value <= 3) return true;            // ended up with nothing
    if (rerolledAll && value < 15) return true; // gambled the lot for scraps
    return false;
  }

  // Spoken name for each category, fitting "...да хвърлиш {X}" (go roll {X}).
  var ORDER_NAMES = {
    ones: 'единици', twos: 'двойки', threes: 'тройки', fours: 'четворки',
    fives: 'петици', sixes: 'шестици',
    twoKind: 'чифт', threeKind: 'три еднакви', fourKind: 'каре',
    fullHouse: 'фул хаус', smallStraight: 'малка кента', largeStraight: 'голяма кента',
    general: 'генерал', chance: 'шанс',
  };

  // The general's marching order shown at the start of a turn.
  function orderText(addressee, categoryKey) {
    return addressee + ', генералът ти заповядва да хвърлиш ' + (ORDER_NAMES[categoryKey] || '...') + '!';
  }

  // Fill a roast template's grammar tokens for the given (premium) combo.
  function renderRoast(template, comboKey) {
    var gr = COMBO_GRAMMAR[comboKey] || { g: 'm', phrase: 'комбинация' };
    return capitalize(template
      .replace('{ps}', possessive(gr.g, true))
      .replace('{po}', possessive(gr.g, false))
      .replace('{c}', gr.phrase));
  }

  // ----------------------------------------------------------------- names & bets

  // Titles span every Bulgarian age — modern army ranks, medieval/imperial
  // dignities and the revival-era resistance (hajduks, komiti, opълченци). All
  // genderless (used verbatim before the name). SFW.
  // `b` (optional) pins a hardcoded rarity bracket; unbracketed entries are '10+'
  // (common). These initial brackets are ARBITRARY — meant to be fine-tuned by
  // hand via the dev panel (rarer dignities/titles seeded as the scarcer ones).
  var TITLES = [
    // modern military ranks (the everyday common ones)
    'Генерал', 'Майор', 'Полковник', 'Капитан', 'Адмирал', 'Сержант', 'Ефрейтор', 'Лейтенант',
    'Старшина', 'Подполковник', 'Поручик', 'Подпоручик', 'Прапорщик', 'Гвардеец', 'Командир', 'Знаменосец',
    // First/Second Bulgarian Empire dignities (seeded rarer)
    'Цар', 'Княз', { m: 'Хан', b: '4-5' }, { m: 'Кан', b: '3-4' }, 'Боляр', { m: 'Кавхан', b: '0-1' },
    { m: 'Багатур', b: '1-2' }, { m: 'Таркан', b: '2-3' }, 'Деспот', { m: 'Севастократор', b: '1-2' }, { m: 'Протостратор', b: '2-3' },
    // revival-era resistance / liberation
    'Войвода', 'Хайдутин', { m: 'Байрактар', b: '5-10' }, { m: 'Комита', b: '4-5' }, 'Четник', { m: 'Апостол', b: '0-1' },
    { m: 'Опълченец', b: '3-4' }, 'Партизанин', 'Юнак',
  ];

  // Adjectives. Strings inflect regularly (masc base; f = +а, n = +о). Objects
  // with explicit f/n are irregular (fleeting vowel); `inv` = indeclinable.
  var ADJS = [
    'смотан', 'сополив', 'космат', 'тлъст', 'тромав', 'кьорав', 'проклет', 'опърпан',
    'дебел', 'рунтав', 'скапан', 'луд', 'крив', 'вмирисан', 'вкиснал', 'мек', 'подлудял',
    { base: 'чевръст', b: '1-2' }, 'смазан', { base: 'гръмнал', b: '2-3' }, 'направен', 'лош', 'пиян', 'дрислив', 'парцалив',
    'оплескан', { base: 'прецакан', b: '4-5' }, 'проскубан', 'опикан', 'оакан', { base: 'недодялан', b: '3-4' }, 'сбъркан',
    'вонящ', 'изтормозен', 'олигавен', { base: 'оплешивял', b: '5-10' }, 'занемарен',
    { base: 'срамен', f: 'срамна', n: 'срамно', b: '0-1' },
    { base: 'добър', f: 'добра', n: 'добро' },
    { base: 'гаден', f: 'гадна', n: 'гадно' },
    { base: 'мазен', f: 'мазна', n: 'мазно', b: '2-3' },
    { base: 'гнусен', f: 'гнусна', n: 'гнусно' },
    { base: 'грозен', f: 'грозна', n: 'грозно', b: '1-2' },
  ];
  var AI_ADJS = [
    { base: 'ръждив' }, { base: 'цинков' }, { base: 'хромиран' }, { base: 'искрящ' },
    { base: 'продупчен' }, { base: 'стоманен' }, { base: 'наелектризиран' }, { base: 'заваден' },
    { base: 'изгорял' }, { base: 'претоварен' }, { base: 'пренавит' }, { base: 'окъсян' },
    { base: 'електро', inv: true }, { base: 'турбо', inv: true }, { base: 'кибер', inv: true },
    { base: 'нано', inv: true }, { base: 'мега', inv: true }, { base: 'демоде', inv: true },
  ];

  // Nouns carry their grammatical gender (display form, capitalized). New ones
  // appended at the end (keeps the first m/f stable). Gendered name generation
  // picks a noun matching the player's gender, so the whole name agrees.
  // `gv` (optional) holds sibling-gender surface forms of the SAME entry, so a
  // player switching gender keeps the entry (and its rarity) and just morphs the
  // word instead of re-rolling. `nsfw` flags adult-only entries (censorable).
  var NOUNS = [
    { w: 'Пишка', g: 'f' }, { w: 'Петел', g: 'm', gv: { f: 'Кокошка', n: 'Пиле' }, b: '2-3' }, { w: 'Краставица', g: 'f' },
    { w: 'Тиква', g: 'f' }, { w: 'Мотика', g: 'f' }, { w: 'Чорап', g: 'm' },
    { w: 'Баклава', g: 'f' }, { w: 'Магаре', g: 'n', gv: { m: 'Катър', f: 'Магарица' }, b: '3-4' }, { w: 'Кашкавал', g: 'm' },
    { w: 'Лопата', g: 'f' }, { w: 'Бухал', g: 'm', gv: { f: 'Кукумявка', n: 'Совище' }, b: '4-5' }, { w: 'Геврек', g: 'm' },
    { w: 'Таралеж', g: 'm' }, { w: 'Дюшек', g: 'm' },
    { w: 'Метла', g: 'f' }, { w: 'Патка', g: 'f' },
    { w: 'Маймуна', g: 'f', gv: { m: 'Маймун', n: 'Маймунче' }, b: '1-2' }, { w: 'Кранта', g: 'f' }, { w: 'Пън', g: 'm' }, { w: 'Чук', g: 'm' },
    // crude additions (adult party game) — flagged NSFW so they can be censored
    { w: 'Жребец', g: 'm', nsfw: true }, { w: 'Хуй', g: 'm', nsfw: true, b: '0-1' }, { w: 'Кур', g: 'm', nsfw: true }, { w: 'Изклесяк', g: 'm', nsfw: true },
    { w: 'Пийняк', g: 'm', nsfw: true }, { w: 'Брънзел', g: 'm', nsfw: true }, { w: 'Гъз', g: 'm', nsfw: true }, { w: 'Пръч', g: 'm', nsfw: true },
    { w: 'Дръвник', g: 'm', nsfw: true }, { w: 'Тъпак', g: 'm', gv: { f: 'Тъпачка', n: 'Тъпаче' }, nsfw: true }, { w: 'Льохман', g: 'm', nsfw: true }, { w: 'Серсем', g: 'm', nsfw: true },
    { w: 'Простак', g: 'm', gv: { f: 'Простачка' }, nsfw: true }, { w: 'Балък', g: 'm', nsfw: true }, { w: 'Дебелак', g: 'm', gv: { f: 'Дебелана', n: 'Дебеланче' }, nsfw: true },
    { w: 'Путка', g: 'f', nsfw: true }, { w: 'Буба', g: 'f', nsfw: true }, { w: 'Дуда', g: 'f', nsfw: true }, { w: 'Вулва', g: 'f', nsfw: true },
    { w: 'Вагина', g: 'f', nsfw: true }, { w: 'Цепка', g: 'f', nsfw: true }, { w: 'Курва', g: 'f', nsfw: true }, { w: 'Дроля', g: 'f', nsfw: true },
    { w: 'Гнида', g: 'f', nsfw: true }, { w: 'Въшка', g: 'f', nsfw: true }, { w: 'Крава', g: 'f', nsfw: true }, { w: 'Свиня', g: 'f', gv: { m: 'Шопар', n: 'Прасе' }, nsfw: true },
    { w: 'Циция', g: 'f', nsfw: true }, { w: 'Пачавра', g: 'f', nsfw: true },
    { w: 'Влагалище', g: 'n', nsfw: true }, { w: 'Прасе', g: 'n', nsfw: true }, { w: 'Говедо', g: 'n', nsfw: true }, { w: 'Леке', g: 'n', nsfw: true },
    { w: 'Лайно', g: 'n', nsfw: true }, { w: 'Чудовище', g: 'n' }, { w: 'Изчадие', g: 'n' }, { w: 'Добиче', g: 'n', nsfw: true },
  ];
  var AI_NOUNS = [
    { w: 'Камила', g: 'f' }, { w: 'Тенеке', g: 'n' }, { w: 'Робот', g: 'm' },
    { w: 'Чайник', g: 'm' }, { w: 'Трансформатор', g: 'm' }, { w: 'Болт', g: 'm' },
    { w: 'Тостер', g: 'm' }, { w: 'Прахосмукачка', g: 'f' }, { w: 'Ютия', g: 'f' },
    { w: 'Котлон', g: 'm' }, { w: 'Бойлер', g: 'm' }, { w: 'Динамо', g: 'n', b: '2-3' },
    { w: 'Реотан', g: 'm', b: '4-5' }, { w: 'Ключ', g: 'm' },
    { w: 'Турбина', g: 'f' }, { w: 'Платка', g: 'f' }, { w: 'Антена', g: 'f' },
    { w: 'Жица', g: 'f' }, { w: 'Батерия', g: 'f' }, { w: 'Кабел', g: 'm' }, { w: 'Винт', g: 'm' },
    { w: 'Бормашина', g: 'f' }, { w: 'Дискета', g: 'f' }, { w: 'Клавиатура', g: 'f' }, { w: 'Камера', g: 'f' },
    { w: 'Сонда', g: 'f' }, { w: 'Помпа', g: 'f' }, { w: 'Спирала', g: 'f' }, { w: 'Решетка', g: 'f' },
    { w: 'Крушка', g: 'f' }, { w: 'Гайка', g: 'f' }, { w: 'Печка', g: 'f' }, { w: 'Тенджера', g: 'f' },
    { w: 'Реле', g: 'n' }, { w: 'Табло', g: 'n' }, { w: 'Радио', g: 'n' },
  ];

  // Self-contained (already grammatical) wagers for the "Залага X" line.
  var BETS = [
    'кучето си', 'майка си', 'достойнството си', 'тъщата си', 'мустака си',
    'ракията си', 'последния си лев', 'честта си', 'колата си', 'баба си',
    'чорапите си', 'бъбрека си', 'душата си', 'брака си', 'мерцедеса си',
    'вилата на село', 'любимата си вилица', 'котката на съседа',
  ];

  function pick(arr, rng) { return arr[Math.floor((rng || Math.random)() * arr.length)]; }

  // Name = Title + Adjective (agreeing with the noun's gender) + Noun. When a
  // `gender` ('m'/'f') is given, the noun is picked to match it, so the whole
  // name agrees with the player — "Ефрейтор Смотана Пишка" (f), "Майор Смотан
  // Петел" (m).
  function randomName(adjs, nouns, rng, gender) {
    var pool = gender ? nouns.filter(function (n) { return n.g === gender; }) : nouns;
    if (!pool.length) pool = nouns;
    var noun = pick(pool, rng);
    var adj = entryAdj(pick(adjs, rng));
    return entryWord(pick(TITLES, rng)) + ' ' + capitalize(inflectAdj(adj, noun.g)) + ' ' + noun.w;
  }
  function randomHumanName(rng, gender) { return randomName(ADJS, NOUNS, rng, gender); }
  function randomAiName(rng, gender) { return randomName(AI_ADJS, AI_NOUNS, rng, gender); }
  function randomBet(rng) { return pick(BETS, rng); }

  // ----------------------------------------------------- dynamic rarity & bonuses
  //
  // Rarity is assigned DYNAMICALLY at load: each pool gets a fixed split of rare
  // tiers (down to sub-1%) sprinkled onto RANDOM entries, so which names are rare
  // changes every page load. A name's rarity = its rarest component; sub-10% earns
  // a brag bubble, sub-5% a starting bonus (5%→1 … 1%→5; sub-1% → 5).

  // extra "epic" words mixed into the pools — seeded into the rarer brackets
  var EPIC_TITLES = ['Маршал', { m: 'Воевода', b: '3-4' }, { m: 'Фелдмаршал', b: '1-2' }];
  var EPIC_ADJS = ['величав', { base: 'легендарен', f: 'легендарна', n: 'легендарно', b: '0-1' },
    { base: 'безсмъртен', f: 'безсмъртна', n: 'безсмъртно', b: '1-2' }, { base: 'митичен', f: 'митична', n: 'митично', b: '2-3' }];
  var EPIC_NOUNS = [{ w: 'Великан', g: 'm', b: '3-4' }, { w: 'Дракон', g: 'm', b: '1-2' }, { w: 'Феникс', g: 'm', b: '0-1' },
    { w: 'Кралица', g: 'f', b: '2-3' }, { w: 'Сирена', g: 'f', b: '4-5' }, { w: 'Богиня', g: 'f', b: '1-2' }, { w: 'Валкирия', g: 'f', b: '0-1' },
    { w: 'Светило', g: 'n', b: '3-4' }, { w: 'Привидение', g: 'n', b: '2-3' }, { w: 'Божество', g: 'n', b: '0-1' }];
  var EPIC_AI_ADJS = [{ base: 'квантов', b: '2-3' }, { base: 'плазмен', b: '1-2' }, { base: 'термоядрен', b: '0-1' }];
  var EPIC_AI_NOUNS = [{ w: 'Суперкомпютър', g: 'm', b: '1-2' }, { w: 'Реактор', g: 'm', b: '2-3' }, { w: 'Андроид', g: 'm', b: '3-4' },
    { w: 'Матрица', g: 'f', b: '1-2' }, { w: 'Совалка', g: 'f', b: '4-5' }, { w: 'Сингулярност', g: 'f', b: '0-1' }, { w: 'Ядро', g: 'n', b: '2-3' }];

  function entryWord(e) { return typeof e === 'string' ? e : (e.w || e.base || e.m); }
  function entryAdj(e) { return typeof e === 'string' ? { base: e } : e; }

  // A noun entry can render gender g if g is its base gender or it carries a `gv`
  // variant for g. The surface word for g is the base `w` (when g matches) or the
  // variant. This is what lets a gender switch morph the word in place.
  function nounCanRender(e, g) { return e.g === g || (e.gv && e.gv[g] != null); }
  function nounWordFor(e, g) { return e.g === g ? e.w : (e.gv && e.gv[g]) || e.w; }

  // ---- HARDCODED percentile brackets (per component, fine-tuned by hand) ----
  //
  // Each name component (title/adj/noun) sits in a FIXED rarity bracket carried
  // on the source entry as `b`. Unbracketed entries fall into '10+' (common). The
  // bracket maps to a representative probability fraction; a component is DRAWN
  // with that probability (commons share the rest), and the NAME's percentage is
  // the PRODUCT of its three components' fractions — so two rare components
  // multiply into something far rarer. Nothing is randomised per load (the only
  // randomness is the draw itself), which keeps rarities consistent across loads.
  var BRACKETS = ['0-1', '1-2', '2-3', '3-4', '4-5', '5-10', '10+'];
  var BRACKET_FRAC = { '0-1': 0.005, '1-2': 0.015, '2-3': 0.025, '3-4': 0.035, '4-5': 0.045, '5-10': 0.075 };
  // Representative probability of the '10+' (common) bracket. Kept near 1 so a
  // single rare component lands the NAME in ≈ that component's bracket, while two
  // or three rare components still multiply into something far rarer.
  var COMMON_FRAC = 0.95;
  function bracketOf(e) { var b = (e && typeof e === 'object') ? e.b : null; return (BRACKET_FRAC[b] != null || b === '10+') ? b : '10+'; }
  function fracOf(e) { var b = bracketOf(e); return b === '10+' ? COMMON_FRAC : BRACKET_FRAC[b]; }

  function buildPool(list) {
    return list.map(function (e) { var b = bracketOf(e); return { e: e, b: b, frac: fracOf(e), rare: b !== '10+' }; });
  }

  var censorNSFW = false; // when true (the menu "censor" toggle) NSFW entries are excluded
  function setCensor(on) { censorNSFW = !!on; if (awardThresh.human) computeAwardThresholds(); }
  function isCensored(e) { return censorNSFW && e && e.nsfw; }

  var titlePool, adjPool, nounPool, aiAdjPool, aiNounPool;
  function rollPools() {
    titlePool  = buildPool(TITLES.concat(EPIC_TITLES));
    adjPool    = buildPool(ADJS.concat(EPIC_ADJS));
    nounPool   = buildPool(NOUNS.concat(EPIC_NOUNS));
    aiAdjPool  = buildPool(AI_ADJS.concat(EPIC_AI_ADJS));
    aiNounPool = buildPool(AI_NOUNS.concat(EPIC_AI_NOUNS));
    computeAwardThresholds();
  }

  // Pick a pool entry honoring its bracket. `gender` (nouns only) filters to
  // entries that can render it; NSFW entries drop out while censoring. A rare
  // (bracketed) entry is drawn with probability ≈ its fraction; otherwise a
  // common one. Returns the chosen part { e, b, frac }.
  function pickFromPool(pool, gender, rng, isNoun) {
    var cand = pool.filter(function (p) {
      if (isCensored(p.e)) return false;
      return !gender || !isNoun || nounCanRender(p.e, gender);
    });
    if (!cand.length) cand = pool.filter(function (p) { return !isCensored(p.e); });
    if (!cand.length) cand = pool;
    var rare = cand.filter(function (p) { return p.rare; });
    var common = cand.filter(function (p) { return !p.rare; });
    var sum = 0; for (var i = 0; i < rare.length; i++) sum += rare[i].frac;
    var r = (rng || Math.random)();
    if (rare.length && r < sum) {
      var acc = 0; for (var j = 0; j < rare.length; j++) { acc += rare[j].frac; if (r <= acc) return rare[j]; }
    }
    var c = common.length ? common : cand;
    return c[Math.floor((rng || Math.random)() * c.length)];
  }
  // a same-bracket noun that can render `gender` — used when a gender switch
  // can't morph the current noun in place, so the player's rarity stays exact.
  function pickNounSameBracket(pool, gender, b, rng) {
    var cand = pool.filter(function (p) { return p.b === b && !isCensored(p.e) && nounCanRender(p.e, gender); });
    if (!cand.length && b !== '10+') cand = pool.filter(function (p) { return p.rare && !isCensored(p.e) && nounCanRender(p.e, gender); });
    if (!cand.length) cand = pool.filter(function (p) { return !isCensored(p.e) && nounCanRender(p.e, gender); });
    if (!cand.length) return null;
    return cand[Math.floor((rng || Math.random)() * cand.length)];
  }

  // §awards Because a name's chance is the PRODUCT of its three components, raw
  // percentages get tiny and skewed, so fixed %-brackets fire far too often. We
  // instead award by FREQUENCY RANK: at load we Monte-Carlo the distribution of
  // combined name-chances and keep the rarest-tail thresholds (1/2/3/4/5/10th
  // percentiles). A roll is awarded only if it lands in the rarest 5% of names —
  // tier 1 = rarest 1% → +5, … tier 5 = the 4–5% band → +1; the 5–10% band is a
  // smile (no points). The thresholds are recomputed whenever the pools change.
  var AWARD_PCTILES = [1, 2, 3, 4, 5, 10];
  var awardThresh = { human: null, ai: null };
  function computeAwardThresholds() {
    ['human', 'ai'].forEach(function (kind) {
      var ap = kind === 'ai' ? aiAdjPool : adjPool, np = kind === 'ai' ? aiNounPool : nounPool, M = 12000, arr = [];
      for (var i = 0; i < M; i++) {
        var g = ['m', 'f', 'n'][i % 3];
        var t = pickFromPool(titlePool, null, Math.random, false);
        var a = pickFromPool(ap, null, Math.random, false);
        var n = pickFromPool(np, g, Math.random, true);
        arr.push(t.frac * a.frac * n.frac * 100);
      }
      arr.sort(function (x, y) { return x - y; });
      awardThresh[kind] = AWARD_PCTILES.map(function (p) { return arr[Math.floor(p / 100 * M)]; });
    });
  }
  rollPools(); // build pools + award thresholds once at load

  // frequency tier of a combined name-chance: 1..5 = rarest 1..5% bands, 10 = the
  // 5–10% band (smile), 0 = common. `kind` selects the human/ai distribution.
  function rarityTier(pct, kind) {
    if (pct == null) return 0;
    var T = awardThresh[kind === 'ai' ? 'ai' : 'human'] || awardThresh.human;
    if (!T) return 0;
    for (var i = 0; i < 5; i++) if (pct <= T[i]) return i + 1;
    if (pct <= T[5]) return 10;
    return 0;
  }
  function bonusForTier(tier) { return tier >= 1 && tier <= 5 ? 6 - tier : 0; }
  // (kind-aware) starting bonus for a combined name-chance
  function bonusForPct(pct, kind) { return bonusForTier(rarityTier(pct, kind)); }

  // The combined name percentage = product of the three component fractions
  // (×100). Lower = rarer. Used for the bubble, the bonus and the notification.
  function comboPct(parts) { return parts.title.frac * parts.adj.frac * parts.noun.frac * 100; }

  // Assemble a name (+ rarity) from chosen pool parts for a given gender. The
  // adjective agrees with the gender; the noun shows its form for that gender.
  function buildFromParts(parts, gender, kind) {
    var name = entryWord(parts.title.e) + ' '
      + capitalize(inflectAdj(entryAdj(parts.adj.e), gender)) + ' '
      + nounWordFor(parts.noun.e, gender);
    var pct = comboPct(parts), tier = rarityTier(pct, kind);
    return { name: name, pct: pct, tier: tier, bonus: bonusForTier(tier), parts: parts };
  }

  // Generate a name and report its rarity + the chosen parts (so a later gender
  // switch can re-cohere it without re-rolling). { name, pct, tier, bonus, parts }.
  function randomNameRarity(kind, gender, rng) {
    var ap = kind === 'ai' ? aiAdjPool : adjPool;
    var np = kind === 'ai' ? aiNounPool : nounPool;
    var parts = {
      title: pickFromPool(titlePool, null, rng, false),
      adj: pickFromPool(ap, null, rng, false),
      noun: pickFromPool(np, gender, rng, true),
    };
    return buildFromParts(parts, gender, kind);
  }

  // §1 re-cohere a name for a new gender, morphing the noun IN PLACE (keeps the
  // exact rarity). Only valid when the noun has a form for the new gender — the
  // caller checks nounRenders() first; otherwise the UI rolls a fresh name.
  function nounRenders(parts, gender) { return !!nounCanRender(parts.noun.e, gender); }
  function recohereName(kind, parts, gender) {
    var np = kind === 'ai' ? aiNounPool : nounPool;
    var noun = parts.noun;
    if (!nounCanRender(noun.e, gender)) {
      var repl = pickNounSameBracket(np, gender, noun.b);
      if (repl) noun = repl;
    }
    return buildFromParts({ title: parts.title, adj: parts.adj, noun: noun }, gender, kind);
  }

  // Check a hand-typed "Title Adj Noun" against the human seed; if it lands an
  // existing (and rare) combo, the bonus still applies.
  // Parse a hand-typed "Title Adjective Noun" against the live seed pools. The
  // name itself encodes its gender (noun gender + adjective inflection), so we
  // try the caller's preferred gender first (to stay coherent with the toggle)
  // and otherwise auto-detect it — returning the matched gender so the UI can
  // adopt it. A match under a rare component still earns the bonus.
  function matchSeed(name, gender) {
    var words = (name || '').trim().split(/\s+/);
    if (words.length !== 3) return { matched: false, pct: null, bonus: 0 };
    var title = words[0], adjForm = words[1], noun = words[2], te = null, i;
    for (i = 0; i < titlePool.length; i++) if (entryWord(titlePool[i].e) === title && !isCensored(titlePool[i].e)) { te = titlePool[i]; break; }
    if (!te) return { matched: false, pct: null, bonus: 0 };
    var order = ['m', 'f', 'n'];
    if (gender) order = [gender].concat(order.filter(function (g) { return g !== gender; }));
    for (var gi = 0; gi < order.length; gi++) {
      var g = order[gi], ae = null, ne = null;
      // a noun matches if its surface form for gender g equals the typed word
      for (i = 0; i < nounPool.length; i++) if (!isCensored(nounPool[i].e) && nounCanRender(nounPool[i].e, g) && nounWordFor(nounPool[i].e, g) === noun) { ne = nounPool[i]; break; }
      if (!ne) continue;
      for (i = 0; i < adjPool.length; i++) if (!isCensored(adjPool[i].e) && capitalize(inflectAdj(entryAdj(adjPool[i].e), g)) === adjForm) { ae = adjPool[i]; break; }
      if (!ae) continue;
      var parts = { title: te, adj: ae, noun: ne };
      var pct = comboPct(parts), tier = rarityTier(pct, 'human');
      return { matched: true, pct: pct, tier: tier, bonus: bonusForTier(tier), gender: g, parts: parts };
    }
    return { matched: false, pct: null, bonus: 0 };
  }

  var RARITY_EXCL = { 1: 'ГОСПОДИ!', 2: 'Ебаси,', 3: 'Лееееле, майко!', 4: 'Татенце!', 5: 'ЕХЕ!' };
  // "1 на N" odds from a combined name-chance (with thousands separators)
  function odds1inN(pct) {
    var n = Math.max(1, Math.round(100 / pct));
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  }
  // The brag headline talks in FREQUENCY (1 на N · топ X%), not the tiny raw
  // chance. The award message is a SEPARATE line (rarityAward).
  function rarityLine(pct, tier) {
    if (tier == null) tier = rarityTier(pct);
    if (!tier) return '';
    var odds = '1 на ' + odds1inN(pct) + ' имена';
    if (tier === 10) return '🙂 Рядко име — ' + odds + '.';
    var excl = RARITY_EXCL[tier] || 'Брей,';
    return excl + ' ' + odds + ' — топ ' + tier + '%.';
  }
  function rarityAward(bonus) { return bonus > 0 ? 'Щабът ти отпуска +' + bonus + ' т. начален аванс!' : ''; }

  // dev-mode dump of the live pools, with each entry's hardcoded bracket.
  function dumpPools() {
    function fmt(pool) { return pool.map(function (p) { return { w: entryWord(p.e), b: p.b, frac: p.frac, g: p.e.g || null, nsfw: !!(p.e && p.e.nsfw) }; }); }
    return { titles: fmt(titlePool), adjs: fmt(adjPool), nouns: fmt(nounPool), aiAdjs: fmt(aiAdjPool), aiNouns: fmt(aiNounPool) };
  }

  // ---- dev-mode editor: normalize the SOURCE word lists to a uniform editable
  // shape { m, n, f, inv?, nsfw?, b? } and back, for fine-tuning + КОПИРАЙ export.
  function srcTitle(t) { var o = { m: entryWord(t) }; if (t && t.nsfw) o.nsfw = true; o.b = bracketOf(t); return o; }
  function srcAdj(a) { a = entryAdj(a); var o = { m: a.base || a.m }; if (a.n) o.n = a.n; if (a.f) o.f = a.f; if (a.inv) o.inv = true; if (a.nsfw) o.nsfw = true; o.b = bracketOf(a); return o; }
  function srcNoun(e) { var o = {}; o[e.g] = e.w; if (e.gv) { for (var k in e.gv) o[k] = e.gv[k]; } if (e.nsfw) o.nsfw = true; o.b = bracketOf(e); return o; }
  function dumpSource() {
    return {
      titles: TITLES.concat(EPIC_TITLES).map(srcTitle),
      adjs: ADJS.concat(EPIC_ADJS).map(srcAdj),
      nouns: NOUNS.concat(EPIC_NOUNS).map(srcNoun),
      aiAdjs: AI_ADJS.concat(EPIC_AI_ADJS).map(srcAdj),
      aiNouns: AI_NOUNS.concat(EPIC_AI_NOUNS).map(srcNoun),
    };
  }
  function withBracket(o, b) { if (b && b !== '10+' && BRACKET_FRAC[b] != null) o.b = b; return o; }
  function toTitleEntry(o) { var e = (o.nsfw || (o.b && o.b !== '10+')) ? { m: o.m } : o.m; if (typeof e === 'object') { if (o.nsfw) e.nsfw = true; withBracket(e, o.b); } return e; }
  function toAdjEntry(o) { var a = { base: o.m }; if (o.n) a.n = o.n; if (o.f) a.f = o.f; if (o.inv) a.inv = true; if (o.nsfw) a.nsfw = true; return withBracket(a, o.b); }
  function toNounEntry(o) {
    var g = o.m ? 'm' : o.f ? 'f' : 'n', e = { w: o[g], g: g }, gv = {};
    ['m', 'f', 'n'].forEach(function (x) { if (x !== g && o[x]) gv[x] = o[x]; });
    if (Object.keys(gv).length) e.gv = gv;
    if (o.nsfw) e.nsfw = true;
    return withBracket(e, o.b);
  }
  function rebuildFromSource(src) {
    function clean(arr, f) { return (arr || []).filter(function (o) { return o && (o.m || o.f || o.n); }).map(f); }
    titlePool  = buildPool(clean(src.titles, toTitleEntry));
    adjPool    = buildPool(clean(src.adjs, toAdjEntry));
    nounPool   = buildPool(clean(src.nouns, toNounEntry));
    aiAdjPool  = buildPool(clean(src.aiAdjs, toAdjEntry));
    aiNounPool = buildPool(clean(src.aiNouns, toNounEntry));
    computeAwardThresholds();
  }

  // ----------------------------------------------------- bot personas & ranks

  // Persona = PLAYSTYLE preset feeding the EV engine's bot policy (NOT the bot's
  // name — AI players keep their generated Title+Adjective+Noun name). Name→
  // strength is a FIXED binding; strengths from tools/calibrate-bots.js.
  // The five-tier ladder:
  //   Мушица   = RANDOM  — rethrows blindly 1–2 times, then banks the best it can
  //   Комар    = EASY    — no lookup; always grabs the biggest immediate score
  //   Леля ти  = MEDIUM  — epsilon-greedy over the optimal table
  //   Кварталния = HARD  — softmax over the optimal table
  //   Господ бог = GOD   — always the optimal move
  // None of them ever forfeits at random — only when nothing scores.
  var PERSONAS = [
    { id: 'mushica',  name: 'Мушица',             flavor: 'Хвърля наслуки и се надява.',     policy: { type: 'random' },                  strength: 0.25 },
    { id: 'komar',    name: 'Комар',              flavor: 'Комарджия — граби каквото е на масата.', policy: { type: 'greedy' },           strength: 0.64 },
    { id: 'lelia',    name: 'Леля ти',            flavor: 'Играе на семейни вечери.',        policy: { type: 'epsilon', epsilon: 0.2 },   strength: 0.77 },
    { id: 'lyubitel', name: 'Кварталния любител', flavor: 'Бива го, бутка кокала.',          policy: { type: 'softmax', tau: 0.8 },       strength: 0.85 },
    { id: 'gospod',   name: 'Господ бог',         flavor: 'Вижда всичко. Не прощава.',       policy: { type: 'optimal', tau: 0 },         strength: 1.0 },
  ];
  function personaById(id) {
    for (var i = 0; i < PERSONAS.length; i++) if (PERSONAS[i].id === id) return PERSONAS[i];
    return PERSONAS[2]; // sensible mid default
  }

  // Playstyle fingerprint: archetype + a distinctive colour, classified from the
  // post-game analysis (accuracy / aggression / blunder severity / luck). The
  // checks are ordered most-specific first.
  var PLAYSTYLES = {
    surgeon:  { name: 'Хирург',     color: '#e8c356', desc: 'Точен, хладнокръвен, без излишни рискове.' },
    recruit:  { name: 'Новобранец', color: '#b39ddb', desc: 'Още учи кой зар за какво е.' },
    gambler:  { name: 'Комарджия',  color: '#e05545', desc: 'Гони големите комбинации на всяка цена.' },
    clerk:    { name: 'Чиновник',   color: '#6fa8e8', desc: 'Прибира сигурното и спи спокойно.' },
    stuntman: { name: 'Каскадьор',  color: '#e8843a', desc: 'Грешките му са зрелищни.' },
    lucky:    { name: 'Късметлия',  color: '#9bd17e', desc: 'Заровете го обичат повече, отколкото заслужава.' },
    soldier:  { name: 'Боец',       color: '#cdc9a8', desc: 'Стабилен среден кадър.' },
  };
  function playstyleFor(a) {
    if (!a) return null;
    var acc = a.accuracy || 0, sev = a.severity || { minor: 0, major: 0, fatal: 0 };
    var aggr = a.aggression || 0, luck = a.luck || 0;
    if (acc >= 0.92 && sev.fatal === 0) return PLAYSTYLES.surgeon;
    if (acc < 0.55) return PLAYSTYLES.recruit;
    if (aggr >= 0.7) return PLAYSTYLES.gambler;
    if (aggr <= -0.7) return PLAYSTYLES.clerk;
    if (sev.fatal >= 2) return PLAYSTYLES.stuntman;
    if (luck >= 25 && acc < 0.85) return PLAYSTYLES.lucky;
    return PLAYSTYLES.soldier;
  }

  // Bulgarian military ladder, low → high. Top = Генерал (the game's namesake).
  var RANKS = [
    'Редник', 'Ефрейтор', 'Младши сержант', 'Сержант', 'Старши сержант', 'Старшина',
    'Младши лейтенант', 'Лейтенант', 'Старши лейтенант', 'Капитан', 'Майор',
    'Подполковник', 'Полковник', 'Бригаден генерал', 'Генерал-майор', 'Генерал-лейтенант', 'Генерал',
  ];
  // §6 placement mapping: winner → Генерал, last → Редник, spread between.
  function rankForPlacement(place, nPlayers) {
    if (nPlayers <= 1) return RANKS[RANKS.length - 1];
    var top = RANKS.length - 1;
    return RANKS[Math.round(top * (nPlayers - 1 - place) / (nPlayers - 1))];
  }
  // §6 performance mapping: decision accuracy → a rank title (solo promotions).
  function rankForAccuracy(acc) {
    var t = Math.max(0, Math.min(1, (acc - 0.6) / 0.4)); // spread the useful 60–100% band
    return RANKS[Math.round(t * (RANKS.length - 1))];
  }

  // A generator that avoids repeating names it has already handed out.
  function nameGenerator(kind) {
    var used = {};
    var make = kind === 'ai' ? randomAiName : randomHumanName;
    return function (rng, gender) {
      for (var i = 0; i < 60; i++) {
        var n = make(rng, gender);
        if (!used[n]) { used[n] = true; return n; }
      }
      return make(rng, gender);
    };
  }

  return {
    SCORING: SCORING,
    CATEGORIES: CATEGORIES,
    DICE_COUNT: DICE_COUNT,
    MAX_ROLLS: MAX_ROLLS,
    counts: counts,
    sum: sum,
    sumOfFace: sumOfFace,
    facesWithCount: facesWithCount,
    isFullHouse: isFullHouse,
    isSmallStraight: isSmallStraight,
    isLargeStraight: isLargeStraight,
    isGeneral: isGeneral,
    candidates: candidates,
    scoreFor: scoreFor,
    rollDie: rollDie,
    rollAll: rollAll,
    reroll: reroll,
    createPlayer: createPlayer,
    isCategoryFilled: isCategoryFilled,
    isBoardComplete: isBoardComplete,
    playerTotal: playerTotal,
    assignScore: assignScore,
    forfeitScore: forfeitScore,
    createGame: createGame,
    currentPlayer: currentPlayer,
    nextTurn: nextTurn,
    isGameOver: isGameOver,
    ranking: ranking,
    aiChooseHolds: aiChooseHolds,
    aiChooseCategory: aiChooseCategory,
    PREMIUM: PREMIUM,
    keepToward: keepToward,
    hitProbability: hitProbability,
    hitProbabilityFresh: hitProbabilityFresh,
    improveProbability: improveProbability,
    bestOpenScore: bestOpenScore,
    atRiskPremium: atRiskPremium,
    ROASTS: ROASTS,
    isDisappointing: isDisappointing,
    ORDER_NAMES: ORDER_NAMES,
    orderText: orderText,
    COMBO_GRAMMAR: COMBO_GRAMMAR,
    inflectAdj: inflectAdj,
    possessive: possessive,
    renderRoast: renderRoast,
    randomHumanName: randomHumanName,
    randomAiName: randomAiName,
    randomBet: randomBet,
    randomGender: randomGender,
    genderFill: genderFill,
    randomNameRarity: randomNameRarity,
    bonusForPct: bonusForPct,
    bonusForTier: bonusForTier,
    rarityLine: rarityLine,
    rarityAward: rarityAward,
    rarityTier: rarityTier,
    matchSeed: matchSeed,
    recohereName: recohereName,
    nounRenders: nounRenders,
    setCensor: setCensor,
    BRACKETS: BRACKETS,
    BETS: BETS,
    RARITY_EXCL: RARITY_EXCL,
    dumpPools: dumpPools,
    dumpSource: dumpSource,
    rebuildFromSource: rebuildFromSource,
    COMBO_DESC: COMBO_DESC,
    SHAME_LINES: SHAME_LINES,
    nameGenerator: nameGenerator,
    PERSONAS: PERSONAS,
    personaById: personaById,
    PLAYSTYLES: PLAYSTYLES,
    playstyleFor: playstyleFor,
    RANKS: RANKS,
    rankForPlacement: rankForPlacement,
    rankForAccuracy: rankForAccuracy,
  };
});
