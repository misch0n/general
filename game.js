/*
 * Генерал — core game logic.
 *
 * This module is intentionally free of any DOM / browser dependencies so that
 * every rule and workflow can be unit tested under Node (`node --test`).
 *
 * It is loaded both by the browser (index.html, as `window.General`) and by the
 * test suite (`require('./game.js')`) via the UMD wrapper below.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.General = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Fixed point values for combination categories. Kept in one place so the
  // scoring can be tuned later without hunting through the code.
  var SCORING = {
    fullHouse: 25,
    smallStraight: 30,
    largeStraight: 40,
    general: 50,
  };

  // The scoreboard, in display order. `key` is used everywhere in code/state,
  // `label` is what the player sees, `group` drives section styling in the UI.
  var CATEGORIES = [
    { key: 'ones',          label: '1',          group: 'upper' },
    { key: 'twos',          label: '2',          group: 'upper' },
    { key: 'threes',        label: '3',          group: 'upper' },
    { key: 'fours',         label: '4',          group: 'upper' },
    { key: 'fives',         label: '5',          group: 'upper' },
    { key: 'sixes',         label: '6',          group: 'upper' },
    { key: 'twoKind',       label: '2x',         group: 'lower' },
    { key: 'threeKind',     label: '3x',         group: 'lower' },
    { key: 'fourKind',      label: '4x',         group: 'lower' },
    { key: 'fullHouse',     label: 'фул хаус',    group: 'lower' },
    { key: 'smallStraight', label: 'малка кента', group: 'lower' },
    { key: 'largeStraight', label: 'голяма кента',group: 'lower' },
    { key: 'general',       label: 'генерал',     group: 'lower' },
    { key: 'chance',        label: 'шанс',        group: 'lower' },
  ];

  var DICE_COUNT = 5;
  var MAX_ROLLS = 3;

  // ----------------------------------------------------------------- helpers

  // counts(dice)[face] === how many dice show `face` (index 1..6).
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

  function hasNOfAKind(dice, n) {
    return counts(dice).some(function (c) { return c >= n; });
  }

  // Strict full house: exactly a triple + a pair (three of one face, two of
  // another). Five of a kind is NOT treated as a full house.
  function isFullHouse(dice) {
    var nz = counts(dice).filter(function (x) { return x > 0; })
                         .sort(function (a, b) { return a - b; });
    return nz.length === 2 && nz[0] === 2 && nz[1] === 3;
  }

  // length 4 => small straight (any four in a row), 5 => large straight.
  function hasStraight(dice, length) {
    var present = {};
    for (var i = 0; i < dice.length; i++) present[dice[i]] = true;
    var runs = length === 4
      ? [[1, 2, 3, 4], [2, 3, 4, 5], [3, 4, 5, 6]]
      : [[1, 2, 3, 4, 5], [2, 3, 4, 5, 6]];
    return runs.some(function (run) {
      return run.every(function (n) { return present[n]; });
    });
  }

  function isGeneral(dice) {
    return counts(dice).some(function (c) { return c === DICE_COUNT; });
  }

  // ----------------------------------------------------------------- scoring

  var SCORERS = {
    ones:   function (d) { return sumOfFace(d, 1); },
    twos:   function (d) { return sumOfFace(d, 2); },
    threes: function (d) { return sumOfFace(d, 3); },
    fours:  function (d) { return sumOfFace(d, 4); },
    fives:  function (d) { return sumOfFace(d, 5); },
    sixes:  function (d) { return sumOfFace(d, 6); },
    // 2x/3x/4x: at least N of a kind scores the sum of ALL five dice.
    twoKind:   function (d) { return hasNOfAKind(d, 2) ? sum(d) : 0; },
    threeKind: function (d) { return hasNOfAKind(d, 3) ? sum(d) : 0; },
    fourKind:  function (d) { return hasNOfAKind(d, 4) ? sum(d) : 0; },
    fullHouse:     function (d) { return isFullHouse(d) ? SCORING.fullHouse : 0; },
    smallStraight: function (d) { return hasStraight(d, 4) ? SCORING.smallStraight : 0; },
    largeStraight: function (d) { return hasStraight(d, 5) ? SCORING.largeStraight : 0; },
    general:       function (d) { return isGeneral(d) ? SCORING.general : 0; },
    chance:        function (d) { return sum(d); },
  };

  // Score a single category for a given dice combination.
  function scoreFor(category, dice) {
    var scorer = SCORERS[category];
    if (!scorer) throw new Error('Unknown category: ' + category);
    return scorer(dice);
  }

  // ----------------------------------------------------------------- dice

  function rollDie(rng) {
    return 1 + Math.floor((rng || Math.random)() * 6);
  }

  function rollAll(rng) {
    var out = [];
    for (var i = 0; i < DICE_COUNT; i++) out.push(rollDie(rng));
    return out;
  }

  // Re-roll only the dice whose hold flag is false.
  function reroll(dice, holds, rng) {
    return dice.map(function (d, i) { return holds[i] ? d : rollDie(rng); });
  }

  // ----------------------------------------------------------------- players

  function createPlayer(name, color) {
    return { name: name, color: color, scores: {} };
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

  // Lock in a category for a player using the current dice. Throws if the
  // category is already filled (each category is scored exactly once).
  function assignScore(player, category, dice) {
    if (isCategoryFilled(player, category)) {
      throw new Error('Category already filled: ' + category);
    }
    player.scores[category] = scoreFor(category, dice);
    return player.scores[category];
  }

  // ----------------------------------------------------------------- game

  function createGame(players) {
    return { players: players, current: 0, round: 1 };
  }

  function currentPlayer(game) {
    return game.players[game.current];
  }

  function nextTurn(game) {
    game.current = (game.current + 1) % game.players.length;
    if (game.current === 0) game.round += 1;
    return game;
  }

  function isGameOver(game) {
    return game.players.every(isBoardComplete);
  }

  // Players sorted high score first. Ties keep their original (turn) order.
  function ranking(game) {
    return game.players
      .map(function (p, i) { return { player: p, total: playerTotal(p), order: i }; })
      .sort(function (a, b) { return b.total - a.total || a.order - b.order; });
  }

  return {
    SCORING: SCORING,
    CATEGORIES: CATEGORIES,
    DICE_COUNT: DICE_COUNT,
    MAX_ROLLS: MAX_ROLLS,
    counts: counts,
    sum: sum,
    sumOfFace: sumOfFace,
    hasNOfAKind: hasNOfAKind,
    isFullHouse: isFullHouse,
    hasStraight: hasStraight,
    isGeneral: isGeneral,
    SCORERS: SCORERS,
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
  };
});
