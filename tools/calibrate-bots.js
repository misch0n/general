'use strict';
/* Calibrate softmax temperature τ ↔ strength for the persona ladder.
   strength = (S_policy - S_random) / (par - S_random) ∈ [0,1].
   Run: node tools/calibrate-bots.js   (offline; informs the τ presets) */
var General = require('../game.js');
var EV = require('../engine.js');
EV.setTable(require('../ev-table.js').V);

function rollN(n) { var d = []; for (var i = 0; i < n; i++) d.push(1 + Math.floor(Math.random() * 6)); return d; }
function sortd(d) { return d.slice().sort(function (a, b) { return a - b; }); }

function playGame(decide) {
  var scores = {}, total = 0;
  for (var t = 0; t < EV.NCAT; t++) {
    var dice = sortd(rollN(5));
    for (var rl = 2; rl > 0; rl--) {
      var keep = decide.keep(scores, dice, rl);
      dice = sortd(dice.map(function (v, i) { return keep[i] ? v : 1 + Math.floor(Math.random() * 6); }));
    }
    var cat = decide.cat(scores, dice);
    var got = General.scoreFor(cat, dice);
    scores[cat] = got; total += got;
  }
  return total;
}
function meanOf(decide, N) { var s = 0; for (var i = 0; i < N; i++) s += playGame(decide); return s / N; }

var N = 4000;
var randomPolicy = {
  keep: function () { return [0, 1, 2, 3, 4].map(function () { return Math.random() < 0.5; }); },
  cat: function (scores, dice) {
    var open = EV.CATS.filter(function (c) { return typeof scores[c.key] !== 'number'; });
    return open[Math.floor(Math.random() * open.length)].key;
  },
};
function softmaxPolicy(tau) {
  return {
    keep: function (s, d, rl) { return EV.botKeep(s, d, rl, { type: 'softmax', tau: tau }); },
    cat: function (s, d) { return EV.botCategory(s, d, { type: 'softmax', tau: tau }); },
  };
}
function riskPolicy() {
  return {
    keep: function (s, d, rl) { return EV.botKeep(s, d, rl, { type: 'risk', tau: 2, lambda: 1.4 }); },
    cat: function (s, d) { return EV.botCategory(s, d, { type: 'risk', tau: 2, lambda: 1.4 }); },
  };
}

var Srandom = meanOf(randomPolicy, N);
var par = EV.par();
console.log('par =', par.toFixed(2), ' S_random =', Srandom.toFixed(2));
function strength(S) { return (S - Srandom) / (par - Srandom); }

[0.5, 1, 2, 3, 5, 8, 15, 30, 60].forEach(function (tau) {
  var S = meanOf(softmaxPolicy(tau), N);
  console.log('softmax τ=' + tau + '\tmean=' + S.toFixed(1) + '\tstrength=' + (100 * strength(S)).toFixed(0) + '%');
});
var Sr = meanOf(riskPolicy(), N);
console.log('risk(τ=2,λ=1.4)\tmean=' + Sr.toFixed(1) + '\tstrength=' + (100 * strength(Sr)).toFixed(0) + '%');
var So = meanOf(softmaxPolicy(0), N);
console.log('optimal τ=0\tmean=' + So.toFixed(1) + '\tstrength=' + (100 * strength(So)).toFixed(0) + '%');
