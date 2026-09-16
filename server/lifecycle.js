'use strict';
/*
 * Graceful shutdown — an ordered list of drain hooks, run once, under a deadline.
 *
 * Why it exists this early: rooms are in-memory only (Decision D6), so a
 * restart already drops in-flight games. The least we can do is tell the people
 * in them — index.js registers a hook that sends BYE and closes the room's
 * sockets, rather than yanking the TCP connection and leaving six phones
 * showing a frozen board.
 *
 * Shape: hooks run in REVERSE registration order (last registered = first
 * drained), the way you'd unwind a stack. That is why index.js registers the
 * rooms hook AFTER the listener's: the rooms drain first (stop accepting, say
 * goodbye, close their sockets) and the listener releases the port last, rather
 * than yanking the connections before the goodbye can reach them. Each hook
 * gets its own slice of the grace
 * budget; a hook that hangs cannot hold the process hostage, because the
 * deadline forces the exit regardless.
 */

function create(opts) {
  opts = opts || {};
  var log = opts.log || { info: function () {}, warn: function () {}, error: function () {} };
  var graceMs = opts.graceMs === undefined ? 10000 : opts.graceMs;
  var exit = opts.exit || function (code) { process.exit(code); };
  var setTimeoutFn = opts.setTimeout || setTimeout;
  var clearTimeoutFn = opts.clearTimeout || clearTimeout;

  var hooks = [];
  var shuttingDown = false;
  var installed = [];

  // name is for the log line: a shutdown that stalls should say WHICH hook.
  function onShutdown(name, fn) {
    hooks.push({ name: name, fn: fn });
    return function remove() {
      var i = hooks.findIndex(function (h) { return h.fn === fn; });
      if (i >= 0) hooks.splice(i, 1);
    };
  }

  function shutdown(reason, code) {
    if (shuttingDown) {
      // A second SIGTERM (or an impatient operator's ^C) means "stop waiting".
      log.warn('shutdown already in progress — exiting now', { reason: reason });
      exit(code === undefined ? 0 : code);
      return Promise.resolve();
    }
    shuttingDown = true;
    log.info('shutting down', { reason: reason, hooks: hooks.length, graceMs: graceMs });

    var done = false;
    var deadline = setTimeoutFn(function () {
      if (done) return;
      done = true;
      log.error('shutdown grace expired — forcing exit', { graceMs: graceMs });
      exit(1);
    }, graceMs);
    // Don't let the deadline itself keep an otherwise-idle process alive.
    if (deadline && typeof deadline.unref === 'function') deadline.unref();

    var order = hooks.slice().reverse();

    function step(i) {
      if (i >= order.length) return Promise.resolve();
      var h = order[i];
      return Promise.resolve()
        .then(function () { return h.fn(); })
        .catch(function (e) {
          // One broken hook must not strand the rest — drain what we can.
          log.error('shutdown hook failed', { hook: h.name, err: e });
        })
        .then(function () { return step(i + 1); });
    }

    return step(0).then(function () {
      if (done) return;
      done = true;
      clearTimeoutFn(deadline);
      log.info('drained cleanly', { reason: reason });
      exit(code === undefined ? 0 : code);
    });
  }

  // SIGTERM is the orchestrator asking politely; SIGINT is a human at a
  // terminal. Both drain. Returns an uninstaller so tests don't leak handlers
  // onto the process across runs.
  function installSignalHandlers(proc) {
    proc = proc || process;
    ['SIGTERM', 'SIGINT'].forEach(function (sig) {
      var handler = function () { shutdown(sig, 0); };
      proc.on(sig, handler);
      installed.push({ sig: sig, handler: handler, proc: proc });
    });
    return function uninstall() {
      installed.forEach(function (h) { h.proc.removeListener(h.sig, h.handler); });
      installed = [];
    };
  }

  return {
    onShutdown: onShutdown,
    shutdown: shutdown,
    installSignalHandlers: installSignalHandlers,
    get shuttingDown() { return shuttingDown; },
    get hookCount() { return hooks.length; },
  };
}

module.exports = { create: create };
