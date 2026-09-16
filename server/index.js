'use strict';
/*
 * Генерал — authoritative multiplayer server, entrypoint.
 *
 * See docs/backend/README.md for the architecture and docs/backend/PLAN.md for
 * the phase plan. In short: this process will host one MP.Session per room over
 * a WebSocket transport, and — from Phase 3 — own the dice and the scoring, so a
 * client can no longer declare its own result.
 *
 * Current scope (Phase 1.2): boot, config, structured logging, graceful
 * shutdown, an HTTP/WS listener, and ONE room hosting a real MP.Session that
 * every accepted socket joins. Rooms are still singular and codeless (Phase 2
 * makes a registry of them), and the dice are still client-declared (Phase 3).
 *
 * Run: `node server/index.js`   (Ctrl-C / SIGTERM drains and exits 0)
 */

var engine = require('./engine.js');
var config = require('./config.js');
var logging = require('./log.js');
var lifecycle = require('./lifecycle.js');
var listener = require('./listener.js');
var room = require('./room.js');

// The boot banner, as fields rather than prose: it is the first thing an
// operator reads and the first thing Phase 6.1's telemetry ingests.
function bootFields(cfg, report) {
  return {
    node: process.version,
    platform: process.platform + '/' + process.arch,
    port: cfg.port,
    host: cfg.host,
    maxRooms: cfg.maxRooms,
    maxPlayersPerRoom: cfg.maxPlayersPerRoom,
    engine: report.modules.map(function (m) { return m.global + '←' + m.source; }).join(' '),
    // Phase 3 makes the server the sole roller; a Math.random fallback would
    // make the authoritative dice predictable, so it is boot-visible.
    diceRng: report.cryptoRng ? 'webcrypto' : 'math.random',
  };
}

/*
 * Wire everything up WITHOUT binding the port — `app.listener.start()` does
 * that. Splitting the two lets tests boot the whole runtime, or start a
 * listener on port 0, without a process and without a fixed port.
 * opts: { env, write, now, exit, onConnection, stats } — all injectable.
 */
function boot(opts) {
  opts = opts || {};
  var cfg = config.load(opts.env);
  var log = logging.fromConfig(cfg, { write: opts.write, now: opts.now });

  // Refuse to start on mismatched rules rather than referee a game wrong.
  var report = engine.assertReady();

  var life = lifecycle.create({ log: log, graceMs: cfg.shutdownGraceMs, exit: opts.exit });

  if (!report.cryptoRng) {
    log.warn('Web Crypto unavailable — dice would fall back to Math.random', { diceRng: 'math.random' });
  }

  // ONE room for now, open from boot. Phase 2.1 replaces this with a registry
  // that mints a join code per room and routes each socket to the right one.
  var only = room.create({ cfg: cfg, log: log });

  // The listener registers its own drain hook with `life`, so shutdown closes
  // sockets and the port without index.js orchestrating it.
  var lis = listener.create({
    cfg: cfg, log: log, life: life,
    // Every accepted socket joins the room. A refusal means the room is closing
    // (or the socket already died), and the listener hands us no ownership of a
    // socket it was refused — so we close it rather than leave it hanging on a
    // server that will never answer it.
    onConnection: opts.onConnection || function (conn) {
      if (!only.join(conn)) conn.close(1013, 'room unavailable');
    },
    stats: opts.stats || function () { return { rooms: 1, room: only.stats() }; },
  });

  /*
   * Registered AFTER the listener, and hooks unwind in REVERSE order, so this
   * one drains FIRST: stop accepting new players, tell the ones in the room
   * (BYE) and close their sockets with a reason — and only then does the
   * listener take the port away. The other order would yank the connections
   * before the goodbye could reach them.
   */
  life.onShutdown('rooms', function () {
    lis.beginDrain();
    only.close('server shutting down');
  });

  log.info('Генерал server booted (Phase 1.2 — one room, client-declared dice)', bootFields(cfg, report));

  return { cfg: cfg, log: log, life: life, listener: lis, room: only, engine: engine, report: report };
}

function main() {
  var app;
  try {
    app = boot();
  } catch (e) {
    // Config and engine failures happen before the logger is trustworthy, so
    // they go to stderr plainly.
    process.stderr.write(String(e && e.message ? e.message : e) + '\n');
    process.exitCode = 1;
    return null;
  }
  app.life.installSignalHandlers();
  app.listener.start().catch(function (e) {
    app.log.error('could not listen', { port: app.cfg.port, host: app.cfg.host, err: e });
    process.exitCode = 1;
  });
  return app;
}

if (require.main === module) main();

module.exports = { boot: boot, main: main, bootFields: bootFields };
