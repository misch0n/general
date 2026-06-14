'use strict';
/*
 * EXACT optimal-value solver for a FREE experimental column, tracking the upper
 * (number-part) subtotal in the state so the −50 penalty is handled exactly
 * (the canonical Yahtzee (mask, upper-score) approach).
 *
 *   state = (mask, up) while the number part is INCOMPLETE; once complete the
 *   penalty is already realised, so the remaining lower sub-game is exactly the
 *   penalty-free table W*[mask] (ev-table-exp.js) — a big shortcut.
 *
 * Run:        node tools/build-ev-exp-exact.js          (verify + time estimate)
 *   full:     node tools/build-ev-exp-exact.js --full   (compute whole table)
 *
 * Reuses engine.js's reroll DP primitives (MULTISETS / KEEPS / dot / ROLL_PROB)
 * via the experimental engine instance.
 */
var fs = require('fs');
var path = require('path');
var G = require('../game.js');
var EV = require('../engine.js');

var shim = {
  DICE_COUNT: G.DICE_COUNT, MAX_ROLLS: G.MAX_ROLLS,
  CATEGORIES: G.CATEGORIES_EXP, scoreFor: G.scoreForExp,
  aiChooseHolds: G.aiChooseHolds,
  aiChooseCategory: function (p, d) { return { category: 'chance', value: 0 }; },
};
var EVX = EV.create(shim);
var NMS = EVX.NMS, NCAT = EVX.NCAT, MULTISETS = EVX.MULTISETS, KEEPS = EVX.KEEPS, dot = EVX.dot, ROLL_PROB = EVX.ROLL_PROB;
var CATS = G.CATEGORIES_EXP, KEYS = CATS.map(function (c) { return c.key; });
var W = require('../ev-table-exp.js').V;           // penalty-free table (upper-complete masks)
var PEN = G.UPPER_PENALTY;                          // −50

var UPPER_BITS = 0;
for (var i = 0; i < NCAT; i++) if (G.UPPER_KEYS.indexOf(KEYS[i]) >= 0) UPPER_BITS |= (1 << i);
function upperComplete(mask) { return (mask & UPPER_BITS) === UPPER_BITS; }
function faceOf(idx) { return G.UPPER_KEYS.indexOf(KEYS[idx]) + 1; }   // 1..6 for upper cats, else 0
function sumFilledUpperFaces(mask) { var s = 0; for (var i = 0; i < NCAT; i++) if ((mask & (1 << i)) && faceOf(i) > 0) s += faceOf(i); return s; }

// reroll DP stages (reimplemented from engine internals, up-agnostic transitions)
function stageUp(prev) {
  var out = new Float64Array(NMS);
  for (var d = 0; d < NMS; d++) { var ks = KEEPS[d], best = -Infinity; for (var k = 0; k < ks.length; k++) { var e = dot(ks[k], prev); if (e > best) best = e; } out[d] = best; }
  return out;
}
function expectRoll(vec) { var s = 0; for (var d = 0; d < NMS; d++) s += ROLL_PROB[d] * vec[d]; return s; }

// V table: mask -> { lo, arr } for incomplete-upper masks (arr indexed by up-lo)
var V = new Array(1 << NCAT);
var computed = 0;
function Vget(mask, up) {
  if (upperComplete(mask)) return W[mask];          // penalty already applied at the completing transition
  var rec = V[mask]; if (!rec) { computeMask(mask); rec = V[mask]; }   // lazy top-down (children have higher popcount → no cycle)
  return rec.arr[up - rec.lo];
}
// value of state (mask, up): one optimal turn (3 throws) then commit
function valueOfState(mask, up) {
  var v0 = new Float64Array(NMS);
  for (var d = 0; d < NMS; d++) {
    var dice = MULTISETS[d], best = -Infinity;
    for (var i = 0; i < NCAT; i++) {
      if (mask & (1 << i)) continue;
      var imm = G.scoreForExp(KEYS[i], dice), child = mask | (1 << i), cont;
      if (faceOf(i) > 0) {                          // upper cell: imm IS the deviation, up advances
        var nu = up + imm;
        if (upperComplete(child)) cont = W[child] + (nu < 0 ? PEN : 0);  // realise the penalty here
        else cont = Vget(child, nu);
      } else {                                       // lower cell: up unchanged, upper still incomplete
        cont = Vget(child, up);
      }
      var val = imm + cont; if (val > best) best = val;
    }
    v0[d] = best;
  }
  return expectRoll(stageUp(stageUp(v0)));
}

function computeMask(mask) {
  var S = sumFilledUpperFaces(mask), lo = -3 * S, hi = 2 * S;
  var arr = new Float64Array(hi - lo + 1);
  for (var up = lo; up <= hi; up++) arr[up - lo] = valueOfState(mask, up);
  V[mask] = { lo: lo, arr: arr }; computed++;
}

// ---- order masks by popcount descending (terminal first) ----
function popcount(x) { var c = 0; while (x) { x &= x - 1; c++; } return c; }
var incomplete = [];
for (var m = 0; m < (1 << NCAT); m++) if (!upperComplete(m)) incomplete.push(m);
incomplete.sort(function (a, b) { return popcount(b) - popcount(a); });

// ================= VERIFY the DP logic on terminal states (no full build needed) =================
function verify() {
  // a state with exactly ONE empty cell, which is an UPPER face: value must equal
  // E_dice[ best-of-3-throws of (dev + penalty(up+dev)) ].  Compare solver vs a
  // direct brute-force of that single-category turn.
  var upIdx = 0; while (faceOf(upIdx) === 0) upIdx++;     // first upper category index
  var f = faceOf(upIdx);
  var mask = ((1 << NCAT) - 1) & ~(1 << upIdx);           // everything filled except this upper cell
  // its upper subtotal is the sum of the OTHER five upper deviations — pick a test up
  var tests = [-5, 0, 3, -12];
  computeMask(mask);
  var ok = true;
  tests.forEach(function (up) {
    if (up < V[mask].lo || up > V[mask].lo + V[mask].arr.length - 1) return;
    // brute force: terminal value of dice d = dev + (up+dev<0?PEN:0) + W[full] (=0)
    var term = new Float64Array(NMS);
    for (var d = 0; d < NMS; d++) { var dev = G.scoreForExp(KEYS[upIdx], MULTISETS[d]); term[d] = dev + (up + dev < 0 ? PEN : 0); }
    var brute = expectRoll(stageUp(stageUp(term)));
    var got = Vget(mask, up);
    var match = Math.abs(brute - got) < 1e-6;
    if (!match) ok = false;
    console.log('  up=' + up + '  solver=' + got.toFixed(4) + '  brute=' + brute.toFixed(4) + '  ' + (match ? 'OK' : 'MISMATCH'));
  });
  // two-empty-cells (one upper + one lower) vs independent expectimax
  var lowIdx = 0; while (faceOf(lowIdx) > 0) lowIdx++;    // first lower category
  var mask2 = ((1 << NCAT) - 1) & ~(1 << upIdx) & ~(1 << lowIdx);
  computeMask(mask2);
  var up2 = Math.max(V[mask2].lo, Math.min(0, V[mask2].lo + V[mask2].arr.length - 1));
  var brute2 = (function () {
    var term = new Float64Array(NMS);
    for (var d = 0; d < NMS; d++) {
      var dice = MULTISETS[d];
      var devU = G.scoreForExp(KEYS[upIdx], dice), uChild = up2 + devU;
      var valU = devU + (uChild < 0 ? PEN : 0) + W[(1 << NCAT) - 1 & ~(1 << lowIdx)];   // fill upper → complete, then lower-only W
      var sL = G.scoreForExp(KEYS[lowIdx], dice);
      var valL = sL + Vget(((1 << NCAT) - 1) & ~(1 << upIdx), up2);                       // fill lower → still 1 upper left
      term[d] = Math.max(valU, valL);
    }
    return expectRoll(stageUp(stageUp(term)));
  })();
  var got2 = Vget(mask2, up2);
  var m2 = Math.abs(brute2 - got2) < 1e-6;
  console.log('  2-cell  up=' + up2 + '  solver=' + got2.toFixed(4) + '  brute=' + brute2.toFixed(4) + '  ' + (m2 ? 'OK' : 'MISMATCH'));
  return ok && m2;
}

console.log('Verifying exact DP on terminal states…');
var passed = verify();
console.log('verification: ' + (passed ? 'PASS' : 'FAIL'));

// quick timing probe: lazily build the subtree under a few mid-popcount masks and
// measure per-mask cost from the number of masks ACTUALLY computed (memoised).
var c0 = computed, t0 = Date.now();
incomplete.filter(function (m) { return popcount(m) === 10; }).slice(0, 40).forEach(function (m) { if (!V[m]) Vget(m, 0); });
var dn = computed - c0, per = (Date.now() - t0) / Math.max(1, dn);
console.log('timing: ' + per.toFixed(3) + ' ms/mask over ' + dn + ' masks computed; est. full build ≈ ' + (per * incomplete.length / 1000 / 60).toFixed(1) + ' min over ' + incomplete.length.toLocaleString() + ' masks');

if (!passed) process.exit(1);
if (process.argv.indexOf('--full') < 0) { console.log('\n(verify+probe only — pass --full to build the whole table)'); process.exit(0); }

// ================= full build =================
console.log('\nBuilding full exact table… (' + incomplete.length.toLocaleString() + ' masks; ascending popcount so children land first)');
var bt0 = Date.now();
// ascending popcount with lazy Vget would still recurse fine, but iterate descending
// so every child is ready before its parent and no deep recursion is needed.
for (var j = 0; j < incomplete.length; j++) {
  if (!V[incomplete[j]]) computeMask(incomplete[j]);
  if ((j % 2000) === 0) process.stdout.write('. (' + j + '/' + incomplete.length + ' ' + ((Date.now() - bt0) / 60000).toFixed(1) + 'm)\n');
}
var par = Vget(0, 0);
console.log('exact free-column par V*(0,0) = ' + par.toFixed(4) + '  in ' + ((Date.now() - bt0) / 1000 / 60).toFixed(1) + ' min');

// ---- serialize to a compact binary: [u32 count] then per entry u32 mask, i16 lo, u16 len, len×f32 ----
var entries = [];
var totalVals = 0;
for (var mm = 0; mm < (1 << NCAT); mm++) { if (V[mm]) { entries.push(mm); totalVals += V[mm].arr.length; } }
var buf = Buffer.alloc(4 + entries.length * 8 + totalVals * 4);
var off = 0; buf.writeUInt32LE(entries.length, off); off += 4;
entries.forEach(function (mm) {
  var rec = V[mm];
  buf.writeUInt32LE(mm, off); off += 4;
  buf.writeInt16LE(rec.lo, off); off += 2;
  buf.writeUInt16LE(rec.arr.length, off); off += 2;
  for (var t = 0; t < rec.arr.length; t++) { buf.writeFloatLE(rec.arr[t], off); off += 4; }
});
var binPath = path.join(__dirname, '..', 'ev-exp-exact.bin');
fs.writeFileSync(binPath, buf);
fs.writeFileSync(path.join(__dirname, '..', 'ev-exp-exact.meta.json'),
  JSON.stringify({ par: par, entries: entries.length, values: totalVals, bytes: buf.length, ncat: NCAT }, null, 2));
console.log('wrote ' + binPath + ' (' + (buf.length / 1e6).toFixed(1) + ' MB, ' + entries.length.toLocaleString() + ' masks, ' + totalVals.toLocaleString() + ' values)');
