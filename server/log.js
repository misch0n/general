'use strict';
/*
 * Structured logging — level-filtered, dependency-free.
 *
 * Two formats, one call site: `json` (one object per line, for a collector) and
 * `text` (readable, for a terminal). Config picks the default by TTY.
 *
 * Every record is `{ ts, level, msg, ...fields }`, so the fields a later phase
 * cares about — room code, seat id, message type — are queryable rather than
 * baked into a sentence. Phase 6.1's telemetry is built on these records, so
 * the field names are part of the interface, not decoration.
 *
 * No PII, ever: there are no accounts (Decision D5). Player *names* are
 * free text a stranger typed, so they are not logged by default — a room code
 * and a seat id identify a player well enough to debug a game.
 */

var LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

// JSON.stringify throws on a circular object and silently drops a BigInt; a
// logger must never be the thing that takes the server down.
function safeJson(rec) {
  try {
    return JSON.stringify(rec);
  } catch (e) {
    return JSON.stringify({ ts: rec.ts, level: rec.level, msg: rec.msg, logError: String(e && e.message) });
  }
}

function fmtValue(v) {
  if (v === null || v === undefined) return String(v);
  if (typeof v === 'string') return /[\s"]/.test(v) ? JSON.stringify(v) : v;
  if (typeof v === 'object') return safeJson(v);
  return String(v);
}

function fmtText(rec) {
  var head = rec.ts + ' ' + rec.level.toUpperCase().padEnd(5) + ' ' + rec.msg;
  var tail = Object.keys(rec)
    .filter(function (k) { return k !== 'ts' && k !== 'level' && k !== 'msg'; })
    .map(function (k) { return k + '=' + fmtValue(rec[k]); });
  return tail.length ? head + '  ' + tail.join(' ') : head;
}

/*
 * opts: { level, format, write, now }
 *   write/now are injectable so tests capture output without touching stdout
 *   and without a clock-dependent assertion.
 */
function create(opts) {
  opts = opts || {};
  var level = LEVELS[opts.level] === undefined ? LEVELS.info : LEVELS[opts.level];
  var format = opts.format === 'json' ? 'json' : 'text';
  var write = opts.write || function (line) { process.stdout.write(line + '\n'); };
  var now = opts.now || function () { return new Date().toISOString(); };
  var base = opts.fields || {};

  function emit(name, msg, fields) {
    if (LEVELS[name] < level) return;
    var rec = { ts: now(), level: name, msg: String(msg) };
    Object.keys(base).forEach(function (k) { rec[k] = base[k]; });
    if (fields) {
      Object.keys(fields).forEach(function (k) {
        // An Error in a field would serialize to "{}" — keep the useful parts.
        var v = fields[k];
        rec[k] = (v instanceof Error) ? { name: v.name, message: v.message } : v;
      });
    }
    write(format === 'json' ? safeJson(rec) : fmtText(rec));
  }

  var log = {
    level: opts.level || 'info',
    format: format,
    debug: function (msg, f) { emit('debug', msg, f); },
    info: function (msg, f) { emit('info', msg, f); },
    warn: function (msg, f) { emit('warn', msg, f); },
    error: function (msg, f) { emit('error', msg, f); },
    // A per-room/per-connection logger that stamps its context on every record,
    // so call sites in Phase 2+ don't repeat `{ room: code }` everywhere.
    child: function (fields) {
      var merged = {};
      Object.keys(base).forEach(function (k) { merged[k] = base[k]; });
      Object.keys(fields || {}).forEach(function (k) { merged[k] = fields[k]; });
      return create({ level: opts.level, format: format, write: write, now: now, fields: merged });
    },
  };
  return log;
}

// Convenience: build straight from a config object (server/config.js).
function fromConfig(cfg, opts) {
  opts = opts || {};
  return create({ level: cfg.logLevel, format: cfg.logFormat, write: opts.write, now: opts.now, fields: opts.fields });
}

module.exports = { create: create, fromConfig: fromConfig, LEVELS: LEVELS };
