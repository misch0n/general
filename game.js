/*
 * Генерал — core game logic.
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

  // ----------------------------------------------------------------- names

  var TITLES   = ['Генерал', 'Майор', 'Полковник', 'Капитан', 'Адмирал', 'Сержант', 'Ефрейтор', 'Лейтенант'];
  var ADJS     = ['Малка', 'Черен', 'Лудия', 'Дебел', 'Кривия', 'Смотан', 'Космат', 'Тлъст', 'Бясна', 'Сополив', 'Кьорав', 'Намусен', 'Тромав', 'Гръмогласен'];
  var NOUNS    = ['Пишка', 'Петел', 'Краставица', 'Тиква', 'Мотика', 'Чорап', 'Баклава', 'Магаре', 'Кашкавал', 'Лопата', 'Бухал', 'Геврек', 'Таралеж', 'Дюшек'];
  var AI_ADJS  = ['Електро', 'Продупчено', 'Ръждиво', 'Магнитно', 'Волтово', 'Стоманено', 'Цинково', 'Наелектризирано', 'Хромирано', 'Искрящо', 'Турбо', 'Атомно', 'Дигитално', 'Късо'];
  var AI_NOUNS = ['Камила', 'Тенеке', 'Робот', 'Чайник', 'Трансформатор', 'Болт', 'Тостер', 'Прахосмукачка', 'Ютия', 'Котлон', 'Бойлер', 'Динамо', 'Реотан', 'Ключ'];

  function pick(arr, rng) { return arr[Math.floor((rng || Math.random)() * arr.length)]; }

  function randomHumanName(rng) {
    return pick(TITLES, rng) + ' ' + pick(ADJS, rng) + ' ' + pick(NOUNS, rng);
  }
  function randomAiName(rng) {
    return pick(TITLES, rng) + ' ' + pick(AI_ADJS, rng) + ' ' + pick(AI_NOUNS, rng);
  }

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
    createGame: createGame,
    currentPlayer: currentPlayer,
    nextTurn: nextTurn,
    isGameOver: isGameOver,
    ranking: ranking,
    aiChooseHolds: aiChooseHolds,
    aiChooseCategory: aiChooseCategory,
    randomHumanName: randomHumanName,
    randomAiName: randomAiName,
    nameGenerator: nameGenerator,
  };
});
