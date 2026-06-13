// Генерал — acoustic multiplayer protocol (data-over-sound, host-authoritative).
//
// Layered per the spec: L0 transport (pluggable; a pure-JS audio FSK modem ships
// here as MP.AudioFSK), L1 framing (+CRC-8), L2 session/lobby, L3 game sync with
// General-specific MOVE/STATE payloads. The whole stack below is dependency-free
// and the protocol logic is pure (DOM-free), so it unit-tests with a mock
// transport. Only AudioFSK touches Web Audio and runs browser-only.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MP = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---- message vocabulary (TYPE values are stable wire constants) ----
  var T = {
    BEACON: 1, JOIN_REQ: 2, JOIN_ACK: 3, ROSTER: 4, START: 5,
    GRANT: 6, MOVE: 7, STATE: 8, RESYNC_REQ: 9, PING: 10, PONG: 11, END: 12,
    XOFFER: 20, XWANT: 21, XDATA: 22, XACK: 23, XDONE: 24,   // acoustic record transfer
  };
  var HOST_ID = 0, UNASSIGNED = 15;          // SENDER nibble: host is 0, pre-join client is 15
  var GENDERS = ['m', 'n', 'f'];

  // ---- CRC-8 (poly 0x07) — a cheap logical integrity check on top of L0 ----
  function crc8(bytes, n) {
    var c = 0;
    for (var i = 0; i < n; i++) {
      c ^= bytes[i];
      for (var k = 0; k < 8; k++) c = (c & 0x80) ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
    }
    return c;
  }

  // ---- UTF-8 (TextEncoder where available; manual fallback) ----
  var TE = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
  var TD = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null;
  function utf8(s) {
    if (TE) return TE.encode(s);
    var a = [];
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 128) a.push(c);
      else if (c < 2048) a.push(192 | (c >> 6), 128 | (c & 63));
      else a.push(224 | (c >> 12), 128 | ((c >> 6) & 63), 128 | (c & 63));
    }
    return new Uint8Array(a);
  }
  function utf8d(bytes) {
    var u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (TD) return TD.decode(u);
    var s = '', i = 0;
    while (i < u.length) {
      var c = u[i++];
      if (c < 128) s += String.fromCharCode(c);
      else if (c < 224) s += String.fromCharCode(((c & 31) << 6) | (u[i++] & 63));
      else s += String.fromCharCode(((c & 15) << 12) | ((u[i++] & 63) << 6) | (u[i++] & 63));
    }
    return s;
  }

  // ---- tiny binary writer/reader (schema packing: values only, no field names) ----
  function Writer() { this.b = []; }
  Writer.prototype.u8 = function (v) { this.b.push(v & 0xff); return this; };
  Writer.prototype.u16 = function (v) { this.b.push((v >>> 8) & 0xff, v & 0xff); return this; };
  Writer.prototype.bytes = function (arr) { for (var i = 0; i < arr.length; i++) this.b.push(arr[i] & 0xff); return this; };
  Writer.prototype.str = function (s, maxLen) { var e = utf8(String(s == null ? '' : s)); if (maxLen && e.length > maxLen) e = e.slice(0, maxLen); this.u8(e.length); this.bytes(e); return this; };
  Writer.prototype.out = function () { return new Uint8Array(this.b); };
  function Reader(bytes) { this.b = bytes; this.i = 0; }
  Reader.prototype.u8 = function () { return this.b[this.i++]; };
  Reader.prototype.u16 = function () { var v = (this.b[this.i] << 8) | this.b[this.i + 1]; this.i += 2; return v; };
  Reader.prototype.bytes = function (n) { var s = this.b.slice(this.i, this.i + n); this.i += n; return s; };
  Reader.prototype.str = function () { return utf8d(this.bytes(this.u8())); };
  Reader.prototype.left = function () { return this.b.length - this.i; };

  // ---- L1 framing: [TYPE][SENDER][SEQ][PAYLOAD…][CRC8] ----
  function frame(type, sender, seq, payload) {
    payload = payload || new Uint8Array(0);
    var out = new Uint8Array(3 + payload.length + 1);
    out[0] = type & 0xff; out[1] = sender & 0xff; out[2] = seq & 0xff;
    out.set(payload, 3);
    out[out.length - 1] = crc8(out, out.length - 1);
    return out;
  }
  function unframe(bytes) {
    if (!bytes || bytes.length < 4) return null;
    var n = bytes.length;
    if (crc8(bytes, n - 1) !== bytes[n - 1]) return null;   // failed integrity ⇒ "not received"
    return { type: bytes[0], sender: bytes[1], seq: bytes[2], payload: bytes.slice(3, n - 1) };
  }

  // ---- [GAME-SPECIFIC] colour + player-meta helpers ----
  function hexRGB(hex) { var h = String(hex || '#888888').replace('#', ''); if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]; var n = parseInt(h, 16) || 0; return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  function rgbHex(rgb) { function p(x) { return (x < 16 ? '0' : '') + (x & 255).toString(16); } return '#' + p(rgb[0]) + p(rgb[1]) + p(rgb[2]); }
  function genIx(g) { var i = GENDERS.indexOf(g); return i < 0 ? 0 : i; }
  function writeMeta(w, p) { w.u8(p.id || 0); w.bytes(hexRGB(p.color)); w.u8(genIx(p.gender)); w.str(p.name, 28); }
  function readMeta(r) { var id = r.u8(), rgb = r.bytes(3), g = r.u8(), name = r.str(); return { id: id, color: rgbHex(rgb), gender: GENDERS[g] || 'm', name: name }; }

  // ---- [GAME-SPECIFIC] payload schemas ----
  function packBeacon(sessionId, slotsFree) { return new Writer().u8(sessionId).u8(slotsFree).out(); }
  function unpackBeacon(p) { var r = new Reader(p); return { sessionId: r.u8(), slotsFree: r.u8() }; }
  function packJoinReq(eph, meta) { var w = new Writer().u16(eph); writeMeta(w, { id: 0, name: meta.name, color: meta.color, gender: meta.gender }); return w.out(); }
  function unpackJoinReq(p) { var r = new Reader(p); return { eph: r.u16(), meta: readMeta(r) }; }
  function packJoinAck(eph, assignedId) { return new Writer().u16(eph).u8(assignedId).out(); }
  function unpackJoinAck(p) { var r = new Reader(p); return { eph: r.u16(), id: r.u8() }; }
  function packRoster(players) { var w = new Writer().u8(players.length); players.forEach(function (p) { writeMeta(w, p); }); return w.out(); }
  function unpackRoster(p) { var r = new Reader(p), n = r.u8(), a = []; for (var i = 0; i < n; i++) a.push(readMeta(r)); return a; }
  function packStart(version, firstId, players) { var w = new Writer().u16(version).u8(firstId).u8(players.length); players.forEach(function (p) { writeMeta(w, p); }); return w.out(); }
  function unpackStart(p) { var r = new Reader(p), version = r.u16(), firstId = r.u8(), n = r.u8(), a = []; for (var i = 0; i < n; i++) a.push(readMeta(r)); return { version: version, firstId: firstId, players: a }; }
  function packGrant(activeId, version) { return new Writer().u8(activeId).u16(version).out(); }
  function unpackGrant(p) { var r = new Reader(p); return { activeId: r.u8(), version: r.u16() }; }
  // MOVE — the active player's completed turn (category + rolls/keeps + score)
  function packMove(m) {
    var w = new Writer().u8(m.playerId).u16(m.ackVersion).u8(m.category).u16(m.score);
    var rolls = m.rolls || [], nr = rolls.length; w.u8(nr);
    for (var i = 0; i < nr; i++) for (var j = 0; j < 5; j++) w.u8((rolls[i][j] || 0));
    for (i = 0; i < nr - 1; i++) { var mask = 0, kp = (m.keeps && m.keeps[i]) || []; for (j = 0; j < 5; j++) if (kp[j]) mask |= (1 << j); w.u8(mask); }
    return w.out();
  }
  function unpackMove(p) {
    var r = new Reader(p), m = { playerId: r.u8(), ackVersion: r.u16(), category: r.u8(), score: r.u16() };
    var nr = r.u8(); m.rolls = []; m.keeps = [];
    for (var i = 0; i < nr; i++) { var d = []; for (var j = 0; j < 5; j++) d.push(r.u8()); m.rolls.push(d); }
    for (i = 0; i < nr - 1; i++) { var mask = r.u8(), k = []; for (j = 0; j < 5; j++) k.push(!!(mask & (1 << j))); m.keeps.push(k); }
    return m;
  }
  // STATE — sub 0: delta (one applied move); sub 1: full snapshot (re-baseline on resync)
  function packStateDelta(version, mv) { return new Writer().u8(0).u16(version).u8(mv.playerId).u8(mv.category).u16(mv.score).out(); }
  function packStateSnapshot(version, scores) {
    var w = new Writer().u8(1).u16(version), ids = Object.keys(scores); w.u8(ids.length);
    ids.forEach(function (id) { var cells = scores[id], cs = Object.keys(cells); w.u8(+id).u8(cs.length); cs.forEach(function (c) { w.u8(+c).u16(cells[c]); }); });
    return w.out();
  }
  function unpackState(p) {
    var r = new Reader(p), sub = r.u8(), version = r.u16();
    if (sub === 0) return { kind: 'delta', version: version, playerId: r.u8(), category: r.u8(), score: r.u16() };
    var n = r.u8(), scores = {};
    for (var i = 0; i < n; i++) { var id = r.u8(), m = r.u8(), cells = {}; for (var j = 0; j < m; j++) { var c = r.u8(); cells[c] = r.u16(); } scores[id] = cells; }
    return { kind: 'snapshot', version: version, scores: scores };
  }

  // ============================================================ L2/L3 Session
  // Host-authoritative session driving lobby → turns → end, transport-agnostic.
  // The turn token IS the channel-access token, so concurrency only happens in
  // the lobby (handled with ALOHA-style retry) and recovery (resync/retransmit).
  function Session(opts) {
    this.tp = opts.transport;
    this.isHost = !!opts.isHost;
    this.me = opts.me || { name: 'Боец', color: '#cccccc', gender: 'm' };
    this.maxPlayers = opts.maxPlayers || 6;
    this.minPlayers = opts.minPlayers || 2;
    this.rounds = opts.rounds || 14;             // categories per player (General = 14)
    this.cb = opts.callbacks || {};
    this._st = opts.setTimeout || function (f, ms) { return setTimeout(f, ms); };
    this._ct = opts.clearTimeout || function (id) { clearTimeout(id); };
    this.rand = opts.rand || Math.random;
    this.p = {};
    var dflt = { beacon: 1500, joinRetry: 2500, moveTimeout: 15000, retransmit: 4 };
    for (var k in dflt) this.p[k] = (opts.params && opts.params[k] != null) ? opts.params[k] : dflt[k];

    this.seq = 0;
    this.state = this.isHost ? 'LOBBY' : 'SEARCHING';
    this.roster = [];                  // [{id,name,color,gender}]
    this.scores = {};                  // id -> { catIdx: score }
    this.version = 0;
    this.order = [];                   // turn order of ids
    this.turnIx = 0;
    this.activeId = null;
    this.myId = this.isHost ? HOST_ID : null;
    this.sessionId = this.isHost ? (1 + Math.floor(this.rand() * 250)) : null;
    this.eph = this.isHost ? 0 : (1 + Math.floor(this.rand() * 60000));
    this._lastBytes = null;            // immediate-dup filter
    this._timers = {};
    this._wantJoin = false;
    this._acked = false;
    var self = this;
    this.tp.onReceive(function (bytes) { self._rx(bytes); });
    if (this.isHost) this.roster.push({ id: HOST_ID, name: this.me.name, color: this.me.color, gender: this.me.gender });
  }
  Session.prototype._status = function (s) { if (this.cb.onStatus) this.cb.onStatus(s); };
  Session.prototype._send = function (type, payload) {
    var sender = this.myId == null ? UNASSIGNED : this.myId;
    var pkt = frame(type, sender, this.seq, payload);
    this.seq = (this.seq + 1) & 0xff;
    try { return this.tp.send(pkt); } catch (e) { return Promise.resolve(); }
  };
  Session.prototype.dispose = function () { var t = this._timers; for (var k in t) this._ct(t[k]); this._timers = {}; this.state = 'DEAD'; };

  // ---------- host: lobby ----------
  Session.prototype.openLobby = function () {
    if (!this.isHost) return;
    this.state = 'LOBBY';
    this._beacon();
    this._status('🔊 Лоби отворено — изчаквам бойци…');
    if (this.cb.onRoster) this.cb.onRoster(this.roster.slice());
  };
  Session.prototype._beacon = function () {
    if (!this.isHost || this.state !== 'LOBBY') return;
    this._send(T.BEACON, packBeacon(this.sessionId, this.maxPlayers - this.roster.length));
    var self = this;
    this._timers.beacon = this._st(function () { self._beacon(); }, this.p.beacon);
  };
  Session.prototype.startGame = function () {
    if (!this.isHost || this.roster.length < this.minPlayers) return false;
    this._ct(this._timers.beacon);
    this.state = 'IN_GAME';
    this.order = this.roster.map(function (p) { return p.id; });
    this.version = 0; this.turnIx = 0;
    this.roster.forEach(function (p) { });
    this._send(T.START, packStart(this.version, this.order[0], this.roster));
    if (this.cb.onStart) this.cb.onStart(this.roster.slice(), this.order.slice());
    this._grant();
    return true;
  };
  Session.prototype._grant = function () {
    this.activeId = this.order[this.turnIx % this.order.length];
    this._send(T.GRANT, packGrant(this.activeId, this.version));
    if (this.cb.onTurn) this.cb.onTurn(this.activeId, this.activeId === this.myId);
    this._armMoveTimeout();
  };
  Session.prototype._armMoveTimeout = function () {
    var self = this; this._ct(this._timers.move); this._tries = 0;
    if (this.activeId === this.myId) return;     // it's my own turn; no wire wait
    (function arm() {
      self._timers.move = self._st(function () {
        if (self.state !== 'IN_GAME') return;
        if (++self._tries > self.p.retransmit) { self._status('Боец ' + self.activeId + ' мълчи…'); return; }
        self._send(T.GRANT, packGrant(self.activeId, self.version)); arm();   // lost GRANT? re-grant
      }, self.p.moveTimeout);
    })();
  };
  Session.prototype._filled = function (id) { return Object.keys(this.scores[id] || {}).length; };
  Session.prototype._allDone = function () { var self = this; return this.order.every(function (id) { return self._filled(id) >= self.rounds; }); };

  // ---------- applying a move (host authoritative) ----------
  Session.prototype._applyMove = function (mv) {
    if (!this.scores[mv.playerId]) this.scores[mv.playerId] = {};
    if (this.scores[mv.playerId][mv.category] != null) return false;   // idempotent: already recorded
    this.scores[mv.playerId][mv.category] = mv.score;
    this.version++;
    if (this.cb.onMove) this.cb.onMove(mv);
    return true;
  };

  // the local active player submits their completed turn
  Session.prototype.submitMove = function (mv) {
    mv.playerId = this.myId; mv.ackVersion = this.version;
    if (this.isHost) {
      if (this._applyMove(mv)) { this._send(T.STATE, packStateDelta(this.version, mv)); this._advance(); }
    } else {
      this._pendingMove = mv;
      this._sendMove();
    }
  };
  Session.prototype._sendMove = function () {
    if (!this._pendingMove) return;
    var self = this, tries = 0;
    var go = function () {
      if (self.state !== 'IN_GAME' || !self._pendingMove) return;
      self._send(T.MOVE, packMove(self._pendingMove));
      self._status('🔊 Изпращам хода…');
      if (++tries <= self.p.retransmit) self._timers.mymove = self._st(go, self.p.moveTimeout);
    };
    go();
  };
  Session.prototype._advance = function () {
    if (this._allDone()) { this.state = 'GAME_OVER'; this._send(T.END, new Uint8Array(0)); if (this.cb.onEnd) this.cb.onEnd(); return; }
    do { this.turnIx++; } while (this._filled(this.order[this.turnIx % this.order.length]) >= this.rounds);
    this._grant();
  };

  // ---------- client: discovery + join ----------
  Session.prototype.requestJoin = function () {
    if (this.isHost) return;
    this._wantJoin = true;
    this._sendJoin();
  };
  Session.prototype._sendJoin = function () {
    if (this.isHost || this._acked || !this._wantJoin || this.state === 'IN_GAME') return;
    this.state = 'JOINING';
    this._send(T.JOIN_REQ, packJoinReq(this.eph, this.me));
    this._status('🔊 Искам да вляза…');
    var self = this, backoff = this.p.joinRetry + Math.floor(this.rand() * this.p.joinRetry); // ALOHA backoff
    this._timers.join = this._st(function () { self._sendJoin(); }, backoff);
  };

  // ---------- receive / dispatch ----------
  Session.prototype._rx = function (bytes) {
    var sig = bytes && bytes.join ? bytes.join(',') : String(bytes);
    if (sig === this._lastBytes) return;       // drop an immediate duplicate retransmit
    this._lastBytes = sig;
    var pkt = unframe(bytes); if (!pkt) return;
    if (this.isHost) this._rxHost(pkt); else this._rxClient(pkt);
  };
  Session.prototype._rxHost = function (pkt) {
    if (pkt.type === T.JOIN_REQ && this.state === 'LOBBY') {
      var jr = unpackJoinReq(pkt.payload);
      var existing = null; this.roster.forEach(function (p) { if (p.eph === jr.eph) existing = p; });
      if (!existing) {
        if (this.roster.length >= this.maxPlayers) return;
        var id = this._nextId();
        var p = { id: id, eph: jr.eph, name: jr.meta.name, color: jr.meta.color, gender: jr.meta.gender };
        this.roster.push(p);
        if (this.cb.onRoster) this.cb.onRoster(this.roster.slice());
        existing = p;
      }
      this._send(T.JOIN_ACK, packJoinAck(jr.eph, existing.id));
      this._send(T.ROSTER, packRoster(this.roster));
    } else if (pkt.type === T.MOVE && this.state === 'IN_GAME') {
      var mv = unpackMove(pkt.payload);
      if (mv.playerId === this.activeId && (this.scores[mv.playerId] || {})[mv.category] == null) {
        if (this._applyMove(mv)) { this._send(T.STATE, packStateDelta(this.version, mv)); this._advance(); }
      } else {
        this._send(T.STATE, packStateDelta(this.version, { playerId: mv.playerId, category: mv.category, score: (this.scores[mv.playerId] || {})[mv.category] || 0 }));
      }
    } else if (pkt.type === T.RESYNC_REQ) {
      this._send(T.STATE, packStateSnapshot(this.version, this.scores));
    } else if (pkt.type === T.PONG) {
      if (this.cb.onAlive) this.cb.onAlive(pkt.sender);
    }
  };
  Session.prototype._nextId = function () { var used = {}; this.roster.forEach(function (p) { used[p.id] = 1; }); var i = 1; while (used[i]) i++; return i; };
  Session.prototype._rxClient = function (pkt) {
    if (pkt.type === T.BEACON) {
      this.sessionId = unpackBeacon(pkt.payload).sessionId;
      if (this.cb.onBeacon) this.cb.onBeacon();
      if (this._wantJoin && !this._acked) this._sendJoin();
    } else if (pkt.type === T.JOIN_ACK) {
      var ja = unpackJoinAck(pkt.payload);
      if (ja.eph === this.eph) { this.myId = ja.id; this._acked = true; this.state = 'IN_LOBBY'; this._ct(this._timers.join); if (this.cb.onJoined) this.cb.onJoined(ja.id); }
    } else if (pkt.type === T.ROSTER) {
      this.roster = unpackRoster(pkt.payload);
      if (this.cb.onRoster) this.cb.onRoster(this.roster.slice());
    } else if (pkt.type === T.START) {
      var st = unpackStart(pkt.payload);
      this.roster = st.players; this.version = st.version; this.order = st.players.map(function (p) { return p.id; });
      this.scores = {}; this.state = 'IN_GAME';
      if (this.cb.onStart) this.cb.onStart(this.roster.slice(), this.order.slice());
      this._applyActive(st.firstId);
    } else if (pkt.type === T.GRANT) {
      var g = unpackGrant(pkt.payload);
      if (g.version > this.version + 0 && g.version > this.version) { /* maybe gap; resync if behind */ }
      this._applyActive(g.activeId);
    } else if (pkt.type === T.STATE) {
      this._rxState(unpackState(pkt.payload));
    } else if (pkt.type === T.PING) {
      this._send(T.PONG, new Uint8Array(0));
    } else if (pkt.type === T.END) {
      this.state = 'GAME_OVER'; if (this.cb.onEnd) this.cb.onEnd();
    }
  };
  Session.prototype._applyActive = function (id) {
    this.activeId = id;
    if (this.cb.onTurn) this.cb.onTurn(id, id === this.myId);
  };
  Session.prototype._rxState = function (s) {
    if (s.kind === 'snapshot') {
      this.scores = s.scores; this.version = s.version;
      if (this.cb.onResync) this.cb.onResync(this.scores, this.version);
      return;
    }
    // delta
    if (s.version <= this.version) {                  // already applied (idempotent)
      if (this._pendingMove && s.playerId === this.myId && s.category === this._pendingMove.category) { this._ct(this._timers.mymove); this._pendingMove = null; }
      return;
    }
    if (s.version > this.version + 1) { this._send(T.RESYNC_REQ, new Writer().u16(this.version).out()); return; } // gap → resync
    if (!this.scores[s.playerId]) this.scores[s.playerId] = {};
    this.scores[s.playerId][s.category] = s.score;
    this.version = s.version;
    if (this._pendingMove && s.playerId === this.myId && s.category === this._pendingMove.category) { this._ct(this._timers.mymove); this._pendingMove = null; }
    if (this.cb.onMove) this.cb.onMove({ playerId: s.playerId, category: s.category, score: s.score });
  };

  function crc16(bytes) { var c = 0xffff; for (var i = 0; i < bytes.length; i++) { c ^= bytes[i] << 8; for (var k = 0; k < 8; k++) c = (c & 0x8000) ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff; } return c; }

  // ---- [GAME-SPECIFIC] compact game-record codec (for acoustic transfer) ----
  // Sends per turn only the FINAL dice + category (manual-style), so a transferred
  // game stays small; the board mask is reconstructed from the category order on
  // the receiving end. The wire is a fixed schema of primitives — no structure,
  // names, or anything executable can ride along.
  function packRecord(rec, catKeys) {
    var idx = {}; catKeys.forEach(function (k, i) { idx[k] = i; });
    var w = new Writer().u8(1);
    var secs = Math.floor((rec.ts || Date.now()) / 1000);
    w.u16((secs >>> 16) & 0xffff).u16(secs & 0xffff);
    w.u8((rec.manualMode ? 1 : 0) | (rec.ownerSkipped ? 2 : 0));
    w.u8(rec.players.length);
    rec.players.forEach(function (p, pi) {
      w.u8((p.owner ? 1 : 0) | (p.isAI ? 2 : 0));
      w.bytes(hexRGB(p.color)); w.u8(genIx(p.gender)); w.str(p.name, 28); w.u16(Math.max(0, Math.min(65535, (p.bonus | 0))));
      var mask = 0; catKeys.forEach(function (k, i) { if (typeof (p.scores || {})[k] === 'number') mask |= (1 << i); });
      w.u16(mask);
      catKeys.forEach(function (k, i) { if (mask & (1 << i)) w.u16(Math.max(0, Math.min(65535, p.scores[k] | 0))); });
      var log = (rec.moveLog && rec.moveLog[pi]) || [];
      log = log.slice(0, catKeys.length); w.u8(log.length);
      log.forEach(function (t) {
        var fd = t.dice || (t.rolls && t.rolls[t.rolls.length - 1]) || [0, 0, 0, 0, 0];
        for (var j = 0; j < 5; j++) w.u8(Math.max(0, Math.min(6, fd[j] | 0)));
        w.u8(idx[t.category] == null ? 0 : idx[t.category]);
      });
    });
    return w.out();
  }
  function unpackRecord(bytes, catKeys) {
    var r = new Reader(bytes); r.u8();                       // version
    var secs = (r.u16() << 16) | r.u16(), flags = r.u8(), n = r.u8(), players = [], moveLog = [];
    for (var pi = 0; pi < n; pi++) {
      var pf = r.u8(), rgb = r.bytes(3), g = r.u8(), name = r.str(), bonus = r.u16();
      var mask = r.u16(), scores = {};
      for (var i = 0; i < catKeys.length; i++) if (mask & (1 << i)) scores[catKeys[i]] = r.u16();
      players.push({ owner: !!(pf & 1), isAI: !!(pf & 2), color: rgbHex(rgb), gender: GENDERS[g] || 'm', name: name, bonus: bonus, scores: scores });
      var nt = r.u8(), turns = [], built = 0;
      for (var ti = 0; ti < nt; ti++) {
        var dice = []; for (var j = 0; j < 5; j++) dice.push(r.u8());
        var ci = r.u8(), key = catKeys[ci] || catKeys[0];
        turns.push({ mask: built, dice: dice, category: key });   // mask = board before this turn
        built |= (1 << ci);
      }
      moveLog.push(turns);
    }
    // transferred games analyse manual-style (final dice + pick); fits unpacked moveLog
    return { ts: secs * 1000, manualMode: true, ownerSkipped: !!(flags & 2), acoustic: true, players: players, moveLog: moveLog };
  }

  // ---- SANITISE: turn any received/parsed record into a clean, whitelisted,
  // clamped plain object (or null). Received bytes are DATA only — this guarantees
  // no unknown fields, no non-primitive values, no prototype keys survive. ----
  function sanitizeRecord(obj, catKeys) {
    if (!obj || typeof obj !== 'object' || !Array.isArray(obj.players) || obj.players.length < 1 || obj.players.length > 8) return null;
    var keySet = Object.create(null); catKeys.forEach(function (k) { keySet[k] = 1; });   // null-proto: no __proto__ bypass
    function validKey(k) { return keySet[k] === 1; }
    function clampInt(v, lo, hi, d) { v = Math.round(+v); if (!isFinite(v)) v = d; return Math.max(lo, Math.min(hi, v)); }
    function hex(c) { return (typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c)) ? c.toLowerCase() : '#888888'; }
    function gen(g) { return (g === 'm' || g === 'n' || g === 'f') ? g : 'm'; }
    function str(s) { return (typeof s === 'string' ? s : '').slice(0, 40) || 'Боец'; }
    function d5(a) { a = Array.isArray(a) ? a : []; var o = []; for (var j = 0; j < 5; j++) o.push(clampInt(a[j], 0, 6, 0)); return o; }
    var players = obj.players.map(function (p) {
      p = p || {}; var scores = {};
      if (p.scores && typeof p.scores === 'object') catKeys.forEach(function (k) { if (typeof p.scores[k] === 'number' && isFinite(p.scores[k])) scores[k] = clampInt(p.scores[k], 0, 1000, 0); });
      return { name: str(p.name), color: hex(p.color), gender: gen(p.gender), isAI: !!p.isAI, owner: !!p.owner,
               bonus: clampInt(p.bonus, 0, 999, 0), scores: scores,
               ribbons: Array.isArray(p.ribbons) ? p.ribbons.filter(function (x) { return typeof x === 'string' && /^#?[0-9a-fA-F]{3,8}$/.test(x); }).slice(0, 8) : [] };
    });
    var moveLog = [];
    for (var i = 0; i < players.length; i++) {
      var ml = (Array.isArray(obj.moveLog) && Array.isArray(obj.moveLog[i])) ? obj.moveLog[i] : [];
      moveLog.push(ml.slice(0, catKeys.length).map(function (t) {
        t = t || {};
        var clean = { mask: clampInt(t.mask, 0, 0xffff, 0), category: validKey(t.category) ? t.category : catKeys[0] };
        if (Array.isArray(t.rolls)) { clean.rolls = t.rolls.slice(0, 3).map(d5); clean.keeps = (Array.isArray(t.keeps) ? t.keeps.slice(0, 2) : []).map(function (k) { k = Array.isArray(k) ? k : []; var o = []; for (var j = 0; j < 5; j++) o.push(!!k[j]); return o; }); }
        if (Array.isArray(t.dice)) clean.dice = d5(t.dice);
        return clean;
      }));
    }
    return { ts: clampInt(obj.ts, 0, 1e15, Date.now()) || Date.now(), manualMode: !!obj.manualMode, ownerSkipped: !!obj.ownerSkipped, players: players, moveLog: moveLog };
  }

  // ============================================================ acoustic record transfer
  // Stop-and-wait chunked transfer over the same channel/framing. SENDER advertises
  // (XOFFER), RECEIVER wants (XWANT); once paired by a 1-byte tag they ping-pong
  // XDATA/XACK (one talker at a time fits the medium), then XDONE with a whole-blob
  // CRC-16. The blob is a packRecord() payload, so what arrives is pure data.
  function Transfer(opts) {
    this.tp = opts.transport;
    this.mode = opts.mode;                 // 'send' | 'recv'
    this.cb = opts.callbacks || {};
    this._st = opts.setTimeout || function (f, ms) { return setTimeout(f, ms); };
    this._ct = opts.clearTimeout || function (id) { clearTimeout(id); };
    this.rand = opts.rand || Math.random;
    this.p = { advert: 1300, ack: 4000, retransmit: 10 };
    if (opts.params) for (var k in opts.params) this.p[k] = opts.params[k];
    this.chunkSize = Math.max(8, Math.min(40, (this.tp.maxPayload || 48) - 8));
    this.seq = 0; this.tag = 0; this.state = 'HANDSHAKE'; this._timers = {};
    if (this.mode === 'send') {
      this.blob = opts.data instanceof Uint8Array ? opts.data : new Uint8Array(opts.data || []);
      this.chunks = []; for (var i = 0; i < this.blob.length; i += this.chunkSize) this.chunks.push(this.blob.slice(i, i + this.chunkSize));
      if (!this.chunks.length) this.chunks.push(new Uint8Array(0));
      this.tag = 1 + Math.floor(this.rand() * 254); this.cur = 0;
      this.crc = crc16(this.blob);
    } else { this.recv = {}; this.total = null; }
    var self = this; this.tp.onReceive(function (b) { self._rx(b); });
  }
  Transfer.prototype._send = function (type, payload) { var pkt = frame(type, this.mode === 'send' ? 0 : UNASSIGNED, this.seq, payload); this.seq = (this.seq + 1) & 0xff; try { this.tp.send(pkt); } catch (e) {} };
  Transfer.prototype._status = function (s) { if (this.cb.onStatus) this.cb.onStatus(s); };
  Transfer.prototype.dispose = function () { for (var k in this._timers) this._ct(this._timers[k]); this._timers = {}; this.state = 'DONE'; };
  Transfer.prototype.start = function () {
    var self = this;
    if (this.mode === 'send') { this._status('🔊 Предлагам игра…'); (function ad() { if (self.state !== 'HANDSHAKE') return; self._send(T.XOFFER, new Writer().u8(self.tag).u8(self.chunks.length).out()); self._timers.ad = self._st(ad, self.p.advert); })(); }
    else { this._status('🎧 Търся изпращач…'); (function ad() { if (self.state !== 'HANDSHAKE') return; self._send(T.XWANT, new Writer().u8(self.tag).out()); self._timers.ad = self._st(ad, self.p.advert); })(); }
  };
  Transfer.prototype._sendChunk = function () {
    var self = this; this._ct(this._timers.chunk);
    if (this.cur >= this.chunks.length) { this._finishSend(); return; }
    var c = this.chunks[this.cur];
    var w = new Writer().u8(this.tag).u8(this.cur).u8(this.chunks.length).bytes(c);
    var tries = 0;
    (function go() { if (self.state !== 'SENDING') return; self._send(T.XDATA, w.out()); if (self.cb.onProgress) self.cb.onProgress(self.cur, self.chunks.length); if (++tries <= self.p.retransmit) self._timers.chunk = self._st(go, self.p.ack); })();
  };
  Transfer.prototype._finishSend = function () {
    var self = this; this._ct(this._timers.chunk); this.state = 'FIN';
    var tries = 0;
    (function go() { self._send(T.XDONE, new Writer().u8(self.tag).u16(self.crc).out()); if (++tries <= 4) self._timers.fin = self._st(go, self.p.ack); else { self.state = 'DONE'; if (self.cb.onSent) self.cb.onSent(); } })();
  };
  Transfer.prototype._rx = function (bytes) {
    var pkt = unframe(bytes); if (!pkt) return;
    var r = new Reader(pkt.payload);
    if (this.mode === 'send') {
      if (pkt.type === T.XWANT && this.state === 'HANDSHAKE') { if (r.u8() === this.tag) { this._ct(this._timers.ad); this.state = 'SENDING'; this._status('🔊 Изпращам…'); this._sendChunk(); } }
      else if (pkt.type === T.XACK && this.state === 'SENDING') { if (r.u8() === this.tag) { var idx = r.u8(); if (idx === this.cur) { this.cur++; this._sendChunk(); } } }
      else if (pkt.type === T.XACK && this.state === 'FIN') { /* receiver confirms done */ this._ct(this._timers.fin); this.state = 'DONE'; if (this.cb.onSent) this.cb.onSent(); }
    } else {
      if (pkt.type === T.XOFFER && this.state === 'HANDSHAKE') { this.tag = r.u8(); this.total = r.u8(); this._ct(this._timers.ad); this.state = 'RECEIVING'; this._status('🔊 Приемам…'); this._send(T.XWANT, new Writer().u8(this.tag).out()); }
      else if (pkt.type === T.XDATA && this.state === 'RECEIVING') {
        var tag = r.u8(), idx = r.u8(), total = r.u8(); this.total = total;
        if (tag !== this.tag) return;
        var chunk = pkt.payload.slice(3);
        this.recv[idx] = chunk;                              // store (idempotent)
        this._send(T.XACK, new Writer().u8(this.tag).u8(idx).out());
        if (this.cb.onProgress) this.cb.onProgress(Object.keys(this.recv).length, total);
      } else if (pkt.type === T.XDONE && (this.state === 'RECEIVING' || this.state === 'DONE')) {
        if (r.u8() !== this.tag) return; var crc = r.u16();
        this._send(T.XACK, new Writer().u8(this.tag).u8(0xff).out());   // confirm to sender
        if (this.state === 'DONE') return;
        var ok = true; for (var i = 0; i < this.total; i++) if (!this.recv[i]) ok = false;
        if (!ok) { this._status('Липсват части — изчакай…'); return; }
        var parts = []; var len = 0; for (i = 0; i < this.total; i++) { parts.push(this.recv[i]); len += this.recv[i].length; }
        var blob = new Uint8Array(len), off = 0; parts.forEach(function (c) { blob.set(c, off); off += c.length; });
        if (crc16(blob) !== crc) { this._status('Грешка в данните — опитай пак.'); if (this.cb.onError) this.cb.onError('crc'); return; }
        this.state = 'DONE'; if (this.cb.onComplete) this.cb.onComplete(blob);
      }
    }
  };

  var api = {
    T: T, HOST_ID: HOST_ID, GENDERS: GENDERS, crc8: crc8, crc16: crc16, utf8: utf8, utf8d: utf8d,
    packRecord: packRecord, unpackRecord: unpackRecord, sanitizeRecord: sanitizeRecord, Transfer: Transfer,
    Writer: Writer, Reader: Reader, frame: frame, unframe: unframe,
    hexRGB: hexRGB, rgbHex: rgbHex,
    packBeacon: packBeacon, unpackBeacon: unpackBeacon, packJoinReq: packJoinReq, unpackJoinReq: unpackJoinReq,
    packJoinAck: packJoinAck, unpackJoinAck: unpackJoinAck, packRoster: packRoster, unpackRoster: unpackRoster,
    packStart: packStart, unpackStart: unpackStart, packGrant: packGrant, unpackGrant: unpackGrant,
    packMove: packMove, unpackMove: unpackMove, packStateDelta: packStateDelta, packStateSnapshot: packStateSnapshot, unpackState: unpackState,
    Session: Session,
  };
  if (typeof window !== 'undefined') api.AudioFSK = makeAudioFSK();   // browser-only L0
  return api;

  // ============================================================ L0: audio FSK
  // A minimal, dependency-free data-over-sound transport. Binary-FSK per bit over
  // a Goertzel detector, with a sync preamble + length prefix + CRC-16 (since this
  // raw L0 provides no ECC). Browser-only (Web Audio). Best-effort: it implements
  // the spec's transport interface (send/onReceive/maxPayload) and needs real
  // two-device testing to tune for a given room/handset.
  function makeAudioFSK() {
    var F0 = 2700, F1 = 3300, FSYNC = 2300;   // mark/space + preamble tone (upper audible band)
    var BAUD = 50, SR_HINT = 48000;
    function crc16(bytes) { var c = 0xffff; for (var i = 0; i < bytes.length; i++) { c ^= bytes[i] << 8; for (var k = 0; k < 8; k++) c = (c & 0x8000) ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff; } return c; }

    function AudioFSK(opts) {
      opts = opts || {};
      this.maxPayload = 48;
      this.baud = opts.baud || BAUD;
      this.f0 = opts.f0 || F0; this.f1 = opts.f1 || F1; this.fsync = opts.fsync || FSYNC;
      this.ctx = null; this.stream = null; this._cb = null; this._rxTimer = null;
      this._sending = false;
    }
    AudioFSK.prototype.start = function () {
      var self = this;
      var AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
      var resume = this.ctx.resume ? this.ctx.resume() : Promise.resolve();
      return resume.then(function () {
        // CRITICAL: disable mic DSP, it destroys data-over-sound
        return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      }).then(function (stream) {
        self.stream = stream;
        var src = self.ctx.createMediaStreamSource(stream);
        var an = self.ctx.createAnalyser(); an.fftSize = 2048; an.smoothingTimeConstant = 0;
        src.connect(an); self._an = an; self._buf = new Float32Array(an.fftSize);
        self._listen();
        return true;
      });
    };
    AudioFSK.prototype.onReceive = function (cb) { this._cb = cb; };
    // —— TX: emit a length-prefixed, CRC-16'd, FSK-encoded frame ——
    AudioFSK.prototype.send = function (bytes) {
      if (!this.ctx) return Promise.resolve();
      var payload = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      var crc = crc16(payload);
      var full = new Uint8Array(1 + payload.length + 2);
      full[0] = payload.length; full.set(payload, 1); full[full.length - 2] = (crc >> 8) & 255; full[full.length - 1] = crc & 255;
      var bits = []; for (var i = 0; i < full.length; i++) for (var b = 7; b >= 0; b--) bits.push((full[i] >> b) & 1);
      var t = this.ctx.currentTime + 0.05, dt = 1 / this.baud, self = this;
      this._sending = true;
      function tone(freq, start, dur) {
        var o = self.ctx.createOscillator(), g = self.ctx.createGain();
        o.frequency.value = freq; o.connect(g); g.connect(self.ctx.destination);
        g.gain.setValueAtTime(0.0001, start); g.gain.exponentialRampToValueAtTime(0.4, start + 0.004);
        g.gain.setValueAtTime(0.4, start + dur - 0.004); g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
        o.start(start); o.stop(start + dur);
      }
      tone(this.fsync, t, dt * 6); t += dt * 6;                      // preamble
      for (var k = 0; k < bits.length; k++) { tone(bits[k] ? this.f1 : this.f0, t, dt); t += dt; }
      var done = t - this.ctx.currentTime;
      return new Promise(function (res) { setTimeout(function () { self._sending = false; res(); }, done * 1000 + 30); });
    };
    // —— RX: Goertzel power at the three tones; detect preamble, then sample bits ——
    AudioFSK.prototype._goertzel = function (buf, freq) {
      var sr = this.ctx.sampleRate, w = 2 * Math.PI * freq / sr, c = 2 * Math.cos(w), s0 = 0, s1 = 0, s2 = 0;
      for (var i = 0; i < buf.length; i++) { s0 = buf[i] + c * s1 - s2; s2 = s1; s1 = s0; }
      return s1 * s1 + s2 * s2 - c * s1 * s2;
    };
    AudioFSK.prototype._listen = function () {
      var self = this;
      this._rxTimer = setInterval(function () {
        if (!self._an || self._sending) return;          // half-duplex: don't listen while talking
        self._an.getFloatTimeDomainData(self._buf);
        // (sampling/decoding loop intentionally simple; tune per device)
        var ps = self._goertzel(self._buf, self.fsync), p0 = self._goertzel(self._buf, self.f0), p1 = self._goertzel(self._buf, self.f1);
        self._decode(ps, p0, p1);
      }, 1000 / (this.baud * 4));
    };
    // A pragmatic bit-clock decoder: lock on preamble energy, then read bytes.
    AudioFSK.prototype._decode = function (ps, p0, p1) {
      var st = this._d || (this._d = { phase: 'idle', bits: [], hi: 0 });
      var loud = Math.max(ps, p0, p1), thresh = 1e-4;
      if (st.phase === 'idle') { if (ps > thresh && ps > p0 && ps > p1) { st.phase = 'data'; st.bits = []; st.q = 0; } return; }
      if (loud < thresh) { if (++st.q > 8) this._finish(st); return; }
      st.q = 0; st.bits.push(p1 > p0 ? 1 : 0);
      if (st.bits.length >= 8 && st.bits.length % 8 === 0) {
        // peek length once we have the first byte
        if (st.len == null && st.bits.length >= 8) { st.len = bitsToByte(st.bits, 0); }
        if (st.len != null && st.bits.length >= (1 + st.len + 2) * 8) this._finish(st);
      }
    };
    AudioFSK.prototype._finish = function (st) {
      this._d = null;
      var nbytes = Math.floor(st.bits.length / 8); if (nbytes < 3) return;
      var bytes = new Uint8Array(nbytes); for (var i = 0; i < nbytes; i++) bytes[i] = bitsToByte(st.bits, i * 8);
      var len = bytes[0]; if (len + 3 > bytes.length) return;
      var payload = bytes.slice(1, 1 + len), got = (bytes[1 + len] << 8) | bytes[1 + len + 1];
      if (crc16(payload) !== got) return;                 // failed CRC ⇒ drop
      if (this._cb) try { this._cb(payload); } catch (e) {}
    };
    function bitsToByte(bits, off) { var v = 0; for (var i = 0; i < 8; i++) v = (v << 1) | (bits[off + i] || 0); return v; }
    AudioFSK.prototype.stop = function () {
      if (this._rxTimer) clearInterval(this._rxTimer);
      if (this.stream) this.stream.getTracks().forEach(function (t) { t.stop(); });
      if (this.ctx && this.ctx.close) this.ctx.close();
      this.ctx = null;
    };
    return AudioFSK;
  }
});
