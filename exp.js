/* Experimental ruleset — the Bulgarian „Генерал“ in THREE columns (нива).
 * Kept deliberately separate from the standard game flow (game.js stays the
 * canonical original ruleset). Scoring primitives live in game.js
 * (scoreForExp / colTotalExp / cardTotalExp / forcedNextExp); this module is
 * the three-column STATE MACHINE + a heuristic AI.
 *
 * Columns (per player, each a full 15-category card):
 *   • column 0 — filled strictly top-to-bottom (forced order); a negative
 *     number part is kept as its sum (no −50);
 *   • column 1 — free order; −50 if the number part finishes negative;
 *   • column 2 — free order; −50 rule; plus RESERVE ROLLS: every turn that
 *     ends with re-rolls to spare banks them, and in column 2 a banked roll can
 *     be spent for one extra re-roll past the usual three throws.
 * A player works their columns in order (finish 0, then 1, then 2): 45 turns.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./game.js'));
  else root.GeneralExp = factory(root.General);
})(typeof self !== 'undefined' ? self : this, function (G) {
  'use strict';

  var CATS = G.CATEGORIES_EXP;
  var KEYS = CATS.map(function (c) { return c.key; });
  var COLS = G.COLS_EXP;                 // 3
  var REROLLS = 2;                       // re-rolls after the opening throw (3 throws total)

  function filledCount(scores) {
    var n = 0; KEYS.forEach(function (k) { if (typeof scores[k] === 'number') n++; }); return n; }

  // the lowest column a player hasn't finished yet (−1 when the whole card is done)
  function activeCol(player) {
    for (var c = 0; c < COLS; c++) if (filledCount(player.cols[c]) < KEYS.length) return c;
    return -1;
  }
  function playerDone(player) { return activeCol(player) < 0; }

  // the cells a player may legally fill this turn (column 0 → only the forced next)
  function availableCells(player) {
    var col = activeCol(player); if (col < 0) return [];
    if (col === 0) { var k = G.forcedNextExp(player.cols[0]); return k ? [{ col: 0, key: k }] : []; }
    return KEYS.filter(function (k) { return typeof player.cols[col][k] !== 'number'; })
               .map(function (k) { return { col: col, key: k }; });
  }
  function canPlay(player, col, key) {
    return availableCells(player).some(function (a) { return a.col === col && a.key === key; });
  }

  function createPlayerCard(player) { player.cols = [{}, {}, {}]; player.reserve = 0; return player; }
  function createGame(players) {
    players.forEach(createPlayerCard);
    return { players: players, current: 0, turn: 1, ruleset: 'experimental' };
  }
  function currentPlayer(game) { return game.players[game.current]; }
  function isGameOver(game) { return game.players.every(playerDone); }

  // commit a roll into a cell (value optional — defaults to the cell's score for the dice)
  function assignScore(player, col, key, dice, value) {
    if (typeof player.cols[col][key] === 'number') throw new Error('cell already filled: ' + col + '/' + key);
    player.cols[col][key] = (typeof value === 'number') ? value : G.scoreForExp(key, dice);
  }
  // bank the unused re-rolls (only ever spent later, in column 2)
  function bankReserve(player, rerollsLeft) { player.reserve += Math.max(0, rerollsLeft | 0); }
  // a banked roll may be spent for an extra re-roll once the normal throws run out, in column 2
  function canSpendReserve(player, rerollsLeft) { return activeCol(player) === 2 && rerollsLeft <= 0 && player.reserve > 0; }

  function total(player) { return G.cardTotalExp(player.cols); }
  function nextTurn(game) {
    do { game.current = (game.current + 1) % game.players.length; if (game.current === 0) game.turn++; }
    while (!isGameOver(game) && playerDone(currentPlayer(game)));
    return game;
  }
  // standings: by grand total, highest first (ties keep input order)
  function ranking(game) {
    return game.players.map(function (p, i) { return { player: p, total: total(p), order: i }; })
      .sort(function (a, b) { return (b.total - a.total) || (a.order - b.order); });
  }

  // ------------------------------------------------------------------ heuristic AI
  function counts(dice) { var c = [0, 0, 0, 0, 0, 0, 0]; dice.forEach(function (d) { c[d]++; }); return c; }

  // dice to KEEP when chasing a given category (only the relevant ones)
  function keepFor(col, key, dice) {
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

  // pick the most promising available cell to chase (greedy on what this roll already scores,
  // nudged so the upper deviation cells don't dump badly and premium combos aren't wasted)
  function bestTarget(player, dice) {
    var avail = availableCells(player), best = null, bestV = -Infinity;
    avail.forEach(function (a) {
      var v = G.scoreForExp(a.key, dice);
      // value an unfinished cell by its score, with a small bias toward premium combos
      var w = v + (PREMIUM[a.key] ? 6 : 0) + (G.UPPER_KEYS.indexOf(a.key) >= 0 ? Math.max(0, v) : 0);
      if (w > bestV) { bestV = w; best = a; }
    });
    return best;
  }
  var PREMIUM = { general: 1, largeStraight: 1, smallStraight: 1, fullHouse: 1, fourKind: 1, twoPair: 1 };

  function aiKeeps(player, dice, rerollsLeft) {
    var t = bestTarget(player, dice); if (!t) return dice.map(function () { return true; });
    return keepFor(t.col, t.key, dice);
  }
  // which available cell to write the final dice into (avoid throwing away a good roll
  // on a cell that wants something else; for the forced column there is only one choice)
  function aiChooseCell(player, dice) {
    var avail = availableCells(player); if (!avail.length) return null;
    if (avail.length === 1) return avail[0];
    var best = avail[0], bestV = -Infinity;
    avail.forEach(function (a) {
      var v = G.scoreForExp(a.key, dice);
      // prefer to score where the roll lands well; dumping (low/negative) goes to the cheapest cell
      var w = v - (PREMIUM[a.key] && v <= 0 ? 8 : 0);
      if (w > bestV) { bestV = w; best = a; }
    });
    return best;
  }

  return {
    CATS: CATS, KEYS: KEYS, COLS: COLS, REROLLS: REROLLS,
    filledCount: filledCount, activeCol: activeCol, playerDone: playerDone,
    availableCells: availableCells, canPlay: canPlay,
    createGame: createGame, createPlayerCard: createPlayerCard, currentPlayer: currentPlayer,
    isGameOver: isGameOver, assignScore: assignScore, total: total, nextTurn: nextTurn, ranking: ranking,
    bankReserve: bankReserve, canSpendReserve: canSpendReserve,
    keepFor: keepFor, bestTarget: bestTarget, aiKeeps: aiKeeps, aiChooseCell: aiChooseCell,
  };
});
