/* Experimental ruleset — standard Bulgarian „Генерал“ (single column).
 * One 15-row card per player, filled in ANY order. The number part (1-6) is a
 * deviation-around-three section recorded as a flat −50 if it finishes negative;
 * the combinations score as the sum of the dice involved (kента/генерал fixed).
 * Kept separate from the standard game flow (game.js stays the canonical Yahtzee-
 * like ruleset). Scoring lives in game.js; this module is the flow + a heuristic AI.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./game.js'));
  else root.GeneralExp = factory(root.General);
})(typeof self !== 'undefined' ? self : this, function (G) {
  'use strict';

  var CATS = G.CATEGORIES_EXP;
  var KEYS = CATS.map(function (c) { return c.key; });
  var REROLLS = 2;                       // re-rolls after the opening throw (3 throws total)

  function filledCount(scores) { var n = 0; KEYS.forEach(function (k) { if (typeof scores[k] === 'number') n++; }); return n; }
  function playerDone(player) { return filledCount(player.scores) >= KEYS.length; }
  // free order: any unfilled row is available
  function availableKeys(player) { return KEYS.filter(function (k) { return typeof player.scores[k] !== 'number'; }); }
  function canPlay(player, key) { return typeof player.scores[key] !== 'number'; }

  function createPlayerCard(player) { if (!player.scores) player.scores = {}; return player; }
  function createGame(players) { players.forEach(createPlayerCard); return { players: players, current: 0, round: 1, ruleset: 'experimental' }; }
  function currentPlayer(game) { return game.players[game.current]; }
  function isGameOver(game) { return game.players.every(playerDone); }

  function assignScore(player, key, dice, value) {
    if (typeof player.scores[key] === 'number') throw new Error('row already filled: ' + key);
    player.scores[key] = (typeof value === 'number') ? value : G.scoreForExp(key, dice);
  }
  function total(player) { return G.playerTotalExp(player); }
  function nextTurn(game) {
    do { game.current = (game.current + 1) % game.players.length; if (game.current === 0) game.round++; }
    while (!isGameOver(game) && playerDone(currentPlayer(game)));
    return game;
  }
  function ranking(game) {
    return game.players.map(function (p, i) { return { player: p, total: total(p), order: i }; })
      .sort(function (a, b) { return (b.total - a.total) || (a.order - b.order); });
  }

  // ------------------------------------------------------------------ heuristic AI
  function counts(dice) { var c = [0, 0, 0, 0, 0, 0, 0]; dice.forEach(function (d) { c[d]++; }); return c; }
  var PREMIUM = { general: 1, largeStraight: 1, smallStraight: 1, fullHouse: 1, fourKind: 1, twoPair: 1 };

  // dice to KEEP when chasing a given category
  function keepFor(key, dice) {
    var c = counts(dice);
    if (G.UPPER_KEYS.indexOf(key) >= 0) { var f = G.UPPER_KEYS.indexOf(key) + 1; return dice.map(function (v) { return v === f; }); }
    if (key === 'twoKind' || key === 'threeKind' || key === 'fourKind' || key === 'general') {
      var best = 0, bf = 0; for (var x = 6; x >= 1; x--) if (c[x] > best) { best = c[x]; bf = x; }
      return dice.map(function (v) { return v === bf; });
    }
    if (key === 'twoPair' || key === 'fullHouse') return dice.map(function (v) { return c[v] >= 2; });
    if (key === 'smallStraight' || key === 'largeStraight') {
      var need = key === 'smallStraight' ? [1, 2, 3, 4, 5] : [2, 3, 4, 5, 6], seen = {};
      return dice.map(function (v) { if (need.indexOf(v) >= 0 && !seen[v]) { seen[v] = 1; return true; } return false; });
    }
    if (key === 'chance') return dice.map(function (v) { return v >= 4; });
    return dice.map(function () { return false; });
  }
  function bestTarget(player, dice) {
    var best = null, bestV = -Infinity;
    availableKeys(player).forEach(function (key) {
      var v = G.scoreForExp(key, dice);
      var w = v + (PREMIUM[key] ? 6 : 0) + (G.UPPER_KEYS.indexOf(key) >= 0 ? Math.max(0, v) : 0);
      if (w > bestV) { bestV = w; best = key; }
    });
    return best;
  }
  function aiKeeps(player, dice) {
    var t = bestTarget(player, dice); return t ? keepFor(t, dice) : dice.map(function () { return true; });
  }
  // which row to write the final dice into (avoid wasting a good roll; protect the number part)
  function aiChooseKey(player, dice) {
    var avail = availableKeys(player); if (!avail.length) return null;
    if (avail.length === 1) return avail[0];
    var upNow = G.upperStateExp(player.scores).subtotal;
    var best = avail[0], bestV = -Infinity;
    avail.forEach(function (key) {
      var imm = G.scoreForExp(key, dice);
      var isUpper = G.UPPER_KEYS.indexOf(key) >= 0;
      // avoid locking a negative number part; don't dump premium combos for nothing
      var w = imm - (PREMIUM[key] && imm <= 0 ? 8 : 0);
      if (isUpper && imm < 0) {
        var maxFuture = 0;
        G.UPPER_KEYS.forEach(function (k, fi) { if (k !== key && typeof player.scores[k] !== 'number') maxFuture += 2 * (fi + 1); });
        if (upNow + imm + maxFuture < 0) w += G.UPPER_PENALTY;   // this fill would lock the −50
      }
      if (w > bestV) { bestV = w; best = key; }
    });
    return best;
  }

  return {
    CATS: CATS, KEYS: KEYS, REROLLS: REROLLS,
    filledCount: filledCount, playerDone: playerDone, availableKeys: availableKeys, canPlay: canPlay,
    createGame: createGame, createPlayerCard: createPlayerCard, currentPlayer: currentPlayer,
    isGameOver: isGameOver, assignScore: assignScore, total: total, nextTurn: nextTurn, ranking: ranking,
    keepFor: keepFor, bestTarget: bestTarget, aiKeeps: aiKeeps, aiChooseKey: aiChooseKey,
  };
});
