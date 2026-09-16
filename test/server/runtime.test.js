'use strict';
/*
 * Phase 0.2 — config, structured logging and graceful shutdown.
 *
 * These three are the plumbing every later phase reaches for, so they are
 * tested on their own terms before anything depends on them. The theme running
 * through them: misconfiguration must be LOUD (a bad PORT throws at boot, not
 * a silent default), and neither the logger nor the shutdown path may ever be
 * the thing that takes the server down.
 */

var test = require('node:test');
var assert = require('node:assert');

var config = require('../../server/config.js');
var logging = require('../../server/log.js');
var lifecycle = require('../../server/lifecycle.js');
var index = require('../../server/index.js');

// ===== config

test('config defaults are sane and the object is frozen', function () {
  var cfg = config.load({});
  assert.strictEqual(cfg.port, 8787);
  assert.strictEqual(cfg.logLevel, 'info');
  assert.strictEqual(cfg.maxPlayersPerRoom, 6);   // D4 — matches the app's own maxPlayers
  assert.strictEqual(cfg.maxRooms, 100);          // D4 — conservative, revisit under load
  assert.deepStrictEqual(cfg.allowedOrigins, []);
  assert.strictEqual(Object.isFrozen(cfg), true, 'config must not be mutable at runtime');
});

test('config reads every knob from the environment', function () {
  var cfg = config.load({
    PORT: '9000', HOST: '127.0.0.1', LOG_LEVEL: 'debug', LOG_FORMAT: 'json',
    MAX_PLAYERS_PER_ROOM: '4', MAX_ROOMS: '7', ROOM_IDLE_MS: '60000',
    MAX_FRAME_BYTES: '2048', ALLOWED_ORIGINS: 'https://a.example, null ',
    SHUTDOWN_GRACE_MS: '250',
  });
  assert.strictEqual(cfg.port, 9000);
  assert.strictEqual(cfg.host, '127.0.0.1');
  assert.strictEqual(cfg.logLevel, 'debug');
  assert.strictEqual(cfg.logFormat, 'json');
  assert.strictEqual(cfg.maxPlayersPerRoom, 4);
  assert.strictEqual(cfg.maxRooms, 7);
  assert.strictEqual(cfg.roomIdleMs, 60000);
  assert.strictEqual(cfg.maxFrameBytes, 2048);
  // Trimmed, empties dropped — "null" is a real Origin (a file:// page sends it).
  assert.deepStrictEqual(cfg.allowedOrigins, ['https://a.example', 'null']);
  assert.strictEqual(cfg.shutdownGraceMs, 250);
});

test('bad config throws at boot, naming the variable', function () {
  assert.throws(function () { config.load({ PORT: 'abc' }); }, /config: PORT/);
  assert.throws(function () { config.load({ PORT: '70000' }); }, /0\.\.65535/);
  assert.throws(function () { config.load({ PORT: '-1' }); }, /config: PORT/);
  assert.throws(function () { config.load({ LOG_LEVEL: 'chatty' }); }, /config: LOG_LEVEL.*debug\|info/s);
  assert.throws(function () { config.load({ MAX_ROOMS: '1.5' }); }, /config: MAX_ROOMS/);
  assert.throws(function () { config.load({ HOST: '   ' }); }, /config: HOST/);
});

test('room size cannot exceed what the wire format can address', function () {
  // mp.js's SENDER byte reserves 0 (host) and 15 (unassigned), so seats are
  // 0..14. A config allowing more would mint ids the protocol cannot carry.
  assert.strictEqual(config.PROTOCOL_MAX_SEATS, 15);
  assert.doesNotThrow(function () { config.load({ MAX_PLAYERS_PER_ROOM: '15' }); });
  assert.throws(function () { config.load({ MAX_PLAYERS_PER_ROOM: '16' }); }, /2\.\.15/);
  assert.throws(function () { config.load({ MAX_PLAYERS_PER_ROOM: '1' }); }, /2\.\.15/);
});

test('PORT=0 is valid — "bind any free port", which the test suite relies on', function () {
  assert.strictEqual(config.load({ PORT: '0' }).port, 0);
});

test('an empty env var means "unset", except where empty is meaningful', function () {
  var cfg = config.load({ PORT: '', ALLOWED_ORIGINS: '' });
  assert.strictEqual(cfg.port, 8787, 'PORT="" should fall back, not throw');
  assert.deepStrictEqual(cfg.allowedOrigins, [], 'ALLOWED_ORIGINS="" means no allowlist');
});

test('describe() lists the operator-facing variables (for the runbook)', function () {
  var keys = config.describe().map(function (d) { return d.env; });
  ['PORT', 'HOST', 'LOG_LEVEL', 'MAX_ROOMS', 'MAX_PLAYERS_PER_ROOM', 'SHUTDOWN_GRACE_MS'].forEach(function (k) {
    assert.ok(keys.indexOf(k) >= 0, k + ' missing from describe()');
  });
});

// ===== logging

function capture(opts) {
  var lines = [];
  var log = logging.create(Object.assign({
    write: function (l) { lines.push(l); },
    now: function () { return '2026-01-01T00:00:00.000Z'; },
  }, opts || {}));
  return { log: log, lines: lines };
}

test('json format emits one parseable record per line', function () {
  var c = capture({ format: 'json', level: 'info' });
  c.log.info('room opened', { room: 'ABC123', seats: 2 });
  assert.strictEqual(c.lines.length, 1);
  assert.deepStrictEqual(JSON.parse(c.lines[0]), {
    ts: '2026-01-01T00:00:00.000Z', level: 'info', msg: 'room opened', room: 'ABC123', seats: 2,
  });
});

test('text format is readable and keeps the fields queryable', function () {
  var c = capture({ format: 'text', level: 'info' });
  c.log.warn('seat dropped', { room: 'ABC123', seat: 3 });
  assert.match(c.lines[0], /^2026-01-01T00:00:00\.000Z WARN  seat dropped {2}room=ABC123 seat=3$/);
});

test('levels filter below the configured threshold', function () {
  var c = capture({ format: 'json', level: 'warn' });
  c.log.debug('d'); c.log.info('i'); c.log.warn('w'); c.log.error('e');
  assert.deepStrictEqual(c.lines.map(function (l) { return JSON.parse(l).level; }), ['warn', 'error']);

  var silent = capture({ format: 'json', level: 'silent' });
  silent.log.error('nope');
  assert.strictEqual(silent.lines.length, 0);
});

test('child loggers stamp their context on every record', function () {
  var c = capture({ format: 'json', level: 'info' });
  var room = c.log.child({ room: 'ABC123' });
  room.info('joined', { seat: 1 });
  room.child({ seat: 2 }).info('joined');
  assert.deepStrictEqual(JSON.parse(c.lines[0]).room, 'ABC123');
  assert.deepStrictEqual(JSON.parse(c.lines[1]).seat, 2);
});

test('the logger survives what JSON.stringify cannot', function () {
  // A circular object reaching a log call must not crash the server; an Error
  // field must not serialize to the useless "{}".
  var c = capture({ format: 'json', level: 'info' });
  var circular = { name: 'loop' }; circular.self = circular;
  assert.doesNotThrow(function () { c.log.info('circular', { bad: circular }); });
  assert.ok(JSON.parse(c.lines[0]).logError, 'expected a logError marker instead of a throw');

  c.log.error('boom', { err: new TypeError('bad frame') });
  assert.deepStrictEqual(JSON.parse(c.lines[1]).err, { name: 'TypeError', message: 'bad frame' });
});

test('fromConfig honours logLevel/logFormat', function () {
  var cfg = config.load({ LOG_LEVEL: 'error', LOG_FORMAT: 'json' });
  var lines = [];
  var log = logging.fromConfig(cfg, { write: function (l) { lines.push(l); } });
  log.info('ignored'); log.error('kept');
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(JSON.parse(lines[0]).msg, 'kept');
});

// ===== lifecycle

function lifeHarness(opts) {
  var exits = [];
  var life = lifecycle.create(Object.assign({
    graceMs: 50,
    exit: function (code) { exits.push(code); },
  }, opts || {}));
  return { life: life, exits: exits };
}

test('shutdown drains hooks in reverse registration order', function () {
  // Reverse = unwind the stack: the listener (registered first) stops accepting
  // last-in/first-out relative to the rooms it feeds.
  var h = lifeHarness();
  var order = [];
  h.life.onShutdown('listener', function () { order.push('listener'); });
  h.life.onShutdown('rooms', function () { order.push('rooms'); });
  return h.life.shutdown('test', 0).then(function () {
    assert.deepStrictEqual(order, ['rooms', 'listener']);
    assert.deepStrictEqual(h.exits, [0]);
  });
});

test('shutdown awaits async hooks before exiting', function () {
  var h = lifeHarness();
  var drained = false;
  h.life.onShutdown('slow', function () {
    return new Promise(function (r) { setTimeout(function () { drained = true; r(); }, 10); });
  });
  return h.life.shutdown('test', 0).then(function () {
    assert.strictEqual(drained, true, 'exited before the hook finished');
    assert.deepStrictEqual(h.exits, [0]);
  });
});

test('one broken hook does not strand the rest', function () {
  var h = lifeHarness();
  var ran = [];
  h.life.onShutdown('ok', function () { ran.push('ok'); });
  h.life.onShutdown('broken', function () { throw new Error('nope'); });
  return h.life.shutdown('test', 0).then(function () {
    assert.deepStrictEqual(ran, ['ok'], 'a throwing hook swallowed the remaining drain');
    assert.deepStrictEqual(h.exits, [0]);
  });
});

test('a hook that hangs cannot hold the process hostage', function () {
  var h = lifeHarness({ graceMs: 20 });
  h.life.onShutdown('hangs', function () { return new Promise(function () {}); });
  h.life.shutdown('test', 0);
  return new Promise(function (r) { setTimeout(r, 60); }).then(function () {
    assert.deepStrictEqual(h.exits, [1], 'grace deadline did not force the exit');
  });
});

test('a second signal stops waiting and exits immediately', function () {
  var h = lifeHarness({ graceMs: 1000 });
  h.life.onShutdown('slow', function () { return new Promise(function () {}); });
  h.life.shutdown('SIGTERM', 0);
  assert.strictEqual(h.life.shuttingDown, true);
  h.life.shutdown('SIGINT', 0);
  assert.deepStrictEqual(h.exits, [0], 'impatient second signal should exit at once');
});

test('signal handlers install and uninstall without leaking', function () {
  var h = lifeHarness();
  var handlers = {};
  var fakeProc = {
    on: function (sig, fn) { (handlers[sig] = handlers[sig] || []).push(fn); },
    removeListener: function (sig, fn) { handlers[sig] = handlers[sig].filter(function (f) { return f !== fn; }); },
  };
  var uninstall = h.life.installSignalHandlers(fakeProc);
  assert.strictEqual(handlers.SIGTERM.length, 1);
  assert.strictEqual(handlers.SIGINT.length, 1);
  uninstall();
  assert.strictEqual(handlers.SIGTERM.length, 0);
  assert.strictEqual(handlers.SIGINT.length, 0);
});

test('unregistering a hook removes it', function () {
  var h = lifeHarness();
  var remove = h.life.onShutdown('temp', function () {});
  assert.strictEqual(h.life.hookCount, 1);
  remove();
  assert.strictEqual(h.life.hookCount, 0);
});

// ===== boot

test('boot() wires config + logger + lifecycle and logs a banner', function () {
  var lines = [];
  var app = index.boot({
    env: { LOG_FORMAT: 'json', PORT: '9111', MAX_ROOMS: '3' },
    write: function (l) { lines.push(l); },
    now: function () { return '2026-01-01T00:00:00.000Z'; },
    exit: function () {},
  });
  assert.strictEqual(app.cfg.port, 9111);
  assert.strictEqual(app.life.shuttingDown, false);

  var rec = JSON.parse(lines[lines.length - 1]);
  assert.match(rec.msg, /booted/);
  assert.strictEqual(rec.port, 9111);
  assert.strictEqual(rec.maxRooms, 3);
  assert.strictEqual(rec.diceRng, 'webcrypto');
  assert.match(rec.engine, /GReduce←reduce\.js/);
  // boot() opens a room whether or not this test uses it, and its session
  // re-arms a beacon for as long as it is open.
  app.room.close('test over');
});

test('boot() refuses to start on bad config', function () {
  assert.throws(function () { index.boot({ env: { PORT: 'nope' }, write: function () {} }); }, /config: PORT/);
});
