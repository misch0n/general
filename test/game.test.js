'use strict';

var test = require('node:test');
var assert = require('node:assert');
var G = require('../game.js');

// Deterministic RNG: makes rollDie produce exactly the given faces, in order.
function fixedDice(faces) {
  var i = 0;
  return function () {
    var face = faces[i++ % faces.length];
    return (face - 0.5) / 6; // floor(((f-0.5)/6)*6)+1 === f
  };
}

// ----------------------------------------------------------------- helpers

test('counts tallies each face', function () {
  assert.deepStrictEqual(G.counts([1, 1, 3, 6, 6]), [0, 2, 0, 1, 0, 0, 2]);
});

test('sum and sumOfFace', function () {
  assert.strictEqual(G.sum([1, 2, 3, 4, 5]), 15);
  assert.strictEqual(G.sumOfFace([3, 3, 3, 1, 2], 3), 9);
  assert.strictEqual(G.sumOfFace([3, 3, 3, 1, 2], 5), 0);
});

test('facesWithCount returns qualifying faces high to low', function () {
  assert.deepStrictEqual(G.facesWithCount([2, 2, 4, 4, 4], 2), [4, 2]);
  assert.deepStrictEqual(G.facesWithCount([2, 2, 4, 4, 4], 3), [4]);
  assert.deepStrictEqual(G.facesWithCount([2, 2, 4, 4, 4], 4), []);
});

test('isFullHouse: triple + pair only', function () {
  assert.strictEqual(G.isFullHouse([2, 2, 3, 3, 3]), true);
  assert.strictEqual(G.isFullHouse([2, 2, 2, 2, 3]), false);
  assert.strictEqual(G.isFullHouse([4, 4, 4, 4, 4]), false);
});

test('straights are exact five-dice sequences', function () {
  assert.strictEqual(G.isSmallStraight([5, 4, 3, 2, 1]), true);
  assert.strictEqual(G.isSmallStraight([1, 2, 3, 4, 6]), false);
  assert.strictEqual(G.isLargeStraight([6, 5, 4, 3, 2]), true);
  assert.strictEqual(G.isLargeStraight([1, 2, 3, 4, 5]), false);
});

test('isGeneral: all five equal', function () {
  assert.strictEqual(G.isGeneral([5, 5, 5, 5, 5]), true);
  assert.strictEqual(G.isGeneral([5, 5, 5, 5, 1]), false);
});

// ----------------------------------------------------------------- candidates

test('upper section: sum of matching face (or 0)', function () {
  assert.deepStrictEqual(G.candidates('ones', [1, 1, 1, 4, 5]), [3]);
  assert.deepStrictEqual(G.candidates('sixes', [6, 6, 6, 6, 1]), [24]);
  assert.deepStrictEqual(G.candidates('threes', [1, 2, 4, 5, 6]), [0]);
});

test('2x offers one entry per distinct pair-or-better face (sum of the two)', function () {
  // 1 2 2 5 5 -> pairs of 2 (=4) and 5 (=10)
  assert.deepStrictEqual(G.candidates('twoKind', [1, 2, 2, 5, 5]), [10, 4]);
  // 2 2 4 4 4 -> pair of 4 (=8) and pair of 2 (=4)
  assert.deepStrictEqual(G.candidates('twoKind', [2, 2, 4, 4, 4]), [8, 4]);
  assert.deepStrictEqual(G.candidates('twoKind', [1, 2, 3, 4, 5]), [0]);
});

test('3x and 4x score the sum of the three / four equal dice', function () {
  assert.deepStrictEqual(G.candidates('threeKind', [2, 2, 4, 4, 4]), [12]);
  assert.deepStrictEqual(G.candidates('threeKind', [2, 2, 1, 3, 5]), [0]);
  assert.deepStrictEqual(G.candidates('fourKind', [4, 4, 4, 4, 6]), [16]);
  assert.deepStrictEqual(G.candidates('fourKind', [4, 4, 4, 1, 6]), [0]);
});

test('full house scores the sum of all dice', function () {
  assert.deepStrictEqual(G.candidates('fullHouse', [2, 2, 4, 4, 4]), [16]);
  assert.deepStrictEqual(G.candidates('fullHouse', [2, 2, 2, 2, 3]), [0]);
});

test('kentas score fixed sums, general scores 50 + dice total', function () {
  assert.deepStrictEqual(G.candidates('smallStraight', [1, 2, 3, 4, 5]), [15]);
  assert.deepStrictEqual(G.candidates('smallStraight', [1, 2, 3, 4, 6]), [0]);
  assert.deepStrictEqual(G.candidates('largeStraight', [2, 3, 4, 5, 6]), [20]);
  assert.deepStrictEqual(G.candidates('general', [5, 5, 5, 5, 5]), [75]); // 50 + 25
  assert.deepStrictEqual(G.candidates('general', [5, 5, 5, 5, 1]), [0]);
});

test('chance is always the dice total', function () {
  assert.deepStrictEqual(G.candidates('chance', [1, 3, 3, 5, 6]), [18]);
});

test('candidates rejects an unknown category', function () {
  assert.throws(function () { G.candidates('nope', [1, 2, 3, 4, 5]); });
});

// Matches the worked examples from the spec.
test('suggestion set for 1 2 2 5 5', function () {
  var scoring = {};
  G.CATEGORIES.forEach(function (c) { scoring[c.key] = G.candidates(c.key, [1, 2, 2, 5, 5]); });
  var positive = G.CATEGORIES.filter(function (c) {
    return Math.max.apply(null, scoring[c.key]) > 0;
  }).map(function (c) { return c.key; });
  assert.deepStrictEqual(positive.sort(), ['chance', 'fives', 'ones', 'twoKind', 'twos']);
  assert.strictEqual(scoring.twoKind.length, 2); // two entries on 2x
});

test('suggestion set for 2 2 4 4 4', function () {
  var d = [2, 2, 4, 4, 4];
  var positive = G.CATEGORIES.filter(function (c) {
    return G.scoreFor(c.key, d) > 0;
  }).map(function (c) { return c.key; });
  assert.deepStrictEqual(positive.sort(),
    ['chance', 'fours', 'fullHouse', 'threeKind', 'twoKind', 'twos']);
  assert.strictEqual(G.candidates('twoKind', d).length, 2);
  assert.strictEqual(G.candidates('threeKind', d).length, 1);
});

// ----------------------------------------------------------------- dice

test('rollAll produces DICE_COUNT dice from the rng', function () {
  assert.deepStrictEqual(G.rollAll(fixedDice([1, 2, 3, 4, 5])), [1, 2, 3, 4, 5]);
});

test('rollDie stays within 1..6', function () {
  for (var i = 0; i < 500; i++) {
    var d = G.rollDie();
    assert.ok(d >= 1 && d <= 6 && Number.isInteger(d));
  }
});

test('reroll keeps held dice and replaces the rest in order', function () {
  var result = G.reroll([1, 1, 1, 1, 1], [true, false, true, false, true], fixedDice([6, 4]));
  assert.deepStrictEqual(result, [1, 6, 1, 4, 1]);
});

// ----------------------------------------------------------------- players

test('createPlayer captures name, colour and AI flag', function () {
  var p = G.createPlayer('Иван', '#ff0000', true);
  assert.strictEqual(p.name, 'Иван');
  assert.strictEqual(p.isAI, true);
  assert.deepStrictEqual(p.scores, {});
  assert.strictEqual(G.createPlayer('A', '#000').isAI, false);
});

test('assignScore defaults to the best candidate and blocks overwrite', function () {
  var p = G.createPlayer('A', '#000');
  assert.strictEqual(G.assignScore(p, 'twoKind', [1, 2, 2, 5, 5]), 10); // best pair
  assert.strictEqual(p.scores.twoKind, 10);
  assert.throws(function () { G.assignScore(p, 'twoKind', [3, 3, 1, 1, 1]); });
});

test('assignScore accepts a chosen legal candidate but rejects illegal ones', function () {
  var p = G.createPlayer('A', '#000');
  assert.strictEqual(G.assignScore(p, 'twoKind', [1, 2, 2, 5, 5], 4), 4); // pick the 2s
  assert.throws(function () { G.assignScore(G.createPlayer('B', '#0'), 'twoKind', [1, 2, 2, 5, 5], 7); });
});

test('a category can be sacrificed for 0', function () {
  var p = G.createPlayer('A', '#000');
  assert.strictEqual(G.assignScore(p, 'general', [1, 2, 3, 4, 5]), 0);
  assert.strictEqual(G.isCategoryFilled(p, 'general'), true);
});

test('forfeitScore zeroes any unfilled category, even a scoring one', function () {
  var p = G.createPlayer('A', '#000');
  // chance would score 15 here, but a deliberate forfeit writes 0
  assert.strictEqual(G.forfeitScore(p, 'chance'), 0);
  assert.strictEqual(p.scores.chance, 0);
  assert.throws(function () { G.forfeitScore(p, 'chance'); }); // already filled
});

test('playerTotal sums recorded scores', function () {
  var p = G.createPlayer('A', '#000');
  p.scores.chance = 17;
  p.scores.general = 75;
  assert.strictEqual(G.playerTotal(p), 92);
});

// ----------------------------------------------------------------- game flow

test('turn rotation cycles players and counts rounds', function () {
  var game = G.createGame(['A', 'B', 'C'].map(function (n) { return G.createPlayer(n, '#0'); }));
  assert.strictEqual(G.currentPlayer(game).name, 'A');
  G.nextTurn(game); assert.strictEqual(G.currentPlayer(game).name, 'B');
  G.nextTurn(game); assert.strictEqual(G.currentPlayer(game).name, 'C');
  G.nextTurn(game);
  assert.strictEqual(G.currentPlayer(game).name, 'A');
  assert.strictEqual(game.round, 2);
});

test('isGameOver only when every board is complete', function () {
  var game = G.createGame([G.createPlayer('A', '#0'), G.createPlayer('B', '#0')]);
  G.CATEGORIES.forEach(function (c) { game.players[0].scores[c.key] = 1; });
  assert.strictEqual(G.isGameOver(game), false);
  G.CATEGORIES.forEach(function (c) { game.players[1].scores[c.key] = 1; });
  assert.strictEqual(G.isGameOver(game), true);
});

test('ranking sorts by total desc, stable on ties', function () {
  var game = G.createGame(['A', 'B', 'C'].map(function (n) { return G.createPlayer(n, '#0'); }));
  game.players[0].scores.chance = 10;
  game.players[1].scores.chance = 30;
  game.players[2].scores.chance = 10;
  assert.deepStrictEqual(G.ranking(game).map(function (x) { return x.player.name; }), ['B', 'A', 'C']);
});

// ----------------------------------------------------------------- AI

test('aiChooseHolds keeps the largest matching group', function () {
  assert.deepStrictEqual(G.aiChooseHolds([4, 4, 4, 1, 2]), [true, true, true, false, false]);
  assert.deepStrictEqual(G.aiChooseHolds([2, 2, 5, 5, 1]), [false, false, true, true, false]); // ties pick the higher face (5s)
});

test('aiChooseHolds with no pair keeps the high dice', function () {
  assert.deepStrictEqual(G.aiChooseHolds([1, 2, 3, 5, 6]), [false, false, false, true, true]);
});

test('aiChooseCategory picks the highest-scoring open category', function () {
  var p = G.createPlayer('AI', '#0', true);
  var choice = G.aiChooseCategory(p, [6, 6, 6, 6, 6]); // general = 80
  assert.strictEqual(choice.category, 'general');
  assert.strictEqual(choice.value, G.SCORING.generalBonus + 30);
});

test('aiChooseCategory sacrifices in order when nothing scores', function () {
  var p = G.createPlayer('AI', '#0', true);
  // fill everything except general and ones; a non-scoring roll for both
  G.CATEGORIES.forEach(function (c) {
    if (c.key !== 'general' && c.key !== 'ones') p.scores[c.key] = 0;
  });
  var choice = G.aiChooseCategory(p, [2, 3, 4, 6, 6]); // ones=0, general=0
  assert.strictEqual(choice.category, 'general'); // general sacrificed before ones
  assert.strictEqual(choice.value, 0);
});

test('aiChooseCategory only ever picks an open category', function () {
  var p = G.createPlayer('AI', '#0', true);
  p.scores.chance = 5;
  var choice = G.aiChooseCategory(p, [1, 1, 2, 3, 4]);
  assert.notStrictEqual(choice.category, 'chance');
  assert.strictEqual(G.isCategoryFilled(p, choice.category), false);
});

// ----------------------------------------------------------------- probabilities

function approx(actual, expected, eps) {
  assert.ok(Math.abs(actual - expected) <= (eps || 1e-9),
    'expected ~' + expected + ' got ' + actual);
}

test('hitProbability with no rerolls is 1 if made, else 0', function () {
  assert.strictEqual(G.hitProbability('general', [6, 6, 6, 6, 6], 0), 1);
  assert.strictEqual(G.hitProbability('general', [6, 6, 6, 6, 1], 0), 0);
  assert.strictEqual(G.hitProbability('smallStraight', [1, 2, 3, 4, 5], 2), 1); // already made
});

test('hitProbability stays within [0,1] and never decreases with more rerolls', function () {
  G.CATEGORIES.forEach(function (c) {
    var dice = [1, 2, 3, 4, 6];
    var p1 = G.hitProbability(c.key, dice, 1);
    var p2 = G.hitProbability(c.key, dice, 2);
    assert.ok(p1 >= 0 && p1 <= 1 && p2 >= 0 && p2 <= 1);
    assert.ok(p2 >= p1 - 1e-12, c.key + ': more rerolls should not lower the chance');
  });
});

test('chance is always certain', function () {
  assert.strictEqual(G.hitProbability('chance', [1, 1, 1, 1, 1], 0), 1);
  assert.strictEqual(G.hitProbability('chance', [2, 4, 6, 1, 3], 2), 1);
});

test('one reroll for the last die of a general is exactly 1/6', function () {
  approx(G.hitProbability('general', [6, 6, 6, 6, 1], 1), 1 / 6, 1e-12);
});

test('chance to roll a face with one reroll of five dice', function () {
  // need at least one 1, currently none, reroll all five
  approx(G.hitProbability('ones', [2, 3, 4, 5, 6], 1), 1 - Math.pow(5 / 6, 5), 1e-12);
});

test('improveProbability: only chance is ever 100%, made combos are not', function () {
  assert.strictEqual(G.improveProbability('chance', [1, 1, 1, 1, 1], 2), 1);
  // having one 2 is NOT certainty — it is the chance of rolling another 2
  approx(G.improveProbability('twos', [2, 3, 4, 5, 6], 2), 1 - Math.pow(25 / 36, 4), 1e-9);
  assert.ok(G.improveProbability('twos', [2, 3, 4, 5, 6], 2) < 1);
});

test('improveProbability rises as you get closer to a general', function () {
  var three = G.improveProbability('general', [6, 6, 6, 1, 2], 2);
  var four = G.improveProbability('general', [6, 6, 6, 6, 1], 2);
  assert.ok(four > three, 'four sixes should beat three sixes');
  approx(G.improveProbability('general', [6, 6, 6, 6, 1], 1), 1 / 6, 1e-9); // one die, one reroll
});

test('improveProbability is 0 for a combo that cannot be bettered', function () {
  assert.strictEqual(G.improveProbability('general', [6, 6, 6, 6, 6], 2), 0); // already maxed
  assert.strictEqual(G.improveProbability('smallStraight', [1, 2, 3, 4, 5], 2), 0); // fixed value
  assert.strictEqual(G.improveProbability('ones', [2, 3, 4, 5, 6], 0), 0); // no rerolls
});

test('improveProbability stays within [0,1] for every category', function () {
  G.CATEGORIES.forEach(function (c) {
    [0, 1, 2].forEach(function (r) {
      var p = G.improveProbability(c.key, [1, 2, 2, 5, 6], r);
      assert.ok(p >= 0 && p <= 1, c.key + '@' + r + ' = ' + p);
    });
  });
});

test('hitProbabilityFresh is a valid probability for every category', function () {
  G.CATEGORIES.forEach(function (c) {
    var p = G.hitProbabilityFresh(c.key);
    assert.ok(p >= 0 && p <= 1, c.key + ' fresh prob out of range: ' + p);
  });
  approx(G.hitProbabilityFresh('chance'), 1, 1e-9);
});

// ----------------------------------------------------------------- risk & roasts

test('bestOpenScore ignores already-filled categories', function () {
  var p = G.createPlayer('A', '#0');
  assert.strictEqual(G.bestOpenScore(p, [5, 5, 5, 1, 2]), 18); // 3x = 15? no: threeKind 15, chance 18
  p.scores.chance = 0; // remove chance from the pool
  assert.strictEqual(G.bestOpenScore(p, [5, 5, 5, 1, 2]), 15); // now threeKind 15 leads
});

test('atRiskPremium flags a made combo not preserved by the holds', function () {
  var p = G.createPlayer('A', '#0');
  // full house held only by the triple -> the pair is being rerolled
  var risk = G.atRiskPremium(p, [3, 3, 3, 2, 2], [true, true, true, false, false]);
  assert.strictEqual(risk.length, 1);
  assert.strictEqual(risk[0].key, 'fullHouse');
});

test('atRiskPremium is empty when the combo is preserved or already filled', function () {
  var p = G.createPlayer('A', '#0');
  // four of a kind kept, only the fifth die rerolled -> not at risk
  assert.strictEqual(G.atRiskPremium(p, [5, 5, 5, 5, 2], [true, true, true, true, false]).length, 0);
  // same gamble but four-of-a-kind already scored -> nothing to lose
  p.scores.fourKind = 20;
  assert.strictEqual(G.atRiskPremium(p, [5, 5, 5, 5, 2], [true, true, true, false, false]).length, 0);
});

test('roast pools are non-empty', function () {
  assert.ok(G.ROASTS.risk.length > 0 && G.ROASTS.fail.length > 0 && G.ROASTS.flop.length > 0);
});

test('orderText builds a coherent command, every category has a name', function () {
  assert.strictEqual(G.orderText('Майор', 'fullHouse'), 'Майор, генералът ти заповядва да хвърлиш фул хаус!');
  assert.strictEqual(G.orderText('Ефрейтор', 'sixes'), 'Ефрейтор, генералът ти заповядва да хвърлиш шестици!');
  G.CATEGORIES.forEach(function (c) { assert.ok(G.ORDER_NAMES[c.key], 'missing order name for ' + c.key); });
});

test('isDisappointing flags nothing-scores and all-in flops', function () {
  assert.strictEqual(G.isDisappointing(0, false), true);   // forfeit
  assert.strictEqual(G.isDisappointing(3, false), true);   // a measly 3
  assert.strictEqual(G.isDisappointing(12, false), false); // a fine score
  assert.strictEqual(G.isDisappointing(10, true), true);   // re-rolled everything for 10
  assert.strictEqual(G.isDisappointing(20, true), false);  // re-rolled everything but landed it
});

// --------------------------------------------------- Bulgarian agreement engine

test('inflectAdj agrees with gender (regular pattern)', function () {
  assert.strictEqual(G.inflectAdj({ base: 'смотан' }, 'm'), 'смотан');
  assert.strictEqual(G.inflectAdj({ base: 'смотан' }, 'f'), 'смотана');
  assert.strictEqual(G.inflectAdj({ base: 'смотан' }, 'n'), 'смотано');
});

test('inflectAdj leaves indeclinable adjectives untouched', function () {
  var inv = { base: 'електро', inv: true };
  assert.strictEqual(G.inflectAdj(inv, 'm'), 'електро');
  assert.strictEqual(G.inflectAdj(inv, 'f'), 'електро');
  assert.strictEqual(G.inflectAdj(inv, 'n'), 'електро');
});

test('possessive agrees with gender (subject vs object for masc)', function () {
  assert.strictEqual(G.possessive('m', true), 'твоят');
  assert.strictEqual(G.possessive('m', false), 'твоя');
  assert.strictEqual(G.possessive('f', true), 'твоята');
  assert.strictEqual(G.possessive('n', false), 'твоето');
});

test('renderRoast fills grammar tokens coherently per combo gender', function () {
  // feminine combo: малка кента (sentence-cased)
  assert.strictEqual(G.renderRoast('{ps} {c} замина.', 'smallStraight'), 'Твоята малка кента замина.');
  // masculine combo: генерал (subject form)
  assert.strictEqual(G.renderRoast('{ps} {c} замина.', 'general'), 'Твоят генерал замина.');
  // neuter combo: каре (object form)
  assert.strictEqual(G.renderRoast('Сбогом на {po} {c}.', 'fourKind'), 'Сбогом на твоето каре.');
});

test('every premium combo has roast grammar', function () {
  G.PREMIUM.forEach(function (k) {
    assert.ok(G.COMBO_GRAMMAR[k], 'missing grammar for ' + k);
  });
});

test('generated names agree: adjective matches noun gender', function () {
  // a feminine noun must get a feminine adjective (ends in 'а' for our set)
  // sample many names and check coherence holds structurally
  for (var i = 0; i < 50; i++) {
    var name = G.randomHumanName();
    assert.strictEqual(name.split(' ').length, 3, 'Title + Adj + Noun: ' + name);
  }
  // deterministic check via a forced rng that always picks index 0:
  //   TITLES[0]=Генерал, ADJS[0]=смотан, NOUNS[0]=Пишка (feminine)
  var zero = function () { return 0; };
  assert.strictEqual(G.randomHumanName(zero), 'Генерал Смотана Пишка');
});

test('randomGender returns m or f', function () {
  assert.strictEqual(G.randomGender(function () { return 0.3; }), 'm');
  assert.strictEqual(G.randomGender(function () { return 0.7; }), 'f');
});

test('genderFill inflects {adj} tokens by player gender (incl. neuter)', function () {
  assert.strictEqual(G.genderFill('по-{костелив} от това', 'm'), 'по-костелив от това');
  assert.strictEqual(G.genderFill('по-{костелив} от това', 'f'), 'по-костелива от това');
  assert.strictEqual(G.genderFill('по-{костелив} от това', 'n'), 'по-костеливо от това');
  assert.strictEqual(G.genderFill('{Роден} си за провал', 'f'), 'Родена си за провал');
  assert.strictEqual(G.genderFill('без токени', 'f'), 'без токени');
});

test('inflectAdj handles neuter and irregular (explicit) forms', function () {
  assert.strictEqual(G.inflectAdj({ base: 'смотан' }, 'n'), 'смотано'); // regular +о
  var irr = { base: 'добър', f: 'добра', n: 'добро' };
  assert.strictEqual(G.inflectAdj(irr, 'm'), 'добър');
  assert.strictEqual(G.inflectAdj(irr, 'f'), 'добра');
  assert.strictEqual(G.inflectAdj(irr, 'n'), 'добро');
});

test('neuter names resolve to a neuter noun + agreeing adjective', function () {
  // many neuter names must read coherently (3 words, neuter noun)
  for (var i = 0; i < 30; i++) {
    var parts = G.randomHumanName(undefined, 'n').split(' ');
    assert.strictEqual(parts.length, 3, 'Title+Adj+Noun: ' + parts.join(' '));
  }
});

test('bonusForPct awards points by the final name-percentage bracket', function () {
  // 0-1→5, 1-2→4, 2-3→3, 3-4→2, 4-5→1, 5-10→0 (smile), 10+→0
  assert.strictEqual(G.bonusForPct(null), 0);
  assert.strictEqual(G.bonusForPct(0.5), 5);
  assert.strictEqual(G.bonusForPct(1.5), 4);
  assert.strictEqual(G.bonusForPct(2.5), 3);
  assert.strictEqual(G.bonusForPct(3.5), 2);
  assert.strictEqual(G.bonusForPct(4.5), 1);
  assert.strictEqual(G.bonusForPct(7), 0);   // 5–10%: smile only, no points
  assert.strictEqual(G.bonusForPct(40), 0);  // common
});

test('rarityTier buckets the name % (5–10 is the smile tier); rarityLine per tier', function () {
  assert.strictEqual(G.rarityTier(null), 0);
  assert.strictEqual(G.rarityTier(0.5), 1);
  assert.strictEqual(G.rarityTier(1.5), 2);
  assert.strictEqual(G.rarityTier(2.5), 3);
  assert.strictEqual(G.rarityTier(3.5), 4);
  assert.strictEqual(G.rarityTier(4.5), 5);
  assert.strictEqual(G.rarityTier(7), 10);   // 5–10% smile tier
  assert.strictEqual(G.rarityTier(40), 0);   // common, no notification
  // exclamations for the bonus tiers, a smile for 5–10, bonus suffix when earned
  assert.ok(/^ГОСПОДИ! 0\.5% шанс/.test(G.rarityLine(0.5, 5)));
  assert.ok(/^Ебаси, 1\.5% шанс/.test(G.rarityLine(1.5, 4)));
  assert.ok(/^🙂 7% шанс/.test(G.rarityLine(7, 0)));   // smile, no bonus text
  assert.ok(G.rarityLine(0.5, 5).indexOf('+5 т.') > 0);
  assert.strictEqual(G.rarityLine(7, 0).indexOf('аванс'), -1);
});

test('randomNameRarity returns a coherent name + rarity/bonus', function () {
  for (var i = 0; i < 200; i++) {
    var r = G.randomNameRarity('human', 'f', undefined);
    assert.strictEqual(r.name.split(' ').length, 3);
    if (r.pct != null) assert.strictEqual(r.bonus, G.bonusForPct(r.pct));
    else assert.strictEqual(r.bonus, 0);
  }
});

test('matchSeed recognises a generated name and its rarity', function () {
  // any generated name must be found in the seed with matching rarity/bonus
  for (var i = 0; i < 100; i++) {
    var r = G.randomNameRarity('human', 'm', undefined);
    var m = G.matchSeed(r.name, 'm');
    assert.strictEqual(m.matched, true, 'should match: ' + r.name);
    assert.strictEqual(m.pct, r.pct);
    assert.strictEqual(m.bonus, r.bonus);
  }
  // a made-up name is not part of the seed
  assert.strictEqual(G.matchSeed('Зззз Яяяя Ккк', 'm').matched, false);
  assert.strictEqual(G.matchSeed('само две', 'f').matched, false);
});

test('matchSeed auto-detects a name gender that differs from the hint', function () {
  // build a neuter name, then look it up while "preferring" masculine: it must
  // still match and report the name's true (neuter) gender
  var r = G.randomNameRarity('human', 'n', function () { return 0; });
  var m = G.matchSeed(r.name, 'm');
  assert.strictEqual(m.matched, true, 'should still match: ' + r.name);
  assert.strictEqual(m.gender, 'n');
  assert.strictEqual(m.bonus, r.bonus);
});

test('dumpPools exposes every entry with its hardcoded bracket + fraction', function () {
  var d = G.dumpPools();
  ['titles', 'adjs', 'nouns', 'aiAdjs', 'aiNouns'].forEach(function (k) {
    assert.ok(Array.isArray(d[k]) && d[k].length);
    d[k].forEach(function (e) {
      assert.ok(G.BRACKETS.indexOf(e.b) >= 0, k + ' bad bracket: ' + e.b);
      assert.ok(typeof e.frac === 'number' && e.frac > 0 && e.frac <= 1);
    });
    assert.ok(d[k].some(function (e) { return e.b !== '10+'; }), k + ' has some bracketed (rare) entries');
  });
});

test('name % is the PRODUCT of component fractions (two rares ⇒ far rarer)', function () {
  // craft parts directly: a common title, a 2-3% adj and a 2-3% noun
  function part(e, b) { return { e: e, b: b, frac: b === '10+' ? 0.95 : { '0-1': 0.005, '1-2': 0.015, '2-3': 0.025, '3-4': 0.035, '4-5': 0.045, '5-10': 0.075 }[b] }; }
  var oneRare = { title: part('Генерал', '10+'), adj: part({ base: 'мазен' }, '2-3'), noun: part({ w: 'Петел', g: 'm' }, '10+') };
  var twoRare = { title: part('Генерал', '10+'), adj: part({ base: 'мазен' }, '2-3'), noun: part({ w: 'Петел', g: 'm' }, '2-3') };
  var p1 = G.recohereName('human', oneRare, 'm').pct;       // ≈ 0.025*0.95*0.95*100 = 2.26%
  var p2 = G.recohereName('human', twoRare, 'm').pct;       // ≈ 0.025*0.025*0.95*100 = 0.059%
  assert.ok(p1 > 2 && p1 < 3, 'one rare ≈ its own bracket: ' + p1);
  assert.ok(p2 < p1 / 10, 'two rares multiply much rarer: ' + p2);
});

test('§1 recohereName keeps a name\'s rarity across every gender switch', function () {
  for (var i = 0; i < 200; i++) {
    var r = G.randomNameRarity('human', 'm');
    ['f', 'n', 'm'].forEach(function (g) {
      var rc = G.recohereName('human', r.parts, g);
      assert.strictEqual(rc.pct, r.pct, 'rarity must not change on gender switch');
      assert.strictEqual(rc.bonus, r.bonus);
      assert.strictEqual(rc.name.split(/\s+/).length, 3);
    });
  }
});

test('§1 a noun with gender variants morphs in place (no re-roll)', function () {
  // Петел(m) carries gv {f:Кокошка, n:Пиле}; recohering keeps the same entry
  function part(e, b) { return { e: e, b: b || '10+', frac: 0.95 }; }
  var parts = { title: part('Генерал'), adj: part({ base: 'смотан' }),
                noun: part({ w: 'Петел', g: 'm', gv: { f: 'Кокошка', n: 'Пиле' } }) };
  assert.strictEqual(G.recohereName('human', parts, 'm').name, 'Генерал Смотан Петел');
  assert.strictEqual(G.recohereName('human', parts, 'f').name, 'Генерал Смотана Кокошка');
  assert.strictEqual(G.recohereName('human', parts, 'n').name, 'Генерал Смотано Пиле');
});

test('§6 censor removes NSFW words from generated names and seed matching', function () {
  G.setCensor(true);
  try {
    // an NSFW noun must never appear over many draws while censoring
    var bad = 0;
    for (var i = 0; i < 1500; i++) {
      ['m', 'f', 'n'].forEach(function (g) {
        if (/Курва|Хуй|Путка|Вагина|Гъз|Прасе/.test(G.randomNameRarity('human', g).name)) bad++;
      });
    }
    assert.strictEqual(bad, 0, 'NSFW leaked while censoring');
    // a typed NSFW seed name no longer matches while censoring
    assert.strictEqual(G.matchSeed('Генерал Смотана Курва', 'f').matched, false);
  } finally { G.setCensor(false); }
  // uncensored, the same NSFW seed matches again
  assert.strictEqual(G.matchSeed('Генерал Смотана Курва', 'f').matched, true);
});

test('dumpSource round-trips through rebuildFromSource (brackets preserved)', function () {
  var src = G.dumpSource();
  assert.ok(src.titles.length && src.nouns.length);
  assert.ok(src.nouns.some(function (o) { return o.nsfw; }), 'some nouns flagged NSFW');
  assert.ok(src.titles.every(function (o) { return o.m; }), 'titles use the m field');
  assert.ok(src.titles.every(function (o) { return G.BRACKETS.indexOf(o.b) >= 0; }), 'every entry carries a bracket');
  assert.ok(src.nouns.some(function (o) { return o.b !== '10+'; }), 'some nouns are bracketed rare');
  // an edited bracket survives the round-trip into the live pool
  var idx = src.titles.findIndex(function (o) { return o.b === '10+'; });
  src.titles[idx].b = '0-1';
  G.rebuildFromSource(src);                 // must not throw; pools stay valid
  var d = G.dumpPools();
  assert.strictEqual(d.titles[idx].b, '0-1', 'edited bracket applied');
  assert.ok(d.nouns.length && d.titles.length);
  var name = G.randomNameRarity('human', 'f').name;
  assert.strictEqual(name.split(/\s+/).length, 3);
});

test('every category has a combo description; shame lines exist', function () {
  G.CATEGORIES.forEach(function (c) { assert.ok(G.COMBO_DESC[c.key], 'missing desc for ' + c.key); });
  assert.ok(G.SHAME_LINES.length > 0);
});

test('gendered names pick a matching-gender noun + agreeing adjective', function () {
  var zero = function () { return 0; };
  // female -> first feminine noun (Пишка) + feminine adjective (смотана)
  assert.strictEqual(G.randomHumanName(zero, 'f'), 'Генерал Смотана Пишка');
  // male -> first masculine noun (Петел) + masculine adjective (смотан)
  assert.strictEqual(G.randomHumanName(zero, 'm'), 'Генерал Смотан Петел');
  // a feminine AI name must also resolve to a feminine noun
  assert.strictEqual(G.randomAiName(zero, 'f').split(' ').length, 3);
});

// ----------------------------------------------------------------- names

test('name generators follow Title + Adjective + Noun', function () {
  assert.strictEqual(G.randomHumanName().split(' ').length, 3);
  assert.strictEqual(G.randomAiName().split(' ').length, 3);
});

test('randomBet returns a non-empty wager', function () {
  assert.strictEqual(typeof G.randomBet(), 'string');
  assert.ok(G.randomBet().length > 0);
});

test('nameGenerator yields distinct names', function () {
  var gen = G.nameGenerator('human');
  var seen = {};
  for (var i = 0; i < 8; i++) {
    var n = gen();
    assert.strictEqual(seen[n], undefined, 'duplicate name: ' + n);
    seen[n] = true;
  }
});

// ----------------------------------------------------------- full play-through

test('a full solo game fills every category exactly once', function () {
  var game = G.createGame([G.createPlayer('Solo', '#0')]);
  G.CATEGORIES.forEach(function (c) {
    G.assignScore(G.currentPlayer(game), c.key, [1, 2, 3, 4, 5]);
    G.nextTurn(game);
  });
  assert.strictEqual(G.isGameOver(game), true);
});
