'use strict';
/*
 * Room — the server hosting ONE `MP.Session` over ONE `SocketBus`.
 *
 * This is the step where the server stops being a pipe and starts being a
 * referee. Phase 0.3 gave us sockets shaped like `mp.js`'s transport, Phase 1.1
 * grouped them into a star, and this file puts the thing they exist for on top:
 * `new MP.Session({ transport: bus, isHost: true })`. The lobby handshake
 * (JOIN_REQ → JOIN_ACK + ROSTER), the roster, the turn rotation and the end of
 * the game are all the SAME code the browser's host runs — the point of the
 * whole design is that the server does not get its own copy of the rules.
 *
 * THE SERVER IS A REFEREE, NOT A PLAYER. A browser host is a player at the
 * table and takes seat 0 in its own roster; this one must not, so it is built
 * with `hostPlays: false` (mp.js). Otherwise seat 0 would join the turn order
 * and be granted a turn nobody was ever going to play — the rotation would
 * stall on a chair with nobody in it.
 *
 * WHAT THIS FILE IS NOT (yet): there is exactly one room, created at boot, with
 * no join code — Phase 2.1 turns this into a registry keyed by a minted code,
 * 2.2 binds seats to `eph` across reconnects, 2.3 adds idle expiry. And the
 * dice are still CLIENT-DECLARED: the session validates whose turn it is and
 * that the category is free, not the number claimed. Phase 3 is what closes
 * that gap; nothing here should grow rules logic before then.
 */

var engine = require('./engine.js');
var socketBus = require('./socket-bus.js');

var MP = engine.MP, G = engine.G, X = engine.X;

var NOOP = function () {};
var NULL_LOG = { debug: NOOP, info: NOOP, warn: NOOP, error: NOOP };

/*
 * mp.js re-arms its timers for as long as a room is alive: the lobby beacon
 * every few seconds, and the move timeout for every turn a client is taking. In
 * a browser tab a pending timer costs nothing; in Node it is a reason for the
 * event loop to STAY ALIVE, so an open room would keep the process up after the
 * listener had already closed — a clean SIGTERM turning into a hang that the
 * shutdown deadline then has to convert into exit(1), which an orchestrator
 * reads as a crash. Unref'd, they still fire on a running server and stop being
 * a reason to run. The listener's heartbeat unrefs for exactly this reason.
 */
function unrefTimeout(fn, ms) {
  var t = setTimeout(fn, ms);
  if (t && t.unref) t.unref();
  return t;
}

// How many cells a board has under each ruleset — the session needs it to know
// when a player is finished. Same source the browser reads (features/net).
function roundsFor(exp) { return exp ? X.KEYS.length : G.CATEGORIES.length; }

/*
 * The highest seat id this room may hand out. `config.PROTOCOL_MAX_SEATS` is 15
 * because the wire format's sender nibble holds 0..15 — but it counts the HOST
 * into that budget, and this host takes no seat. Left alone, a full room would
 * seat someone at 15, which is `UNASSIGNED`: their frames would be
 * indistinguishable from "I have not been seated yet", and `SocketBus` (whose
 * seat range stops one short of UNASSIGNED for exactly that reason) would never
 * tag their socket, so their disconnect would drop nobody.
 */
var MAX_SEATS = MP.UNASSIGNED - 1;

/*
 * opts: { cfg, log, id, exp, manual, minPlayers }
 *   cfg   — server config (maxPlayersPerRoom caps the room).
 *   id    — room name, for the logs. Phase 2.1 replaces it with a join code.
 *   exp   — experimental ruleset; `manual` — free-for-all (ОТЧЕТ) game.
 */
function create(opts) {
  opts = opts || {};
  var cfg = opts.cfg || {};
  var id = opts.id || 'lobby';
  var baseLog = opts.log || NULL_LOG;
  var log = baseLog.child ? baseLog.child({ room: id }) : baseLog;
  var exp = !!opts.exp;

  var closed = false;

  // The session's callbacks are the room's only view of what the game is doing.
  // Today they are pure observation (logs, and the ops surface below); Phase 4
  // hangs the AI takeover off onDrop/onWait and Phase 3 the authoritative move
  // handling off onMove.
  var callbacks = {
    onStatus: function (s) { log.debug('room: ' + s); },
    onRoster: function (roster) { log.debug('room: roster', { players: roster.length }); },
    onStart: function (roster, order) { log.info('room: game started', { players: roster.length, order: order.join(',') }); },
    onTurn: function (activeId) { log.debug('room: turn granted', { seat: activeId }); },
    onMove: function (mv) { log.debug('room: move applied', { seat: mv.playerId, category: mv.category, score: mv.score }); },
    onDrop: function (seat, on) { log.info('room: seat ' + (on ? 'dropped' : 'returned'), { seat: seat }); },
    // Every seat that still owes a turn has dropped: the rotation is parked
    // until one of them comes back. Phase 4.2 is what stops that being a stall
    // (the server plays the seat), so it is worth a log line, not a debug one.
    onWait: function () { log.warn('room: rotation is waiting on dropped seats'); },
    onEnd: function () { log.info('room: game over'); },
  };

  var bus = socketBus.create({
    log: log,
    onPeers: function (n) { log.debug('room: sockets', { sockets: n }); },
    onLost: function (conn) { seatLost(conn); },
  });

  var session = new MP.Session({
    transport: bus,
    isHost: true,
    hostPlays: false,            // referee, not a player — see the header
    manual: !!opts.manual,
    exp: exp,
    minPlayers: opts.minPlayers || 2,
    maxPlayers: Math.min(cfg.maxPlayersPerRoom || 6, MAX_SEATS),
    rounds: roundsFor(exp),
    setTimeout: unrefTimeout,
    clearTimeout: clearTimeout,
    callbacks: callbacks,
  });

  /*
   * A socket vanished on its own. Which SEAT went with it? The bus tags a
   * socket with the seat it speaks for — but only once that seated client has
   * spoken, and a client in the lobby says nothing between its JOIN_REQ (sent
   * with the UNASSIGNED sender nibble, because it has no id yet) and its READY.
   * So a lobby dropout is typically untagged and its roster seat lingers until
   * someone reclaims it. That is Phase 2.2's job — binding seats by `eph` at
   * JOIN_ACK time, which is the only authoritative socket→seat mapping. An
   * untagged socket dropping nobody is the safe way to be wrong.
   *
   * NO OVERLAPPING-RECONNECT GUARD IS NEEDED HERE, unlike the browser's host
   * (features/net/net.js), which checks that no other live connection still
   * carries the seat. The bus already makes that impossible: it refuses a seat
   * another live socket claims, so at most one member is ever tagged with a
   * given seat, and it detaches this one BEFORE reporting the loss. The residual
   * wrinkle is the other way round — while a half-open socket still holds the
   * claim, its owner's NEW socket cannot be tagged, so reaping the stale one
   * drops a seat somebody is sitting in. What rescues that today is the
   * returning client's own JOIN_REQ, which clears the flag by `eph` in every
   * state; 2.2 is what removes the window.
   */
  function seatLost(conn) {
    if (conn.pid == null) { log.debug('room: an unseated socket went away', { conn: conn.id }); return; }
    log.info('room: socket lost', { conn: conn.id, seat: conn.pid });
    // markDropped skips the seat in the rotation (and advances if it held the
    // turn), but keeps it in the roster so the same player can reclaim it.
    session.markDropped(conn.pid, true);
  }

  // Hand a socket to this room. Returns false — taking no ownership, so the
  // CALLER decides what becomes of the socket — if the room is closed or the
  // socket is already dead.
  function join(conn) { return bus.add(conn); }

  /*
   * Close the room. Order matters:
   *   1. BYE while the sockets are still open — a client that is TOLD the room
   *      is gone can say so on screen, where a yanked TCP connection just
   *      freezes the board mid-turn.
   *   2. dispose() — the only thing that sweeps the session's timers.
   *   3. bus.stop() — closes every socket deliberately, which is why no onLost
   *      fires: we must not report six players dropping while we are the one
   *      tearing their room down.
   */
  function close(reason) {
    if (closed) return false;
    closed = true;
    session.disband();
    session.dispose();
    bus.stop(1001, reason || 'room closed');
    log.info('room closed', { reason: reason || 'room closed' });
    return true;
  }

  // What /healthz reports. Deliberately cheap and allocation-free-ish: it is
  // polled by a load balancer, and it must never be the thing that is broken.
  function stats() {
    return { room: id, state: session.state, players: session.roster.length, sockets: bus.size() };
  }

  session.openLobby();   // JOIN_REQ is only honoured in LOBBY — the room is open from birth
  log.info('room opened', { ruleset: exp ? 'experimental' : 'standard', manual: !!opts.manual, maxPlayers: session.maxPlayers });

  return {
    id: id,
    // The two layers below, exposed for the phases that must reach past this
    // file: Phase 2 moves sockets between rooms, Phase 3 drives the session.
    bus: bus,
    session: session,
    join: join,
    close: close,
    stats: stats,
    get state() { return session.state; },
    get closed() { return closed; },
  };
}

module.exports = { create: create, unrefTimeout: unrefTimeout, MAX_SEATS: MAX_SEATS };
