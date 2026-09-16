'use strict';
/*
 * Генерал — authoritative multiplayer server, entrypoint.
 *
 * See docs/backend/README.md for the architecture and docs/backend/PLAN.md for
 * the phase plan. In short: this process will host one MP.Session per room over
 * a WebSocket transport, and — from Phase 3 — own the dice and the scoring, so a
 * client can no longer declare its own result.
 *
 * Current scope (Phase 0.2): boot, config, structured logging, graceful
 * shutdown. There is still no listener — Phase 0.3 adds HTTP/WS. An entrypoint
 * honest about what exists beats a stub that pretends to serve.
 *
 * Run: `node server/index.js`   (Ctrl-C / SIGTERM drains and exits 0)
 */

var engine = require('./engine.js');
var config = require('./config.js');
var logging = require('./log.js');
var lifecycle = require('./lifecycle.js');

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
 * Wire everything up without listening. Returned so tests can boot the server's
 * runtime (config + log + lifecycle) and drain it without a process or a port.
 * opts: { env, write, now, exit } — all injectable.
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
  log.info('Генерал server booted (Phase 0 scaffold — no listener yet)', bootFields(cfg, report));

  return { cfg: cfg, log: log, life: life, engine: engine, report: report };
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
  return app;
}

if (require.main === module) main();

module.exports = { boot: boot, main: main, bootFields: bootFields };
