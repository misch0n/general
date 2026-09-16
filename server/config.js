'use strict';
/*
 * Server configuration — environment in, frozen validated object out.
 *
 * Everything the server can be tuned with lives here, in one table, so a later
 * phase never has to reach for `process.env` inline. Two rules:
 *
 *  1. NO SECRETS IN THE REPO (Phase 5.3). Defaults here are operational knobs
 *     (ports, caps, timeouts) — never credentials. Anything secret arrives via
 *     env and has no default.
 *  2. BAD CONFIG FAILS LOUDLY. An unparsable PORT or an out-of-range room cap
 *     throws at boot, naming the variable. Silently falling back to a default
 *     hides a misconfigured deploy until it matters.
 *
 * Node-only CommonJS (server/ never runs in a browser).
 */

// ===== PROTOCOL-IMPOSED LIMITS
// Not preferences — mp.js's framing dictates these, so config must not exceed
// them. The frame's SENDER byte uses 0 for the host and 15 for a not-yet-seated
// client (mp.js:24 `HOST_ID = 0, UNASSIGNED = 15`), leaving ids 0..14 usable:
// at most 15 seats in a room, whatever an operator asks for.
var PROTOCOL_MAX_SEATS = 15;

// ===== SPEC
// name → { env, default, parse }. `parse` throws a plain message; the caller
// prefixes it with the variable name so errors read
// "config: PORT — expected an integer in 1..65535, got 'abc'".
function int(min, max) {
  return function (raw) {
    var n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) {
      throw new Error('expected an integer in ' + min + '..' + max + ", got '" + raw + "'");
    }
    return n;
  };
}

function oneOf(allowed) {
  return function (raw) {
    if (allowed.indexOf(raw) < 0) throw new Error('expected one of ' + allowed.join('|') + ", got '" + raw + "'");
    return raw;
  };
}

function nonEmpty(raw) {
  var s = String(raw).trim();
  if (!s) throw new Error('must not be empty');
  return s;
}

// Comma-separated allowlist. Empty string is meaningful (= "no allowlist"), so
// it is NOT an error here — unlike an empty host.
function csv(raw) {
  return String(raw).split(',').map(function (s) { return s.trim(); }).filter(Boolean);
}

var SPEC = {
  // --- listener (Phase 0.3) ---
  // 0 is allowed and meaningful: "bind any free port". The test suite relies on
  // it so runs never collide with a dev server or with each other.
  port: { env: 'PORT', def: 8787, parse: int(0, 65535) },
  host: { env: 'HOST', def: '0.0.0.0', parse: nonEmpty },

  // --- logging (below) ---
  logLevel: { env: 'LOG_LEVEL', def: 'info', parse: oneOf(['debug', 'info', 'warn', 'error', 'silent']) },
  // Default chosen at read time: a terminal gets readable lines, a log collector
  // gets JSON. Explicit LOG_FORMAT always wins.
  logFormat: { env: 'LOG_FORMAT', def: null, parse: oneOf(['text', 'json']) },

  // --- room limits (Decision D4) ---
  // 6 matches the app's own maxPlayers (mp.js Session default) — the number the
  // board and the UI are built for. The protocol would allow up to 15.
  maxPlayersPerRoom: { env: 'MAX_PLAYERS_PER_ROOM', def: 6, parse: int(2, PROTOCOL_MAX_SEATS) },
  // Conservative global cap; D4 says revisit under load (Phase 8.2).
  maxRooms: { env: 'MAX_ROOMS', def: 100, parse: int(1, 100000) },
  // Rooms are in-memory only (Decision D6), so an abandoned one is pure leak
  // until it expires. Consumed by Phase 2.3's GC.
  roomIdleMs: { env: 'ROOM_IDLE_MS', def: 15 * 60 * 1000, parse: int(1000, 24 * 60 * 60 * 1000) },

  // --- hardening (Phase 5.2; enforced there, configured here) ---
  // A frame is a few hundred bytes; a state snapshot is the big one. 64 KiB is
  // roomy for the codecs and still refuses a client trying to exhaust memory.
  maxFrameBytes: { env: 'MAX_FRAME_BYTES', def: 64 * 1024, parse: int(64, 4 * 1024 * 1024) },
  // Empty = accept any Origin. A file:// page sends `Origin: null`, and the
  // game is meant to run from a double-clicked index.html, so an allowlist that
  // forgets "null" would lock out the primary client. Phase 5.2 owns that.
  allowedOrigins: { env: 'ALLOWED_ORIGINS', def: [], parse: csv },

  // --- lifecycle ---
  // How long SIGTERM waits for rooms to drain before forcing exit.
  shutdownGraceMs: { env: 'SHUTDOWN_GRACE_MS', def: 10000, parse: int(0, 5 * 60 * 1000) },
};

// ===== LOAD

function load(env) {
  env = env || process.env;
  var cfg = {};

  Object.keys(SPEC).forEach(function (key) {
    var s = SPEC[key];
    var raw = env[s.env];
    if (raw === undefined || raw === '') {
      // An explicitly empty value means "unset" for every knob except the ones
      // whose parser treats empty as meaningful (allowedOrigins).
      if (raw === '' && s.parse === csv) { cfg[key] = []; return; }
      cfg[key] = s.def;
      return;
    }
    try {
      cfg[key] = s.parse(raw);
    } catch (e) {
      throw new Error('config: ' + s.env + ' — ' + e.message);
    }
  });

  if (cfg.logFormat === null) cfg.logFormat = process.stdout.isTTY ? 'text' : 'json';

  return Object.freeze(cfg);
}

// Which variables an operator can set, for the runbook (Phase 6.2) and for
// tests that assert the table and the docs have not drifted apart.
function describe() {
  return Object.keys(SPEC).map(function (key) {
    return { key: key, env: SPEC[key].env, def: SPEC[key].def };
  });
}

module.exports = { load: load, describe: describe, PROTOCOL_MAX_SEATS: PROTOCOL_MAX_SEATS };
