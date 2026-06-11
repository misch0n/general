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

  var TITLES = ['Генерал', 'Майор', 'Полковник', 'Капитан', 'Адмирал', 'Сержант', 'Ефрейтор', 'Лейтенант'];

  // Adjectives. Strings inflect regularly (masc base; f = +а, n = +о). Objects
  // with explicit f/n are irregular (fleeting vowel); `inv` = indeclinable.
  var ADJS = [
    'смотан', 'сополив', 'космат', 'тлъст', 'тромав', 'кьорав', 'проклет', 'опърпан',
    'дебел', 'рунтав', 'скапан', 'луд', 'крив', 'вмирисан', 'вкиснал', 'мек', 'подлудял',
    'чевръст', 'смазан', 'гръмнал', 'направен', 'лош', 'пиян', 'дрислив', 'парцалив',
    'оплескан', 'прецакан', 'проскубан', 'опикан', 'оакан', 'недодялан', 'сбъркан',
    'вонящ', 'изтормозен', 'олигавен', 'оплешивял', 'занемарен',
    { base: 'срамен', f: 'срамна', n: 'срамно' },
    { base: 'добър', f: 'добра', n: 'добро' },
    { base: 'гаден', f: 'гадна', n: 'гадно' },
    { base: 'мазен', f: 'мазна', n: 'мазно' },
    { base: 'гнусен', f: 'гнусна', n: 'гнусно' },
    { base: 'грозен', f: 'грозна', n: 'грозно' },
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
  var NOUNS = [
    { w: 'Пишка', g: 'f' }, { w: 'Петел', g: 'm' }, { w: 'Краставица', g: 'f' },
    { w: 'Тиква', g: 'f' }, { w: 'Мотика', g: 'f' }, { w: 'Чорап', g: 'm' },
    { w: 'Баклава', g: 'f' }, { w: 'Магаре', g: 'n' }, { w: 'Кашкавал', g: 'm' },
    { w: 'Лопата', g: 'f' }, { w: 'Бухал', g: 'm' }, { w: 'Геврек', g: 'm' },
    { w: 'Таралеж', g: 'm' }, { w: 'Дюшек', g: 'm' },
    { w: 'Метла', g: 'f' }, { w: 'Кокошка', g: 'f' }, { w: 'Патка', g: 'f' },
    { w: 'Маймуна', g: 'f' }, { w: 'Кранта', g: 'f' }, { w: 'Пън', g: 'm' }, { w: 'Чук', g: 'm' },
    // crude additions (adult party game)
    { w: 'Жребец', g: 'm' }, { w: 'Хуй', g: 'm' }, { w: 'Кур', g: 'm' }, { w: 'Изклесяк', g: 'm' },
    { w: 'Пийняк', g: 'm' }, { w: 'Брънзел', g: 'm' }, { w: 'Гъз', g: 'm' }, { w: 'Пръч', g: 'm' },
    { w: 'Дръвник', g: 'm' }, { w: 'Тъпак', g: 'm' }, { w: 'Льохман', g: 'm' }, { w: 'Серсем', g: 'm' },
    { w: 'Простак', g: 'm' }, { w: 'Балък', g: 'm' }, { w: 'Дебелак', g: 'm' },
    { w: 'Путка', g: 'f' }, { w: 'Буба', g: 'f' }, { w: 'Дуда', g: 'f' }, { w: 'Вулва', g: 'f' },
    { w: 'Вагина', g: 'f' }, { w: 'Цепка', g: 'f' }, { w: 'Курва', g: 'f' }, { w: 'Дроля', g: 'f' },
    { w: 'Гнида', g: 'f' }, { w: 'Въшка', g: 'f' }, { w: 'Крава', g: 'f' }, { w: 'Свиня', g: 'f' },
    { w: 'Циция', g: 'f' }, { w: 'Пачавра', g: 'f' }, { w: 'Тъпачка', g: 'f' },
    { w: 'Влагалище', g: 'n' }, { w: 'Прасе', g: 'n' }, { w: 'Говедо', g: 'n' }, { w: 'Леке', g: 'n' },
    { w: 'Лайно', g: 'n' }, { w: 'Чудовище', g: 'n' }, { w: 'Изчадие', g: 'n' }, { w: 'Добиче', g: 'n' },
  ];
  var AI_NOUNS = [
    { w: 'Камила', g: 'f' }, { w: 'Тенеке', g: 'n' }, { w: 'Робот', g: 'm' },
    { w: 'Чайник', g: 'm' }, { w: 'Трансформатор', g: 'm' }, { w: 'Болт', g: 'm' },
    { w: 'Тостер', g: 'm' }, { w: 'Прахосмукачка', g: 'f' }, { w: 'Ютия', g: 'f' },
    { w: 'Котлон', g: 'm' }, { w: 'Бойлер', g: 'm' }, { w: 'Динамо', g: 'n' },
    { w: 'Реотан', g: 'm' }, { w: 'Ключ', g: 'm' },
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
    var raw = pick(adjs, rng);
    var adj = typeof raw === 'string' ? { base: raw } : raw;
    return pick(TITLES, rng) + ' ' + capitalize(inflectAdj(adj, noun.g)) + ' ' + noun.w;
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

  // extra "epic" words mixed into the pools as ordinary candidates
  var EPIC_TITLES = ['Маршал', 'Воевода', 'Хан', 'Фелдмаршал'];
  var EPIC_ADJS = ['величав', { base: 'легендарен', f: 'легендарна', n: 'легендарно' },
    { base: 'безсмъртен', f: 'безсмъртна', n: 'безсмъртно' }, { base: 'митичен', f: 'митична', n: 'митично' }];
  var EPIC_NOUNS = [{ w: 'Великан', g: 'm' }, { w: 'Дракон', g: 'm' }, { w: 'Феникс', g: 'm' },
    { w: 'Кралица', g: 'f' }, { w: 'Сирена', g: 'f' }, { w: 'Богиня', g: 'f' }, { w: 'Валкирия', g: 'f' },
    { w: 'Светило', g: 'n' }, { w: 'Привидение', g: 'n' }, { w: 'Божество', g: 'n' }];
  var EPIC_AI_ADJS = [{ base: 'квантов' }, { base: 'плазмен' }, { base: 'термоядрен' }];
  var EPIC_AI_NOUNS = [{ w: 'Суперкомпютър', g: 'm' }, { w: 'Реактор', g: 'm' }, { w: 'Андроид', g: 'm' },
    { w: 'Матрица', g: 'f' }, { w: 'Совалка', g: 'f' }, { w: 'Сингулярност', g: 'f' }, { w: 'Ядро', g: 'n' }];

  var RARE_TIERS = [0.5, 1, 2, 4, 7]; // rarity split sprinkled onto each pool (per gender for nouns)

  function entryWord(e) { return typeof e === 'string' ? e : (e.w || e.base); }
  function entryAdj(e) { return typeof e === 'string' ? { base: e } : e; }
  function shuffleInPlace(a) { for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; } return a; }

  function buildPool(list) {
    var pool = list.map(function (e) { return { e: e, pct: null }; });
    var idx = shuffleInPlace(pool.map(function (_, i) { return i; }));
    for (var k = 0; k < RARE_TIERS.length && k < pool.length; k++) pool[idx[k]].pct = RARE_TIERS[k];
    return pool;
  }
  function buildNounPool(list) {
    var pool = list.map(function (e) { return { e: e, pct: null }; });
    ['m', 'f', 'n'].forEach(function (g) {
      var idx = shuffleInPlace(pool.map(function (_, i) { return i; }).filter(function (i) { return pool[i].e.g === g; }));
      for (var k = 0; k < RARE_TIERS.length && k < idx.length; k++) pool[idx[k]].pct = RARE_TIERS[k];
    });
    return pool;
  }

  var titlePool, adjPool, nounPool, aiAdjPool, aiNounPool;
  function rollPools() {
    titlePool  = buildPool(TITLES.concat(EPIC_TITLES));
    adjPool    = buildPool(ADJS.concat(EPIC_ADJS));
    nounPool   = buildNounPool(NOUNS.concat(EPIC_NOUNS));
    aiAdjPool  = buildPool(AI_ADJS.concat(EPIC_AI_ADJS));
    aiNounPool = buildNounPool(AI_NOUNS.concat(EPIC_AI_NOUNS));
  }
  rollPools(); // assign rarity once, per page load

  function pickFromPool(pool, gender, rng) {
    var cand = gender ? pool.filter(function (p) { return p.e.g === gender; }) : pool;
    if (!cand.length) cand = pool;
    var rare = cand.filter(function (p) { return p.pct != null; });
    var common = cand.filter(function (p) { return p.pct == null; });
    var sum = 0; for (var i = 0; i < rare.length; i++) sum += rare[i].pct;
    var r = (rng || Math.random)() * 100;
    if (rare.length && r < sum) {
      var acc = 0; for (var j = 0; j < rare.length; j++) { acc += rare[j].pct; if (r <= acc) return { e: rare[j].e, pct: rare[j].pct }; }
    }
    var c = common.length ? common : cand;
    return { e: c[Math.floor((rng || Math.random)() * c.length)].e, pct: null };
  }

  function bonusForPct(pct) {
    if (pct == null) return 0;
    if (pct <= 1) return 5; if (pct <= 2) return 4; if (pct <= 3) return 3;
    if (pct <= 4) return 2; if (pct <= 5) return 1;
    return 0;
  }

  // Generate a name and report its rarity. { name, pct, bonus } (pct null = common).
  function randomNameRarity(kind, gender, rng) {
    var ap = kind === 'ai' ? aiAdjPool : adjPool;
    var np = kind === 'ai' ? aiNounPool : nounPool;
    var t = pickFromPool(titlePool, null, rng);
    var a = pickFromPool(ap, null, rng);
    var n = pickFromPool(np, gender, rng);
    var name = entryWord(t.e) + ' ' + capitalize(inflectAdj(entryAdj(a.e), n.e.g)) + ' ' + n.e.w;
    var pcts = [t.pct, a.pct, n.pct].filter(function (p) { return p != null; });
    var pct = pcts.length ? Math.min.apply(null, pcts) : null;
    return { name: name, pct: pct, bonus: bonusForPct(pct) };
  }

  // Check a hand-typed "Title Adj Noun" against the human seed; if it lands an
  // existing (and rare) combo, the bonus still applies.
  // Parse a hand-typed "Title Adjective Noun" against the live seed pools. The
  // name itself encodes its gender (noun gender + adjective inflection), so we
  // try the caller's preferred gender first (to stay coherent with the toggle)
  // and otherwise auto-detect it — returning the matched gender so the UI can
  // adopt it. A match under a rare component still earns the bonus.
  function matchSeed(name, gender) {
    var parts = (name || '').trim().split(/\s+/);
    if (parts.length !== 3) return { matched: false, pct: null, bonus: 0 };
    var title = parts[0], adjForm = parts[1], noun = parts[2], te = null, i;
    for (i = 0; i < titlePool.length; i++) if (entryWord(titlePool[i].e) === title) { te = titlePool[i]; break; }
    if (!te) return { matched: false, pct: null, bonus: 0 };
    var order = ['m', 'f', 'n'];
    if (gender) order = [gender].concat(order.filter(function (g) { return g !== gender; }));
    for (var gi = 0; gi < order.length; gi++) {
      var g = order[gi], ae = null, ne = null;
      for (i = 0; i < nounPool.length; i++) if (nounPool[i].e.w === noun && nounPool[i].e.g === g) { ne = nounPool[i]; break; }
      if (!ne) continue;
      for (i = 0; i < adjPool.length; i++) if (capitalize(inflectAdj(entryAdj(adjPool[i].e), g)) === adjForm) { ae = adjPool[i]; break; }
      if (!ae) continue;
      var pcts = [te.pct, ae.pct, ne.pct].filter(function (p) { return p != null; });
      var pct = pcts.length ? Math.min.apply(null, pcts) : null;
      return { matched: true, pct: pct, bonus: bonusForPct(pct), gender: g };
    }
    return { matched: false, pct: null, bonus: 0 };
  }

  // Rarity tier (drives the bubble colour + the exclamation): 1..5 = that
  // percent bracket, 10 = the 5–10% bracket. null pct = common, no tier.
  function rarityTier(pct) {
    if (pct == null) return 0;
    if (pct <= 1) return 1; if (pct <= 2) return 2; if (pct <= 3) return 3;
    if (pct <= 4) return 4; if (pct <= 5) return 5;
    return 10;
  }
  var RARITY_EXCL = { 1: 'ГОСПОДИ!', 2: 'Ебаси,', 3: 'Лееееле, майко!', 4: 'Татенце!', 5: 'ЕХЕ!', 10: 'Брей,' };

  function rarityLine(pct, bonus) {
    var pctStr = pct < 1 ? pct.toFixed(1) : String(Math.round(pct));
    var excl = RARITY_EXCL[rarityTier(pct)] || 'Брей,';
    var b = bonus > 0 ? ' Щабът ти отпуска +' + bonus + ' т. начален аванс!' : '';
    return excl + ' ' + pctStr + '% шанс за такова име!' + b;
  }

  // dev-mode dump of the current (per-load) pools, with assigned rarity.
  function dumpPools() {
    function fmt(pool) { return pool.map(function (p) { return { w: entryWord(p.e), pct: p.pct, g: p.e.g || null }; }); }
    return { titles: fmt(titlePool), adjs: fmt(adjPool), nouns: fmt(nounPool), aiAdjs: fmt(aiAdjPool), aiNouns: fmt(aiNounPool) };
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
    surgeon:  { name: 'Хирургът',     color: '#e8c356', desc: 'Точен, хладнокръвен, без излишни рискове.' },
    recruit:  { name: 'Новобранецът', color: '#b39ddb', desc: 'Още учи кой зар за какво е.' },
    gambler:  { name: 'Комарджията',  color: '#e05545', desc: 'Гони големите комбинации на всяка цена.' },
    clerk:    { name: 'Чиновникът',   color: '#6fa8e8', desc: 'Прибира сигурното и спи спокойно.' },
    stuntman: { name: 'Каскадьорът',  color: '#e8843a', desc: 'Грешките му са зрелищни.' },
    lucky:    { name: 'Късметлията',  color: '#9bd17e', desc: 'Заровете го обичат повече, отколкото заслужава.' },
    soldier:  { name: 'Боецът',       color: '#cdc9a8', desc: 'Стабилен среден кадър.' },
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
    rarityLine: rarityLine,
    rarityTier: rarityTier,
    matchSeed: matchSeed,
    dumpPools: dumpPools,
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
