// Генерал — SocketBus: an MP.Session transport over a WebSocket to OUR OWN server.
//
// The sibling of net.js's PeerBus. PeerBus speaks WebRTC and can be either end of the
// star (host or client); this one is **always the client** — the star's centre is the
// server, which hosts the authoritative MP.Session (server/room.js). So there is exactly
// one connection to manage, and everything the host half of PeerBus does (accepting
// peers, tagging seats, re-broadcasting) has no counterpart here. That asymmetry is the
// whole point of the server: a client can only talk to the referee.
//
// Not wired into the UI — Phase 7 does that (see docs/backend/PLAN.md). For now this is
// constructible and testable, nothing more.
//
// Two constraints shape the file:
//   - It must load over `file://` as a classic script (root CLAUDE.md): no ES modules,
//     no fetch. A WebSocket from a `file://` page is fine — it just sends `Origin: null`,
//     which the server's allowlist can name (server/listener.js).
//   - It is DOM-free and UMD, like mp.js, so Node can `require()` it and drive it
//     against a REAL server process with `ws` injected as `opts.WebSocket`. A transport
//     tested only against a mock proves nothing about the wire.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SocketBus = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DEFAULT_PATH = '/ws';          // server/listener.js upgrades this path and no other
  var OPEN = 1;                      // WebSocket.OPEN — spelled out so the module needs no global
  var DIAL_TIMEOUT_MS = 20000;       // same patience PeerBus gives a data channel
  var REDIAL_MAX = 20, REDIAL_STEP_MS = 1000, REDIAL_CAP_MS = 5000;

  function noop() {}

  // ---------- url ----------
  // Accepts what a human would type: `ws(s)://host/path`, `http(s)://host` (a server URL
  // copied from a browser bar), or a bare `host:port`. Defaults the path to /ws, because
  // an upgrade anywhere else is a 404 from the listener and the failure ("connection
  // closed") says nothing about the real mistake.
  function normalizeUrl(raw) {
    var s = String(raw == null ? '' : raw).trim();
    if (!s) throw new Error('SocketBus: no server url');
    // Name an unsupported scheme rather than swallowing it: without this, `ftp://h` falls
    // through the "bare host" branch and becomes the nonsense `ws://ftp://h`, which fails
    // far away from the typo that caused it.
    var scheme = /^([a-z][a-z0-9+.\-]*):\/\//i.exec(s);
    if (scheme && !/^(wss?|https?)$/i.test(scheme[1])) throw new Error('SocketBus: unsupported scheme: ' + scheme[1]);
    if (/^https?:/i.test(s)) s = 'ws' + s.slice(4);          // http:// → ws://, https:// → wss://
    else if (!/^wss?:/i.test(s)) s = 'ws://' + s;            // bare host[:port][/path]
    var m = /^(wss?:\/\/[^/?#]+)([^?#]*)([\s\S]*)$/i.exec(s);
    if (!m) throw new Error('SocketBus: bad server url: ' + raw);
    var path = m[2];
    if (path === '' || path === '/') path = DEFAULT_PATH;
    return m[1] + path + m[3];
  }

  // Only binary frames are ours. We ask for ArrayBuffer, but `ws` under Node hands out
  // Buffers unless told otherwise, so accept any view too — and view it in place rather
  // than copying, since unframe only reads.
  function toBytes(data) {
    if (!data) return null;
    if (typeof ArrayBuffer === 'undefined') return null;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return null;                                             // a string/Blob is not the protocol
  }

  // ===================================================== SocketBus

  // opts: { url, WebSocket?, onPeers?, onLost?, onReup?, onLog?, dialTimeoutMs?, redialMax? }
  //   onPeers(n)     — 0 or 1; the server is the only peer. Kept at PeerBus's name/shape so
  //                    the lobby UI can take either transport without knowing which it has.
  //   onLost(info)   — the socket went away ON ITS OWN ({code, reason}). Our own stop() does
  //                    NOT fire it: the same rule server/socket-bus.js follows, so a teardown
  //                    is never reported as a player dropping.
  //   onReup()       — a dropped link was re-established (the session must re-announce).
  //   onGiveUp()     — the redial budget is spent; nothing is still trying. The only exit
  //                    from a reconnect state that `onReup` will never reach.
  //   onLog(ev,data) — optional trace hook; net.js can pass its `wrlog` capture.
  //   WebSocket      — constructor injection for Node tests; defaults to the global.
  function SocketBus(opts) {
    opts = opts || {};
    this.url = normalizeUrl(opts.url);
    this.WS = opts.WebSocket || (typeof WebSocket !== 'undefined' ? WebSocket : null);
    this.onPeers = opts.onPeers || noop;
    this.onLost = opts.onLost || noop;
    this.onReup = opts.onReup || noop;
    this.onGiveUp = opts.onGiveUp || noop;
    this.onLog = opts.onLog || noop;
    this.dialTimeoutMs = opts.dialTimeoutMs > 0 ? opts.dialTimeoutMs : DIAL_TIMEOUT_MS;
    this.redialMax = opts.redialMax >= 0 ? opts.redialMax : REDIAL_MAX;
    this.sock = null; this._rx = null; this._pending = null; this._abortDial = null;
    this._stopped = false; this._dialing = false; this._redialN = 0; this._redialTimer = null;
  }

  SocketBus.prototype._log = function (ev, data) { try { this.onLog(ev, data || {}); } catch (e) {} };

  // ---------- the MP.Session transport contract (send + onReceive) ----------
  SocketBus.prototype.onReceive = function (cb) { this._rx = cb; };

  // Resolves the delivered count (0 or 1) and NEVER rejects — MP.Session calls send()
  // without a .catch(), so a rejection here becomes an unhandled rejection. Sending while
  // the link is down is normal (a redial is in flight), not an error: the session's own
  // resync is what repairs the gap.
  SocketBus.prototype.send = function (bytes) {
    var s = this.sock;
    if (!s || s.readyState !== OPEN) { this._log('tx-drop', { len: (bytes && bytes.length) || 0 }); return Promise.resolve(0); }
    try { s.send(bytes); } catch (e) { this._log('tx-error', { message: e && e.message }); return Promise.resolve(0); }
    this._log('tx', { len: (bytes && bytes.length) || 0 });
    return Promise.resolve(1);
  };

  // ---------- lifecycle ----------
  // Resolves once the socket is open; rejects if the FIRST dial fails. After that the bus
  // owns its own reconnection and never rejects again (mirrors PeerBus.start()).
  // A rejection carrying `err.aborted === true` means WE cancelled the dial via stop() —
  // the caller's own doing, not a connection failure. Phase 7 must check that before
  // telling the player the link fell over: cancelling the lobby yourself should not raise
  // an error at you.
  SocketBus.prototype.start = function () {
    var self = this;
    self._stopped = false;
    self._log('bus-start', { url: self.url });
    return new Promise(function (resolve, reject) {
      if (!self.WS) { self._log('start-fail', { reason: 'no-websocket' }); reject(new Error('no-websocket')); return; }
      // _dial is a no-op while a link exists or a dial is in flight, so answer those two
      // here — otherwise a second start() would hand back a promise that never settles.
      if (self.sock) { resolve(); return; }
      if (self._dialing) { reject(new Error('already-dialing')); return; }
      self._dial({ ok: resolve, fail: function (e) { self._log('start-fail', { message: e && e.message }); reject(e); } });
    });
  };

  // `first` carries start()'s resolve/reject; a redial passes null and fires onReup instead.
  SocketBus.prototype._dial = function (first) {
    var self = this;
    if (self._stopped || self._dialing || self.sock) return;
    self._dialing = true;
    self._log('dial', { redial: !first });
    var sock, settled = false, timer = null;
    // Exactly one of open / error / close-before-open may decide this dial. The browser
    // fires error AND then close for a refused connection; without the guard a redial
    // would be scheduled twice and the backoff would run at double speed.
    function settle(fn) { if (settled) return; settled = true; self._dialing = false; self._pending = null; self._abortDial = null; if (timer) clearTimeout(timer); fn(); }
    function failed(e) { settle(function () { if (first) first.fail(e); else self._scheduleRedial(); }); }

    try { sock = new self.WS(self.url); }
    catch (e) { self._dialing = false; if (first) first.fail(e); else self._scheduleRedial(); return; }
    try { sock.binaryType = 'arraybuffer'; } catch (e) {}
    // A socket that has not opened yet is invisible to stop() unless it is parked here —
    // and a connect in flight always outlives the decision to abandon it, so without this
    // a stop() during a dial hands the app a live link a moment after it asked for none.
    self._pending = sock;
    // stop() has to be able to end a dial that has not resolved either way, or its timeout
    // fires minutes later and rejects a start() the caller has long since walked away from
    // — an unhandled rejection, i.e. a pageerror on a page that must survive offline.
    self._abortDial = function () { var e = new Error('stopped'); e.aborted = true; failed(e); };

    timer = setTimeout(function () {
      settle(function () {
        self._log('dial-timeout', { redial: !first });
        try { sock.close(); } catch (e) {}
        if (first) first.fail(new Error('timeout')); else self._scheduleRedial();
      });
    }, self.dialTimeoutMs);
    if (timer && typeof timer.unref === 'function') timer.unref();   // a pending dial must not hold Node's loop open

    sock.onopen = function () {
      settle(function () {
        self._log('open', { redial: !first });
        self._redialN = 0; self._adopt(sock);
        if (first) first.ok(); else self.onReup();
      });
    };
    sock.onerror = function (e) { self._log('dial-error', { message: (e && e.message) || 'socket error' }); failed(new Error((e && e.message) || 'socket-error')); };
    sock.onclose = function (ev) { failed(new Error('closed' + (ev && ev.code ? ' (' + ev.code + ')' : ''))); };
  };

  // Take ownership of an open socket: from here the pre-open handlers above are inert
  // (settled) and these three are the live ones.
  SocketBus.prototype._adopt = function (sock) {
    var self = this;
    self.sock = sock;
    sock.onmessage = function (ev) {
      var b = toBytes(ev && ev.data);
      // Say so when a frame is dropped. `binaryType = 'arraybuffer'` is set inside a
      // swallowing try/catch, and the one runtime where that assignment fails is exactly
      // the one where every frame arrives as a Blob — the bus would then look connected
      // (onPeers(1), send() still resolving 1) while being permanently deaf.
      if (!b) { var d = ev && ev.data; self._log('rx-drop', { kind: (d && d.constructor && d.constructor.name) || typeof d }); return; }
      self._log('rx', { len: b.length });
      if (self._rx) self._rx(b);
    };
    sock.onerror = function (e) { self._log('sock-error', { message: (e && e.message) || 'socket error' }); };
    sock.onclose = function (ev) {
      if (self.sock !== sock) return;                        // already replaced or stopped — not our loss to report
      self.sock = null;
      self._log('close', { code: ev && ev.code, reason: ev && ev.reason });
      self.onPeers(0);
      self.onLost({ code: (ev && ev.code) || 0, reason: (ev && ev.reason) || '' });
      if (!self._stopped) self._scheduleRedial();
    };
    self.onPeers(1);
  };

  // The server keeps the room (and, from Phase 2.2, the seat) alive across a socket drop,
  // so giving up is the wrong default: back off and keep knocking, exactly as PeerBus's
  // client half does, until the attempt budget is spent.
  SocketBus.prototype._scheduleRedial = function () {
    var self = this;
    if (self._stopped || self.sock || self._redialTimer) return;
    self._redialN += 1;
    // Announce the end of the road. PeerBus only logs here (net.js:529), and Phase 7's
    // reconnect banner clears on `onReup` — so a silently spent budget would leave the UI
    // saying "наваксвам…" forever, with nothing left running that could ever clear it.
    if (self._redialN > self.redialMax) { self._log('redial-giveup', { attempts: self._redialN }); self.onGiveUp(); return; }
    var wait = Math.min(REDIAL_STEP_MS * self._redialN, REDIAL_CAP_MS);
    self._log('redial-schedule', { attempt: self._redialN, ms: wait });
    self._redialTimer = setTimeout(function () {
      self._redialTimer = null;
      if (!self._stopped && !self.sock) self._dial(null);
    }, wait);
    if (self._redialTimer && typeof self._redialTimer.unref === 'function') self._redialTimer.unref();
  };

  // Deliberate teardown. Detaching the handlers BEFORE close() is what keeps onLost/onReup
  // honest — otherwise our own goodbye arrives at the app as "the other side vanished" and
  // the redial loop we just cancelled starts again from the close event.
  SocketBus.prototype.stop = function (code, reason) {
    this._log('bus-stop', {});
    this._stopped = true;
    if (this._redialTimer) { clearTimeout(this._redialTimer); this._redialTimer = null; }
    var live = [this.sock, this._pending];                   // an unopened dial counts too
    this.sock = null; this._pending = null;
    if (this._abortDial) this._abortDial();                  // after `live` is captured — aborting clears _pending
    for (var i = 0; i < live.length; i++) {
      var s = live[i];
      if (!s) continue;
      // Muted, NOT unhooked. Closing a socket that is still connecting raises an error
      // ("closed before the connection was established"), and under `ws` an error with no
      // listener is an uncaught exception that takes the process down — so the handler has
      // to stay, it just must not reach the app.
      s.onmessage = noop; s.onopen = noop; s.onerror = noop; s.onclose = noop;
      try { s.close(code || 1000, reason || ''); } catch (e) {}
    }
  };

  SocketBus.normalizeUrl = normalizeUrl;                     // exported for tests + the Phase 7 settings field
  SocketBus.DEFAULT_PATH = DEFAULT_PATH;
  return SocketBus;
});
