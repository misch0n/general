'use strict';
/*
 * SocketBus — one room's WebSocket connections, fanned into the ONE transport
 * that MP.Session expects.
 *
 * `listener.js` already hands out each accepted socket as a
 * `{ send, onReceive, close }` object — deliberately the same shape as
 * mp.js's `opts.transport`. What a room needs on top of that is not more
 * transport code but a GROUPING step: the host session has a single
 * `send()`/`onReceive()` pair, while a room has N sockets. This file is that
 * fan-out/fan-in, and nothing else. No game logic, no rooms, no protocol
 * knowledge beyond one field of the frame header.
 *
 * TOPOLOGY: a STAR, exactly like the browser's `PeerBus` (features/net/net.js).
 *   - the session's `send()` goes to EVERY connection in the room;
 *   - a frame from ANY connection goes to the session — and to nobody else.
 * Clients never hear each other directly. That is not an optimisation, it is
 * the authority model: the host is the only source of truth, and it re-emits
 * whatever the others are allowed to know (ROSTER/STATE/GRANT…). Relaying a
 * client's bytes to its peers would let a client speak with the host's voice.
 * `test/webrtc.test.js` pins the same expectations for the WebRTC side.
 *
 * WHAT THIS FILE IS NOT: it does not construct the Session (Phase 1.2), does
 * not know about rooms or join codes (Phase 2), and does not validate moves
 * (Phase 3). It only knows which sockets belong together.
 */

var MP = require('../mp.js');

// SENDER nibble (mp.js): 0 is the host, 15 ("UNASSIGNED") is a client that has
// not been seated yet. Only 1..14 name an actual seat.
var SEAT_MIN = MP.HOST_ID + 1;
var SEAT_MAX = 14;

var NOOP = function () {};
var NULL_LOG = { debug: NOOP, info: NOOP, warn: NOOP, error: NOOP };

/*
 * opts: { log, onPeers(n), onLost(conn) }
 *   onPeers(n) — membership changed; n is the new connection count.
 *   onLost(conn) — a connection went away ON ITS OWN (socket close). An
 *     explicit remove()/stop() does NOT fire it: those are our own doing, and
 *     the layer above must not be told a player dropped when it is the one
 *     tearing the room down.
 *
 * Returns the bus, which IS the transport (it carries `send`/`onReceive`
 * directly), so it can be handed to `new MP.Session({ transport: bus, … })`
 * the same way `PeerBus` is in the browser.
 */
function create(opts) {
  opts = opts || {};
  var log = opts.log || NULL_LOG;
  var onPeers = opts.onPeers || NOOP;
  var onLost = opts.onLost || NOOP;

  var conns = [];
  var rx = null;
  var stopped = false;

  // Detach without announcing a loss. Returns whether it was actually a member.
  function detach(conn) {
    var i = conns.indexOf(conn);
    if (i < 0) return false;
    conns.splice(i, 1);
    onPeers(conns.length);
    return true;
  }

  function receive(conn, bytes) {
    // A frame already in flight when we dropped the socket (or tore the room
    // down) must not reach the session — it would be a ghost of a player that
    // is, by then, gone.
    if (conns.indexOf(conn) < 0) return;

    var f = null;
    try { f = MP.unframe(bytes); } catch (e) { f = null; }
    // unframe() returns null on a CRC mismatch: "not received", by design.
    if (!f) { log.debug('bus: dropped a corrupt frame', { conn: conn.id, bytes: bytes && bytes.length }); return; }

    // Tag the socket with the seat it speaks for, so that when it closes the
    // layer above knows WHICH player vanished. The host side of `PeerBus` does
    // exactly this; it costs one extra unframe per inbound frame (the session
    // unframes again), which is nothing next to a socket read.
    if (f.sender >= SEAT_MIN && f.sender <= SEAT_MAX) conn.pid = f.sender;

    // Pass the ORIGINAL bytes on, not the decoded frame: the session owns the
    // protocol, this layer only routes.
    if (rx) rx(bytes);
  }

  var bus = {
    // ---------- MP.Session transport contract ----------

    /*
     * Fan one frame out to the whole room. NEVER REJECTS — MP.Session calls
     * send() without a `.catch()`, so a rejection here would be an unhandled
     * rejection, which Node turns into a process exit: one rude socket would
     * kill every other room on the box. Each conn.send() already upholds that
     * contract; the try/catch guards a transport that does not.
     *
     * Resolves with the number of sockets the frame reached, which is what a
     * caller can act on (0 = the room is effectively empty).
     *
     * `bytes` is handed to every socket AS IS — ws may still hold it queued
     * after send() returns — so it must be treated as READ-ONLY from here on.
     * Copying per socket would be a copy per player per frame, for nothing:
     * frames are built fresh by the session and never mutated after sending.
     */
    send: function (bytes) {
      var wrote = 0;
      var pending = [];
      // Iterate a snapshot: a send can synchronously close a socket (a dead
      // peer), which mutates `conns` underneath us.
      conns.slice().forEach(function (c) {
        try {
          pending.push(Promise.resolve(c.send(bytes)).then(
            function (ok) { if (ok !== false) wrote++; },
            function (e) { log.debug('bus: send rejected', { conn: c.id, err: e }); }
          ));
        } catch (e) {
          log.debug('bus: send threw', { conn: c.id, err: e });
        }
      });
      return Promise.all(pending).then(function () { return wrote; });
    },

    onReceive: function (cb) { rx = cb; },

    // ---------- membership ----------

    // Join a socket to this room's bus. Returns false if it is already a
    // member, or the bus has been stopped.
    add: function (conn) {
      if (stopped || !conn || conns.indexOf(conn) >= 0) return false;
      conns.push(conn);
      conn.onReceive(function (bytes) { receive(conn, bytes); });
      // The socket wrapper lets a layer above register for the close, because
      // it has no access to the raw `ws`. Without it a vanished player would
      // hold its spoke of the star forever.
      if (conn.onClose) {
        conn.onClose(function () { if (detach(conn)) onLost(conn); });
      }
      log.debug('bus: connection joined', { conn: conn.id, peers: conns.length });
      onPeers(conns.length);
      return true;
    },

    // Take a socket off the bus without treating it as a drop (it stays open —
    // Phase 2 moves a connection between rooms this way).
    remove: function (conn) { return detach(conn); },

    has: function (conn) { return conns.indexOf(conn) >= 0; },
    size: function () { return conns.length; },
    peers: function () { return conns.slice(); },

    // Tear the room's transport down: close every socket and refuse new ones.
    // Deliberate, so no onLost fires.
    stop: function (code, reason) {
      stopped = true;
      var list = conns;
      conns = [];
      rx = null;
      list.forEach(function (c) { try { c.close(code || 1000, reason || ''); } catch (e) { /* already gone */ } });
      if (list.length) onPeers(0);
      log.debug('bus: stopped', { closed: list.length });
    },
  };

  return bus;
}

module.exports = { create: create };
