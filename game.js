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
    { key: 'ones',          label: '1',              group: 'upper' },
    { key: 'twos',          label: '2',              group: 'upper' },
    { key: 'threes',        label: '3',              group: 'upper' },
    { key: 'fours',         label: '4',              group: 'upper' },
    { key: 'fives',         label: '5',              group: 'upper' },
    { key: 'sixes',         label: '6',              group: 'upper' },
    { key: 'twoKind',       label: '2x',             group: 'lower' },
    { key: 'threeKind',     label: '3x',             group: 'lower' },
    { key: 'fourKind',      label: '4x',             group: 'lower' },
    { key: 'fullHouse',     label: 'Full House',     group: 'lower' },
    { key: 'smallStraight', label: 'Small Straight', group: 'lower' },
    { key: 'largeStraight', label: 'Large Straight', group: 'lower' },
    { key: 'general',       label: 'General',        group: 'lower' },
    { key: 'chance',        label: 'Chance',         group: 'lower' },
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

  var ROASTS = {
    // shown the moment a player gambles a made combo away
    risk: [
      "You don't seem to value your {X} much.",
      'Throwing back a {X}? Living dangerously.',
      'You like losing, eh?',
      'Sure, reroll the {X}. What could possibly go wrong.',
      'Fortune favors the foolish, allegedly.',
      'Big risk energy. The dice are already laughing.',
      'Bold of you to assume the dice are on your side.',
    ],
    // the brutal ones, shown when the gamble made things worse
    fail: [
      'Your {X} packed its bags and left.',
      'And there goes the {X}. Hope it was worth it.',
      'Spectacular. You turned gold into gravel.',
      'The dice have spoken, and they are disappointed in you.',
      'That is a self-inflicted wound if ever there was one.',
      'You had it. You really had it. Now you have nothing.',
      'Somewhere, a statistician just wept.',
      'Bold move. Catastrophic result. Iconic.',
      'You fumbled a {X}. Frame this moment.',
    ],
  };

  // ----------------------------------------------------------------- names & bets

  var TITLES   = ['General', 'Major', 'Colonel', 'Captain', 'Admiral', 'Sergeant', 'Corporal', 'Lieutenant'];
  var NOUNS    = ['Willy', 'Rooster', 'Cucumber', 'Pumpkin', 'Hoe', 'Sock', 'Donkey', 'Cheese', 'Shovel', 'Owl', 'Bagel', 'Hedgehog', 'Mattress', 'Goose'];
  var AI_NOUNS = ['Camel', 'TinCan', 'Robot', 'Kettle', 'Transformer', 'Bolt', 'Toaster', 'Vacuum', 'Iron', 'Hotplate', 'Boiler', 'Dynamo', 'Coil', 'Wrench'];

  // The stupid thing a player wagers, used in the "Bets X" line.
  var BETS = [
    'his dog', 'his mother', 'his dignity', 'his mother-in-law', 'his mustache',
    'his last dollar', 'his honor', 'his car', 'his grandma', 'his socks',
    'his kidney', 'his soul', 'his marriage', 'the neighbor\'s cat', 'his good name',
    'his favorite fork', 'the summer house', 'his entire pension',
  ];

  function pick(arr, rng) { return arr[Math.floor((rng || Math.random)() * arr.length)]; }

  // Names are Title + Noun, e.g. "General Willy" / "Major TinCan".
  function randomHumanName(rng) { return pick(TITLES, rng) + ' ' + pick(NOUNS, rng); }
  function randomAiName(rng) { return pick(TITLES, rng) + ' ' + pick(AI_NOUNS, rng); }
  function randomBet(rng) { return pick(BETS, rng); }

  // A generator that avoids repeating names it has already handed out.
  function nameGenerator(kind) {
    var used = {};
    var make = kind === 'ai' ? randomAiName : randomHumanName;
    return function (rng) {
      for (var i = 0; i < 60; i++) {
        var n = make(rng);
        if (!used[n]) { used[n] = true; return n; }
      }
      return make(rng);
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
    bestOpenScore: bestOpenScore,
    atRiskPremium: atRiskPremium,
    ROASTS: ROASTS,
    randomHumanName: randomHumanName,
    randomAiName: randomAiName,
    randomBet: randomBet,
    nameGenerator: nameGenerator,
  };
});
