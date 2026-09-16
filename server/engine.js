'use strict';
/*
 * Server-side binding of the game's PURE modules — the single source of truth
 * for the rules, shared verbatim with the browser.
 *
 * The browser loads game.js / exp.js / reduce.js / mp.js as classic <script>
 * globals (G / X / GReduce / MP) via features/core/core.js. Node loads the exact
 * same files through their UMD `module.exports` branch. This module is the
 * server's counterpart to core.js's "binds G/EV/X" role: ONE place that requires
 * them, ONE place that states which parts of their surface the server depends
 * on, and ONE place to fix if the layout ever moves.
 *
 * Deliberately NOT re-implementing anything: scoring, the turn reducer and the
 * wire codecs must be byte-identical between server and client, otherwise the
 * authoritative server and the clients it referees can disagree about a game.
 *
 * Node-only CommonJS (no UMD): `server/` never runs in a browser, so the
 * file://-safety rules in root CLAUDE.md do not apply here — but they DO still
 * apply to every file this one requires, which is why only the four DOM-free
 * root modules are listed. features/** is browser-only and out of bounds.
 */

var G = require('../game.js');
var X = require('../exp.js');
var GReduce = require('../reduce.js');
var MP = require('../mp.js');

// ===== CONTRACT
// The exact exports the server leans on, per module. This is documentation that
// fails a test when it drifts: if a refactor renames or drops one of these, the
// server's self-test names the casualty instead of the server crashing at
// runtime, mid-game, on someone's turn.
var CONTRACT = {
  // dice + scoring + AI + the game/player factories
  G: ['DICE_COUNT', 'MAX_ROLLS', 'SCORING', 'CATEGORIES', 'CATEGORIES_EXP', 'RULESETS',
      'rollDie', 'rollAll', 'reroll',
      'scoreFor', 'scoreForExp', 'candidates', 'assignScore',
      'createGame', 'createPlayer', 'currentPlayer', 'nextTurn', 'isGameOver', 'ranking',
      'aiChooseHolds', 'aiChooseCategory'],
  // experimental ruleset: free-order card flow + its AI
  X: ['KEYS', 'REROLLS', 'availableKeys', 'canPlay', 'createGame', 'createPlayerCard',
      'currentPlayer', 'assignScore', 'total', 'nextTurn', 'isGameOver', 'ranking',
      'aiKeeps', 'aiChooseKey'],
  // the pure turn reducer the server drives as the imperative shell
  GReduce: ['reduce', 'freshTurn', 'ROLLS', 'DICE_COUNT'],
  // L1 framing, the session state machine, and the game payload codecs
  MP: ['T', 'HOST_ID', 'frame', 'unframe', 'Session',
       'packMove', 'unpackMove', 'packStateDelta', 'packStateSnapshot', 'unpackState',
       'packJoinReq', 'unpackJoinReq', 'packJoinAck', 'unpackJoinAck',
       'packRoster', 'unpackRoster', 'packGrant', 'unpackGrant', 'sanitizeRecord'],
};

var MODULES = { G: G, X: X, GReduce: GReduce, MP: MP };

// The four files behind the four globals, for the health line / diagnostics.
var SOURCES = { G: 'game.js', X: 'exp.js', GReduce: 'reduce.js', MP: 'mp.js' };

// ===== SELF-TEST

// A seedable rng in the shape G.rollDie(rng) wants: () => float in [0,1).
// Used only to make the smoke deterministic; real play uses the default
// crypto-backed path (see cryptoRngAvailable below).
function seededRng(seed) {
  var s = seed >>> 0;
  return function () {
    // xorshift32 — tiny, dependency-free, and good enough for a fixture.
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

// Does game.js's default (rng-less) roll path find Web Crypto under Node? It
// matters: Phase 3 makes the server the sole roller, and a silent fallback to
// Math.random would make the authoritative dice predictable.
function cryptoRngAvailable() {
  return !!(typeof globalThis !== 'undefined' && globalThis.crypto &&
            typeof globalThis.crypto.getRandomValues === 'function');
}

// Check every CONTRACT entry actually exists on its module.
function missingExports() {
  var missing = [];
  Object.keys(CONTRACT).forEach(function (mod) {
    var m = MODULES[mod];
    if (!m || typeof m !== 'object') { missing.push(mod + ' (module did not load)'); return; }
    CONTRACT[mod].forEach(function (name) {
      if (typeof m[name] === 'undefined') missing.push(mod + '.' + name);
    });
  });
  return missing;
}

// Beyond "it loads": actually exercise one path per module, because a module
// that requires cleanly can still be unusable server-side (a DOM reference in a
// hot path, a browser-only global at call time).
function smoke() {
  var problems = [];

  function check(what, fn) {
    try { var why = fn(); if (why) problems.push(what + ': ' + why); }
    catch (e) { problems.push(what + ' threw: ' + (e && e.message ? e.message : String(e))); }
  }

  check('G.rollAll(rng)', function () {
    var dice = G.rollAll(seededRng(1));
    if (dice.length !== G.DICE_COUNT) return 'rolled ' + dice.length + ' dice, want ' + G.DICE_COUNT;
    var bad = dice.filter(function (d) { return !(d >= 1 && d <= 6 && d === (d | 0)); });
    if (bad.length) return 'non-die faces ' + JSON.stringify(dice);
    // same seed ⇒ same hand: the server can replay/derive rolls in tests.
    if (String(G.rollAll(seededRng(1))) !== String(dice)) return 'not deterministic under a seeded rng';
  });

  check('G.rollDie() crypto path', function () {
    if (!cryptoRngAvailable()) return 'globalThis.crypto.getRandomValues missing — rolls would fall back to Math.random';
    var d = G.rollDie();
    if (!(d >= 1 && d <= 6)) return 'face out of range: ' + d;
  });

  check('G.scoreFor', function () {
    // генерал = the dice total plus a fixed bonus (5×4 + 50 = 70).
    var want = 20 + G.SCORING.generalBonus;
    var s = G.scoreFor('general', [4, 4, 4, 4, 4]);
    if (s !== want) return 'five-of-a-kind scored ' + s + ', want ' + want;
  });

  check('X (experimental) card', function () {
    var g = X.createGame([G.createPlayer('А', '#f00', false)]);
    if (g.ruleset !== 'experimental') return 'createGame did not tag the ruleset';
    if (X.availableKeys(g.players[0]).length !== X.KEYS.length) return 'a fresh card is not fully open';
  });

  check('GReduce.reduce turn flow', function () {
    var st = { turn: GReduce.freshTurn() };
    st = GReduce.reduce(st, { type: 'BEGIN_TURN', mode: 'dice' });
    if (!st.turn.awaitingRoll) return 'BEGIN_TURN did not arm the first throw';
    st = GReduce.reduce(st, { type: 'FIRST_ROLL', dice: [1, 2, 3, 4, 5] });
    if (st.turn.rollNo !== 1 || st.turn.dice.length !== 5) return 'FIRST_ROLL did not land the faces';
  });

  check('MP framing round-trip', function () {
    var payload = new Uint8Array([7, 8, 9]);
    var f = MP.unframe(MP.frame(MP.T.PING, MP.HOST_ID, 3, payload));
    if (!f) return 'unframe rejected a frame we just built';
    if (f.type !== MP.T.PING || f.sender !== MP.HOST_ID || f.seq !== 3) return 'header did not survive the round-trip';
    if (String(f.payload) !== String(payload)) return 'payload did not survive the round-trip';
  });

  check('MP.Session constructible', function () {
    // The server hosts one of these per room (Phase 1). Proving it constructs
    // and disposes under Node — with a stub transport — is the whole point of
    // the "host Session, don't rewrite it" bet.
    var sent = [];
    var session = new MP.Session({
      transport: { send: function (b) { sent.push(b); return Promise.resolve(); }, onReceive: function () {} },
      isHost: true, me: { name: 'СЪРВЪР', color: '#000' },
    });
    if (typeof session.dispose !== 'function') return 'Session has no dispose() — rooms could not be torn down';
    session.dispose();
  });

  return problems;
}

// Full report: which modules bound, and everything that is wrong (empty = ready).
function selfTest() {
  var problems = missingExports().map(function (n) { return 'missing export: ' + n; });
  if (!problems.length) problems = problems.concat(smoke());
  return {
    ok: problems.length === 0,
    modules: Object.keys(MODULES).map(function (k) { return { global: k, source: SOURCES[k] }; }),
    cryptoRng: cryptoRngAvailable(),
    problems: problems,
  };
}

// Fail fast at boot rather than mid-game: a server running different rules from
// its clients is worse than a server that refuses to start.
function assertReady() {
  var r = selfTest();
  if (!r.ok) throw new Error('shared engine not usable server-side:\n  - ' + r.problems.join('\n  - '));
  return r;
}

module.exports = {
  G: G, X: X, GReduce: GReduce, MP: MP,
  CONTRACT: CONTRACT, SOURCES: SOURCES,
  seededRng: seededRng, cryptoRngAvailable: cryptoRngAvailable,
  selfTest: selfTest, assertReady: assertReady,
};
