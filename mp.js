// Генерал — multiplayer protocol (host-authoritative), used over a pluggable transport.
//
// Layered per the spec: L0 transport (pluggable; e.g. the WebRTC data-channel bus
// in net.js), L1 framing (+CRC-8), L2 session/lobby, L3 game sync with
// General-specific MOVE/STATE payloads. The whole stack below is dependency-free
// and the protocol logic is pure (DOM-free), so it unit-tests with a mock
// transport.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MP = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---- message vocabulary (TYPE values are stable wire constants) ----
  var T = {
    BEACON: 1, JOIN_REQ: 2, JOIN_ACK: 3, ROSTER: 4, START: 5,
    GRANT: 6, MOVE: 7, STATE: 8, RESYNC_REQ: 9, PING: 10, PONG: 11, END: 12,
    META: 13, READY: 14, PREP: 15, AICTRL: 16,              // lobby preparation + AI takeover
    TACT: 17,                                               // live turn action (spectating: roll/reroll/commit)
    SPUR: 18,                                               // lobby „ДАЙ ЗОР" cheer (player id + heat)
    JOIN_NAK: 19,                                           // host rejects a join (e.g. game-mode mismatch)
    BYE: 25,                                                // host disbands the lobby — clients return to host/join
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
  Writer.prototype.i16 = function (v) { v = v | 0; if (v < -32768) v = -32768; else if (v > 32767) v = 32767; this.b.push((v >>> 8) & 0xff, v & 0xff); return this; };   // signed: minus-ruleset scores go negative
  Writer.prototype.bytes = function (arr) { for (var i = 0; i < arr.length; i++) this.b.push(arr[i] & 0xff); return this; };
  Writer.prototype.str = function (s, maxLen) { var e = utf8(String(s == null ? '' : s)); if (maxLen && e.length > maxLen) e = e.slice(0, maxLen); this.u8(e.length); this.bytes(e); return this; };
  Writer.prototype.str16 = function (s) { var e = utf8(String(s == null ? '' : s)); this.u16(e.length & 0xffff); this.bytes(e); return this; };   // longer payloads (e.g. a turn log)
  Writer.prototype.out = function () { return new Uint8Array(this.b); };
  function Reader(bytes) { this.b = bytes; this.i = 0; }
  Reader.prototype.u8 = function () { return this.b[this.i++]; };
  Reader.prototype.u16 = function () { var v = (this.b[this.i] << 8) | this.b[this.i + 1]; this.i += 2; return v; };
  Reader.prototype.i16 = function () { var v = this.u16(); return v >= 0x8000 ? v - 0x10000 : v; };   // sign-extend (back-compat: positive values read identically to u16)
  Reader.prototype.bytes = function (n) { var s = this.b.slice(this.i, this.i + n); this.i += n; return s; };
  Reader.prototype.str = function () { return utf8d(this.bytes(this.u8())); };
  Reader.prototype.str16 = function () { return utf8d(this.bytes(this.u16())); };
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
  function writeMeta(w, p) { w.u8(p.id || 0); w.bytes(hexRGB(p.color)); w.u8(genIx(p.gender)); w.u8((p.ready ? 1 : 0) | (p.isAI ? 2 : 0) | (p.dropped ? 4 : 0)); w.str(p.name, 28); }
  function readMeta(r) { var id = r.u8(), rgb = r.bytes(3), g = r.u8(), fl = r.u8(), name = r.str(); return { id: id, color: rgbHex(rgb), gender: GENDERS[g] || 'm', ready: !!(fl & 1), isAI: !!(fl & 2), dropped: !!(fl & 4), name: name }; }
  // a player's self-edit in the lobby (sender identifies the player; can't edit others)
  function packMetaUpd(meta) { var w = new Writer(); w.bytes(hexRGB(meta.color)); w.u8(genIx(meta.gender)); w.str(meta.name, 28); return w.out(); }
  function unpackMetaUpd(p) { var r = new Reader(p); return { color: rgbHex(r.bytes(3)), gender: GENDERS[r.u8()] || 'm', name: r.str() }; }
  function packReady(ready) { return new Writer().u8(ready ? 1 : 0).out(); }
  function unpackReady(p) { return !!(new Reader(p).u8() & 1); }
  function packPrep(settingsBits) { return new Writer().u8(settingsBits & 0xff).out(); }       // host → all: enter lobby prep + enabled-settings summary
  function unpackPrep(p) { return new Reader(p).u8(); }
  function packAICtrl(id, on) { return new Writer().u8(id).u8(on ? 1 : 0).out(); }              // host → all: a seat is now AI-driven (display)
  function unpackAICtrl(p) { var r = new Reader(p); return { id: r.u8(), on: !!r.u8() }; }
  function packSpur(id, heat, clicks) { return new Writer().u8(id).u8(Math.max(0, Math.min(255, Math.round(heat * 255)))).u8(Math.max(0, Math.min(255, clicks || 0))).out(); }
  function unpackSpur(p) { var r = new Reader(p); return { id: r.u8(), heat: r.u8() / 255, clicks: r.u8() }; }
  // TACT — the active player's live turn action so everyone else can WATCH (display-only):
  // a roll/reroll (dice + remaining throws + which dice are freshly rolled) or a commit (category+value).
  function packAct(a) {
    var w = new Writer().u8(a.playerId).u8(a.commit ? 1 : 0).u8(a.throwsLeft || 0)
      .u8(a.category == null ? 255 : a.category).i16(a.value || 0).u8(a.mask || 0);
    for (var i = 0; i < 5; i++) w.u8((a.dice && a.dice[i]) || 0);
    return w.out();
  }
  function unpackAct(p) {
    var r = new Reader(p), a = { playerId: r.u8(), commit: !!r.u8(), throwsLeft: r.u8(), category: r.u8(), value: r.i16(), mask: r.u8(), dice: [] };
    if (a.category === 255) a.category = null;
    for (var i = 0; i < 5; i++) a.dice.push(r.u8());
    return a;
  }

  // ---- [GAME-SPECIFIC] payload schemas ----
  function packBeacon(sessionId, slotsFree) { return new Writer().u8(sessionId).u8(slotsFree).out(); }
  function unpackBeacon(p) { var r = new Reader(p); return { sessionId: r.u8(), slotsFree: r.u8() }; }
  function packJoinReq(eph, meta, manual) { var w = new Writer().u16(eph).u8(manual ? 1 : 0); writeMeta(w, { id: 0, name: meta.name, color: meta.color, gender: meta.gender }); return w.out(); }
  function unpackJoinReq(p) { var r = new Reader(p), eph = r.u16(), manual = !!(r.u8() & 1); return { eph: eph, manual: manual, meta: readMeta(r) }; }
  // JOIN_ACK also carries the host's game mode — the client adopts it (the host's rules are authoritative)
  // the flags byte carries the host's game mode (bit0 = manual) AND ruleset (bit1 = experimental)
  function packJoinAck(eph, assignedId, manual, exp) { return new Writer().u16(eph).u8(assignedId).u8((manual ? 1 : 0) | (exp ? 2 : 0)).out(); }
  function packJoinNak(eph, reason) { return new Writer().u16(eph).u8(reason || 0).out(); }
  function unpackJoinNak(p) { var r = new Reader(p); return { eph: r.u16(), reason: r.u8() }; }
  function unpackJoinAck(p) { var r = new Reader(p), eph = r.u16(), id = r.u8(), f = r.left() ? r.u8() : 0; return { eph: eph, id: id, manual: !!(f & 1), exp: !!(f & 2) }; }
  function packRoster(players) { var w = new Writer().u8(players.length); players.forEach(function (p) { writeMeta(w, p); }); return w.out(); }
  function unpackRoster(p) { var r = new Reader(p), n = r.u8(), a = []; for (var i = 0; i < n; i++) a.push(readMeta(r)); return a; }
  function packStart(version, firstId, players) { var w = new Writer().u16(version).u8(firstId).u8(players.length); players.forEach(function (p) { writeMeta(w, p); }); return w.out(); }
  function unpackStart(p) { var r = new Reader(p), version = r.u16(), firstId = r.u8(), n = r.u8(), a = []; for (var i = 0; i < n; i++) a.push(readMeta(r)); return { version: version, firstId: firstId, players: a }; }
  function packGrant(activeId, version) { return new Writer().u8(activeId).u16(version).out(); }
  function unpackGrant(p) { var r = new Reader(p); return { activeId: r.u8(), version: r.u16() }; }
  // ---- [GAME-SPECIFIC] L3 payloads are the CANONICAL game shape, JSON-encoded
  // (Task A 5c-remainder). Transport is a dumb pipe: a MOVE/STATE payload IS a serialized
  // move action / scoreboard projection, not a hand-packed binary sidecar. The L1 frame
  // (type/sender/seq/CRC) is unchanged — only these payload bytes became a UTF-8 JSON
  // string, exactly as the `log` field already was. No wire back-compat is needed (everyone
  // plays the single live version). JSON also natively carries negative (minus-ruleset)
  // scores and removes the old ±32768 i16 clamp.
  function packJSON(obj) { return utf8(JSON.stringify(obj)); }
  function unpackJSON(p) { return JSON.parse(utf8d(p)); }

  // MOVE — the active player's completed turn as a move action `{playerId, category, score, log}`.
  // category is the numeric index (net.js bridges index↔key via catIndexOf/catKeyAt at the edge);
  // the full per-player turn detail (rolls/keeps/…) rides inside the JSON `log`, so the old binary
  // rolls/keeps sidecar (never read on receive) and the unused ackVersion are gone.
  function packMove(m) { return packJSON({ playerId: m.playerId, category: m.category, score: m.score, log: m.log || '' }); }
  function unpackMove(p) { var m = unpackJSON(p); return { playerId: m.playerId, category: m.category, score: m.score, log: m.log || '' }; }
  // STATE — kind 'delta' (one applied move action) or 'snapshot' (full scoreboard projection, re-baseline on resync)
  function packStateDelta(version, mv) { return packJSON({ kind: 'delta', version: version, playerId: mv.playerId, category: mv.category, score: mv.score, log: mv.log || '' }); }
  function packStateSnapshot(version, scores) { return packJSON({ kind: 'snapshot', version: version, scores: scores }); }
  function unpackState(p) {
    var s = unpackJSON(p);
    if (s.kind === 'snapshot') return { kind: 'snapshot', version: s.version, scores: s.scores || {} };
    return { kind: 'delta', version: s.version, playerId: s.playerId, category: s.category, score: s.score, log: s.log || '' };
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
    this.manual = !!opts.manual;                 // manual (ОТЧЕТ) game: free-for-all, no turn order/spectating
    this.exp = !!opts.exp;                        // ruleset flag (experimental „с минуси") — opaque metadata; host's wins
    this.cb = opts.callbacks || {};
    this._st = opts.setTimeout || function (f, ms) { return setTimeout(f, ms); };
    this._ct = opts.clearTimeout || function (id) { clearTimeout(id); };
    this.rand = opts.rand || Math.random;
    this.p = {};
    // intervals are deliberately relaxed: beacons/joins re-send on a slow cadence so
    // retransmits don't pile up on a flaky link — comfortable defaults for WebRTC.
    var dflt = { beacon: 3500, joinRetry: 4500, moveTimeout: 20000, retransmit: 4 };
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
    // eph identifies a client across reconnects: a returning player reuses its eph so the
    // host recognises it (clears its dropped flag + catches it up) rather than seating a new boец.
    this.eph = this.isHost ? 0 : (opts.eph || (1 + Math.floor(this.rand() * 60000)));
    this._lastBytes = null;            // immediate-dup filter
    this._timers = {};
    this._wantJoin = false;
    this._acked = false;
    var self = this;
    this.tp.onReceive(function (bytes) { self._rx(bytes); });
    this.settingsBits = 0;             // host's enabled pre-game settings (summary shown to clients)
    this.takeover = {};                // host: id → true when that seat is AI-driven mid-game
    this.paused = {};                  // host: id → true when a dropped seat is paused (skipped; doesn't block the finish)
    if (this.isHost) this.roster.push({ id: HOST_ID, name: this.me.name, color: this.me.color, gender: this.me.gender, ready: true, isAI: false });
  }
  Session.prototype._status = function (s) { if (this.cb.onStatus) this.cb.onStatus(s); };
  Session.prototype._send = function (type, payload) {
    var sender = this.myId == null ? UNASSIGNED : this.myId;
    var pkt = frame(type, sender, this.seq, payload);
    this.seq = (this.seq + 1) & 0xff;
    try { return this.tp.send(pkt); } catch (e) { return Promise.resolve(); }
  };
  Session.prototype.dispose = function () { var t = this._timers; for (var k in t) this._ct(t[k]); this._timers = {}; this.state = 'DEAD'; };
  // host: tell every client the lobby is being cancelled (they return to the host/join picker)
  Session.prototype.disband = function () { if (this.isHost) this._send(T.BYE, new Uint8Array(0)); };

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
  // ---------- host: lobby preparation (scan → prep → start) ----------
  // §lobby host closes the scan and moves everyone into preparation: joins are
  // frozen, the enabled-settings summary is published, and players ready up.
  Session.prototype.startPrep = function (settingsBits) {
    if (!this.isHost) return false;
    this._ct(this._timers.beacon);
    this.state = 'PREP';
    this.settingsBits = settingsBits & 0xff;
    this._send(T.PREP, packPrep(this.settingsBits));
    this._send(T.ROSTER, packRoster(this.roster));
    if (this.cb.onPrep) this.cb.onPrep(this.settingsBits, true);
    if (this.cb.onRoster) this.cb.onRoster(this.roster.slice());
    return true;
  };
  // host republishes the settings summary when it changes a pre-game toggle
  Session.prototype.setSettings = function (settingsBits) {
    if (!this.isHost || this.state !== 'PREP') return;
    this.settingsBits = settingsBits & 0xff;
    this._send(T.PREP, packPrep(this.settingsBits));
    if (this.cb.onPrep) this.cb.onPrep(this.settingsBits, true);
  };
  // a player edits their OWN name/colour/gender (host applies + dedupes + rebroadcasts)
  Session.prototype.setMyMeta = function (meta) {
    if (this.isHost) {
      var me = this._byId(HOST_ID); if (!me) return;
      this._applyMeta(me, meta);
      this._send(T.ROSTER, packRoster(this.roster));
      if (this.cb.onRoster) this.cb.onRoster(this.roster.slice());
    } else {
      this._send(T.META, packMetaUpd(meta));
    }
  };
  // ready toggle (host implicitly ready; clients send READY)
  Session.prototype.setReady = function (ready) {
    if (this.isHost) return;            // the host starts the game; it has no ready button
    this._send(T.READY, packReady(ready));
  };
  // host adds an AI seat (only the host can; AI is always "ready")
  Session.prototype.addAI = function (meta) {
    if (!this.isHost || this.roster.length >= this.maxPlayers) return null;
    var p = { id: this._nextId(), name: this._uniqueName(meta.name), color: this._uniqueColor(meta.color), gender: meta.gender || 'm', ready: true, isAI: true };
    this.roster.push(p);
    this._send(T.ROSTER, packRoster(this.roster));
    if (this.cb.onRoster) this.cb.onRoster(this.roster.slice());
    return p;
  };
  Session.prototype.removeAI = function (id) {
    if (!this.isHost) return;
    var before = this.roster.length;
    this.roster = this.roster.filter(function (p) { return !(p.id === id && p.isAI); });
    if (this.roster.length !== before) { this._send(T.ROSTER, packRoster(this.roster)); if (this.cb.onRoster) this.cb.onRoster(this.roster.slice()); }
  };
  Session.prototype._byId = function (id) { for (var i = 0; i < this.roster.length; i++) if (this.roster[i].id === id) return this.roster[i]; return null; };
  Session.prototype._applyMeta = function (entry, meta) {
    var self = this;
    function freeColor(c) { var used = self.roster.filter(function (p) { return p !== entry; }).map(function (p) { return (p.color || '').toLowerCase(); }); if (used.indexOf((c || '').toLowerCase()) < 0) return c; for (var i = 0; i < PALETTE.length; i++) if (used.indexOf(PALETTE[i].toLowerCase()) < 0) return PALETTE[i]; return c; }
    function freeName(n) { var used = {}; self.roster.forEach(function (p) { if (p !== entry) used[(p.name || '').toLowerCase()] = 1; }); if (!used[(n || '').toLowerCase()]) return n || 'Боец'; var base = n || 'Боец', i = 2; while (used[(base + ' ' + i).toLowerCase()]) i++; return base + ' ' + i; }
    if (meta.color != null) entry.color = freeColor(meta.color);
    if (meta.gender != null) entry.gender = meta.gender;
    if (meta.name != null) entry.name = freeName(meta.name);
  };
  // host: every joined human (not host, not AI) has readied — and we have a quorum
  Session.prototype.allReady = function () {
    if (this.roster.length < this.minPlayers) return false;
    return this.roster.every(function (p) { return p.id === HOST_ID || p.isAI || p.ready; });
  };
  Session.prototype.startGame = function () {
    if (!this.isHost || this.roster.length < this.minPlayers) return false;
    this._ct(this._timers.beacon);
    this.state = 'IN_GAME';
    this.order = this.roster.map(function (p) { return p.id; });
    this.version = 0; this.turnIx = 0;
    this._send(T.START, packStart(this.version, this.order[0], this.roster));
    if (this.cb.onStart) this.cb.onStart(this.roster.slice(), this.order.slice());
    if (!this.manual) this._grant();   // manual = free-for-all: no turn token
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
    if (this.isAIControlled(this.activeId)) return;  // host drives this seat locally; nothing to wait for
    (function arm() {
      self._timers.move = self._st(function () {
        if (self.state !== 'IN_GAME') return;
        if (++self._tries > self.p.retransmit) { self._status('Боец ' + self.activeId + ' мълчи…'); return; }
        self._send(T.GRANT, packGrant(self.activeId, self.version)); arm();   // lost GRANT? re-grant
      }, self.p.moveTimeout);
    })();
  };
  Session.prototype._filled = function (id) { return Object.keys(this.scores[id] || {}).length; };
  Session.prototype._boardDone = function (id) { return this._filled(id) >= this.rounds; };
  // a seat still owes turns unless its board is full, or it has dropped and isn't AI-driven
  // (a dropped player is skipped so the rest can finish; an AI takeover keeps playing the seat)
  Session.prototype._needsTurn = function (id) {
    if (this._filled(id) >= this.rounds) return false;
    if (this.paused[id]) return false;                                  // host paused this seat → skip it in the rotation
    var e = this._byId(id);
    if (e && e.dropped && !this.isAIControlled(id)) return false;
    return true;
  };
  // the game ENDS only when every board is full. A turn game keeps running while any board is
  // incomplete — even a merely DROPPED seat keeps it open (waiting for a reconnect / AI takeover)
  // instead of ending and stranding that player's remaining categories. A manual (free-for-all)
  // game still lets a dropped seat go so the rest can finish.
  Session.prototype._allDone = function () {
    var self = this;
    return this.order.every(function (id) {
      if (self._boardDone(id)) return true;
      if (self.paused[id]) return true;   // a paused seat no longer blocks the finish (it forfeits unless it returns in time)
      if (self.manual) { var e = self._byId(id); return !!(e && e.dropped && !self.isAIControlled(id)); }
      return false;
    });
  };

  // ---------- applying a move (host authoritative) ----------
  Session.prototype._applyMove = function (mv) {
    if (!this.scores[mv.playerId]) this.scores[mv.playerId] = {};
    if (this.scores[mv.playerId][mv.category] != null) return false;   // idempotent: already recorded
    this.scores[mv.playerId][mv.category] = mv.score;
    this.version++;
    if (this.cb.onMove) this.cb.onMove(mv);
    return true;
  };

  // lobby cheer: broadcast my „ДАЙ ЗОР" heat so everyone sees it on my entry (host relays)
  Session.prototype.sendSpur = function (heat, clicks) { if (this.state.indexOf('PREP') < 0 && this.state.indexOf('LOBBY') < 0) return; this._send(T.SPUR, packSpur(this.myId, heat, clicks)); };
  // the local active player broadcasts a live turn action (display-only; spectators render it).
  // host → all clients; a client → host, which relays to the rest.
  Session.prototype.sendAction = function (a) {
    if (this.state !== 'IN_GAME') return;
    a.playerId = this.myId;
    this._send(T.TACT, packAct(a));
  };
  // the local active player submits their completed turn
  Session.prototype.submitMove = function (mv) {
    mv.playerId = this.myId;
    if (this.isHost) {
      // manual = free-for-all: apply my own move and broadcast, no turn advance (just maybe end)
      if (this._applyMove(mv)) { this._send(T.STATE, packStateDelta(this.version, mv)); if (this.manual) this._maybeEnd(); else this._advance(); }
    } else {
      this._pendingMove = mv;
      this._sendMove();
    }
  };
  // manual end-check: when every (non-dropped) board is complete, the game is over
  Session.prototype._maybeEnd = function () {
    if (this._allDone()) { this.state = 'GAME_OVER'; this._send(T.END, new Uint8Array(0)); if (this.cb.onEnd) this.cb.onEnd(); }
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
  // ---------- host: AI takeover of a (dropped) player ----------
  // The host runs an AI turn locally for a seat it controls and injects the move
  // authoritatively. A seat is host-controlled if it's a lobby AI or a live takeover.
  Session.prototype.isAIControlled = function (id) { var e = this._byId(id); return !!(this.isHost && ((e && e.isAI) || this.takeover[id])); };
  Session.prototype.setTakeover = function (id, on) {
    if (!this.isHost || id === this.myId) return;
    if (on) this.takeover[id] = true; else delete this.takeover[id];
    this._send(T.AICTRL, packAICtrl(id, on));
    if (this.cb.onTakeover) this.cb.onTakeover(id, !!on);
    // resuming on a stalled seat: re-grant so the AI gets prompted immediately
    if (on && this.state === 'IN_GAME' && this.activeId === id) { if (this.cb.onTurn) this.cb.onTurn(id, false); }
    if (on) this._resumeIfPaused();   // the rotation was paused on this (now AI-driven) seat → carry on
  };
  // host: pause/unpause a dropped seat. A paused seat is skipped and no longer blocks the finish, so the
  // game can conclude without it; if it reconnects in time the pause auto-reverts and it catches up.
  Session.prototype.setPaused = function (id, on) {
    if (!this.isHost || id === this.myId) return;
    if (on) this.paused[id] = true; else delete this.paused[id];
    if (this.cb.onPaused) this.cb.onPaused(id, !!on);
    if (this.state !== 'IN_GAME') return;
    if (this.manual) { if (on) this._maybeEnd(); return; }
    if (this.activeId === id) { this._ct(this._timers.move); this._advance(); }   // they held the token → move on (or end)
    else if (this.activeId == null) this._advance();   // we were waiting → re-evaluate now that this seat is skippable
  };
  // host: flag/unflag a player as dropped (connection lost). A dropped seat is skipped in the
  // rotation; if it drops while holding the turn, advance immediately so nobody waits on it.
  Session.prototype.markDropped = function (id, on) {
    if (!this.isHost || id === HOST_ID) return;
    var e = this._byId(id); if (!e || !!e.dropped === !!on) return;
    e.dropped = !!on;
    this._send(T.ROSTER, packRoster(this.roster));
    if (this.cb.onRoster) this.cb.onRoster(this.roster.slice());
    if (this.cb.onDrop) this.cb.onDrop(id, !!on);
    if (on && this.state === 'IN_GAME') {
      if (this.manual) { this._maybeEnd(); }   // a dropped player no longer blocks the finish
      else if (this.activeId === id && !this.isAIControlled(id)) { this._ct(this._timers.move); this._advance(); }   // skip the seat that just vanished mid-turn
    } else if (!on) { this._resumeIfPaused(); }   // a seat came back → resume the rotation if we were waiting on it
  };
  Session.prototype.submitMoveFor = function (playerId, mv) {
    if (!this.isHost || this.state !== 'IN_GAME' || playerId !== this.activeId) return false;
    mv.playerId = playerId;
    if (this._applyMove(mv)) { this._send(T.STATE, packStateDelta(this.version, mv)); this._advance(); return true; }
    return false;
  };
  Session.prototype._advance = function () {
    if (this._allDone()) { this.state = 'GAME_OVER'; this._send(T.END, new Uint8Array(0)); if (this.cb.onEnd) this.cb.onEnd(); return; }
    var n = this.order.length, ix = this.turnIx, guard = 0;
    do { ix++; } while (guard++ < n && !this._needsTurn(this.order[ix % n]));   // skip full + dropped seats
    if (!this._needsTurn(this.order[ix % n])) {   // everyone who still owes a turn is dropped → pause until one returns
      this.activeId = null; this._ct(this._timers.move);
      if (this.cb.onWait) this.cb.onWait();
      return;
    }
    this.turnIx = ix; this._grant();
  };
  // resume a paused rotation (a dropped seat returned, or a takeover began)
  Session.prototype._resumeIfPaused = function () {
    if (this.isHost && this.state === 'IN_GAME' && !this.manual && this.activeId == null) this._advance();
  };
  // re-sync everyone with the host's current authoritative state (idempotent). Used when the host's
  // tab returns to the foreground after a background (iOS) so any missed updates are reconciled.
  Session.prototype.rebroadcast = function () {
    if (!this.isHost || this.state !== 'IN_GAME') return;
    this._send(T.ROSTER, packRoster(this.roster));
    this._send(T.STATE, packStateSnapshot(this.version, this.scores));
    if (!this.manual && this.activeId != null) this._send(T.GRANT, packGrant(this.activeId, this.version));
  };
  // ---------- host crash recovery: snapshot the authoritative state, rebuild it on a fresh host ----------
  // the host persists this; after a reload it re-hosts the SAME code, restore()s, and resumeHost()s.
  // Clients reconnect by eph (the normal mid-game rejoin path) and get caught up via START + STATE.
  Session.prototype.snapshot = function () {
    if (!this.isHost || this.state !== 'IN_GAME') return null;
    return { v: 1, roster: JSON.parse(JSON.stringify(this.roster)), order: this.order.slice(),
      scores: JSON.parse(JSON.stringify(this.scores)), version: this.version, turnIx: this.turnIx,
      activeId: this.activeId, manual: !!this.manual, exp: !!this.exp, settingsBits: this.settingsBits || 0,
      rounds: this.rounds, takeover: JSON.parse(JSON.stringify(this.takeover || {})), paused: JSON.parse(JSON.stringify(this.paused || {})) };
  };
  Session.prototype.restore = function (snap) {
    if (!this.isHost || !snap || !Array.isArray(snap.roster)) return false;
    this.roster = snap.roster; this.order = (snap.order || []).slice(); this.scores = snap.scores || {};
    this.version = snap.version || 0; this.turnIx = snap.turnIx || 0; this.activeId = snap.activeId;
    this.manual = !!snap.manual; this.exp = !!snap.exp; this.settingsBits = snap.settingsBits || 0;
    this.rounds = snap.rounds || this.rounds; this.takeover = snap.takeover || {}; this.paused = snap.paused || {};
    this.roster.forEach(function (p) { if (p.id !== HOST_ID) p.dropped = true; });   // no live channels yet → all clients dropped until they return
    this.state = 'IN_GAME';
    return true;
  };
  // after restore: rebuild the host's local game + boards; re-enter the host's own turn if it held it
  // (a client's turn re-grants when that client reconnects and the host replays START to them).
  Session.prototype.resumeHost = function () {
    if (!this.isHost || this.state !== 'IN_GAME') return;
    if (this.cb.onStart) this.cb.onStart(this.roster.slice(), this.order.slice());
    if (this.cb.onResync) this.cb.onResync(this.scores, this.version);
    if (this.manual) return;
    if (this.activeId === this.myId) { if (this.cb.onTurn) this.cb.onTurn(this.activeId, true); }
    else if (this.cb.onWait) this.cb.onWait();   // a client held the turn → wait for its reconnect to re-grant
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
    this._send(T.JOIN_REQ, packJoinReq(this.eph, this.me, this.manual));
    this._status('🔊 Искам да вляза…');
    var self = this, backoff = this.p.joinRetry + Math.floor(this.rand() * this.p.joinRetry); // ALOHA backoff
    this._timers.join = this._st(function () { self._sendJoin(); }, backoff);
  };
  // client: re-announce after a transport reconnect so the host clears our dropped flag and
  // catches us up. Works mid-game (same eph identifies us); the host answers ACK+ROSTER+STATE.
  Session.prototype.rejoin = function () {
    if (this.isHost) return;
    // a transient reconnect leaves this client's session (and its activeId) intact. The host
    // answers with START/GRANT carrying the SAME activeId, so _applyActive's "changed" guard would
    // suppress onTurn and the returning active player's board would never be re-enabled. Arm a
    // one-shot so the next active-seat broadcast forces a fresh onTurn for US (only). This does NOT
    // affect the host's move-timeout re-GRANT to an ordinary slow player (they aren't rejoining).
    this._rejoining = true;
    this._send(T.JOIN_REQ, packJoinReq(this.eph, this.me, this.manual));
  };

  // ---------- receive / dispatch ----------
  Session.prototype._rx = function (bytes) {
    var pkt = unframe(bytes);
    if (!pkt) return;
    var sig = bytes && bytes.join ? bytes.join(',') : String(bytes);
    if (sig === this._lastBytes) return;   // drop an immediate duplicate retransmit
    this._lastBytes = sig;
    // L3 payloads are JSON (5c-remainder), so unpack* can throw on a malformed payload — unlike the
    // old binary readers. A CRC-valid frame from our own packers is always valid JSON, but treat a
    // parse failure like a failed decode (same as unframe → null above) rather than letting it escape
    // the transport callback. (Reliable WebRTC channels never deliver corrupt bytes; this is defensive.)
    try {
      if (this.isHost) this._rxHost(pkt); else this._rxClient(pkt);
    } catch (e) { return; }
  };
  Session.prototype._rxHost = function (pkt) {
    if (pkt.type === T.JOIN_REQ && this.state === 'LOBBY') {
      var jr = unpackJoinReq(pkt.payload);
      // the host's mode is authoritative: a joiner is admitted regardless of the mode they picked,
      // and adopts the host's mode via the JOIN_ACK (no more mode-mismatch rejection).
      var existing = null; this.roster.forEach(function (p) { if (p.eph === jr.eph) existing = p; });
      if (!existing) {
        if (this.roster.length >= this.maxPlayers) return;
        var id = this._nextId();
        // colours and names must be unique across devices too
        var p = { id: id, eph: jr.eph, name: this._uniqueName(jr.meta.name), color: this._uniqueColor(jr.meta.color), gender: jr.meta.gender };
        this.roster.push(p);
        if (this.cb.onRoster) this.cb.onRoster(this.roster.slice());
        existing = p;
      }
      this._send(T.JOIN_ACK, packJoinAck(jr.eph, existing.id, this.manual, this.exp));
      this._send(T.ROSTER, packRoster(this.roster));
    } else if (pkt.type === T.JOIN_REQ && (this.state === 'IN_GAME' || this.state === 'PREP')) {
      // a known player returning after a drop: re-admit by eph, clear dropped, catch them up.
      var rj = unpackJoinReq(pkt.payload), back = null;
      this.roster.forEach(function (p) { if (p.eph === rj.eph) back = p; });
      if (back) {
        var was = back.dropped; back.dropped = false; delete this.paused[back.id];   // returning seat: revert pause so it catches up
        this._send(T.JOIN_ACK, packJoinAck(rj.eph, back.id, this.manual, this.exp));
        this._send(T.ROSTER, packRoster(this.roster));
        if (this.state === 'IN_GAME') {
          this._send(T.START, packStart(this.version, this.activeId, this.roster));   // rebuild their board (idempotent for others)
          this._send(T.STATE, packStateSnapshot(this.version, this.scores));          // fill in everything they missed
        } else {
          this._send(T.PREP, packPrep(this.settingsBits));
        }
        if (was && this.cb.onDrop) this.cb.onDrop(back.id, false);
        if (this.cb.onRoster) this.cb.onRoster(this.roster.slice());
        this._resumeIfPaused();   // the rotation was waiting on a dropped seat → carry on
      }
    } else if (pkt.type === T.SPUR && this.state === 'PREP') {
      var sp = unpackSpur(pkt.payload);
      if (this._byId(sp.id)) { this._send(T.SPUR, packSpur(sp.id, sp.heat, sp.clicks)); if (this.cb.onSpur) this.cb.onSpur(sp.id, sp.heat, sp.clicks); }   // relay + show
    } else if (pkt.type === T.TACT && this.state === 'IN_GAME') {
      var ta = unpackAct(pkt.payload);
      // a live action proves the active player is alive → reset the silence timer so we don't re-GRANT them
      if (ta.playerId === this.activeId) { this._armMoveTimeout(); this._send(T.TACT, packAct(ta)); if (this.cb.onAction) this.cb.onAction(ta); }   // relay to all + render locally
    } else if (pkt.type === T.MOVE && this.state === 'IN_GAME') {
      var mv = unpackMove(pkt.payload);
      // turn game: only the active player may move. manual game: any player may fill their OWN board.
      var ok = this.manual ? (mv.playerId === pkt.sender) : (mv.playerId === this.activeId);
      if (ok && (this.scores[mv.playerId] || {})[mv.category] == null) {
        if (this._applyMove(mv)) { this._send(T.STATE, packStateDelta(this.version, mv)); if (this.manual) this._maybeEnd(); else this._advance(); }
      } else {
        this._send(T.STATE, packStateDelta(this.version, { playerId: mv.playerId, category: mv.category, score: (this.scores[mv.playerId] || {})[mv.category] || 0, log: mv.log }));
      }
    } else if (pkt.type === T.META && this.state === 'PREP') {
      var entry = this._byId(pkt.sender);                  // a client edits ONLY its own seat
      if (entry && entry.id !== HOST_ID && !entry.isAI) { this._applyMeta(entry, unpackMetaUpd(pkt.payload)); this._send(T.ROSTER, packRoster(this.roster)); if (this.cb.onRoster) this.cb.onRoster(this.roster.slice()); }
    } else if (pkt.type === T.READY && this.state === 'PREP') {
      var re = this._byId(pkt.sender);
      if (re && re.id !== HOST_ID) { re.ready = unpackReady(pkt.payload); this._send(T.ROSTER, packRoster(this.roster)); if (this.cb.onRoster) this.cb.onRoster(this.roster.slice()); }
    } else if (pkt.type === T.RESYNC_REQ) {
      this._send(T.STATE, packStateSnapshot(this.version, this.scores));
    } else if (pkt.type === T.PONG) {
      if (this.cb.onAlive) this.cb.onAlive(pkt.sender);
    }
  };
  Session.prototype._nextId = function () { var used = {}; this.roster.forEach(function (p) { used[p.id] = 1; }); var i = 1; while (used[i]) i++; return i; };
  var PALETTE = ['#d4a02e', '#e07a2e', '#cf4f2e', '#c0392b', '#c2407a', '#9b3fb0', '#6a52c0',
    '#3f5fc0', '#2f86c8', '#2aa0a0', '#2e9e5b', '#6aa83a', '#a39a2e', '#9a6b3a'];
  Session.prototype._uniqueColor = function (c) {
    var used = this.roster.map(function (p) { return (p.color || '').toLowerCase(); });
    if (used.indexOf((c || '').toLowerCase()) < 0) return c;
    for (var i = 0; i < PALETTE.length; i++) if (used.indexOf(PALETTE[i].toLowerCase()) < 0) return PALETTE[i];
    return c;
  };
  Session.prototype._uniqueName = function (n) {
    var used = {}; this.roster.forEach(function (p) { used[(p.name || '').toLowerCase()] = 1; });
    if (!used[(n || '').toLowerCase()]) return n || 'Боец';
    var base = n || 'Боец', i = 2; while (used[(base + ' ' + i).toLowerCase()]) i++; return base + ' ' + i;
  };
  Session.prototype._rxClient = function (pkt) {
    if (pkt.type === T.BEACON) {
      this.sessionId = unpackBeacon(pkt.payload).sessionId;
      if (this.cb.onBeacon) this.cb.onBeacon();
      if (this._wantJoin && !this._acked) this._sendJoin();
    } else if (pkt.type === T.JOIN_ACK) {
      var ja = unpackJoinAck(pkt.payload);
      if (ja.eph === this.eph) { this.myId = ja.id; this.manual = ja.manual; this.exp = ja.exp; this._acked = true; this.state = 'IN_LOBBY'; this._ct(this._timers.join); if (this.cb.onJoined) this.cb.onJoined(ja.id, ja.manual, ja.exp); }
    } else if (pkt.type === T.JOIN_NAK) {
      var jn = unpackJoinNak(pkt.payload);
      if (jn.eph === this.eph && !this._acked) { this._wantJoin = false; this._ct(this._timers.join); this.state = 'SEARCHING'; if (this.cb.onReject) this.cb.onReject(jn.reason); }
    } else if (pkt.type === T.BYE) {
      // host cancelled the lobby — stop trying to join and bubble it up so the UI returns to the picker
      this._wantJoin = false; this._ct(this._timers.join); this.state = 'DEAD';
      if (this.cb.onHostGone) this.cb.onHostGone();
    } else if (pkt.type === T.ROSTER) {
      this.roster = unpackRoster(pkt.payload);
      if (this.cb.onRoster) this.cb.onRoster(this.roster.slice());
    } else if (pkt.type === T.PREP) {
      this.settingsBits = unpackPrep(pkt.payload);
      this.state = 'IN_PREP';
      if (this.cb.onPrep) this.cb.onPrep(this.settingsBits, false);
    } else if (pkt.type === T.AICTRL) {
      var ac = unpackAICtrl(pkt.payload);
      if (ac.on) this.takeover[ac.id] = true; else delete this.takeover[ac.id];
      if (this.cb.onTakeover) this.cb.onTakeover(ac.id, ac.on);
    } else if (pkt.type === T.SPUR) {
      var csp = unpackSpur(pkt.payload);
      if (csp.id !== this.myId && this.cb.onSpur) this.cb.onSpur(csp.id, csp.heat, csp.clicks);   // someone else's cheer
    } else if (pkt.type === T.TACT) {
      var cta = unpackAct(pkt.payload);
      if (cta.playerId !== this.myId && this.cb.onAction) this.cb.onAction(cta);   // watch the active player live
    } else if (pkt.type === T.START) {
      var st = unpackStart(pkt.payload);
      var fresh = (this.state !== 'IN_GAME');         // re-broadcast START (a peer reconnecting) must NOT wipe a live board
      this.roster = st.players; this.order = st.players.map(function (p) { return p.id; });
      if (fresh) {
        this.version = st.version; this.scores = {}; this.state = 'IN_GAME';
        if (this.cb.onStart) this.cb.onStart(this.roster.slice(), this.order.slice());
      } else if (this.cb.onRoster) { this.cb.onRoster(this.roster.slice()); }   // already playing: just refresh the roster
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
    // fire onTurn ONLY when the active seat actually changes. The host re-sends GRANT to a slow
    // player on its move-timeout; without this guard a re-GRANT would re-run the client's beginTurn
    // and reset their dice/throws mid-turn. A reloaded client has activeId=null, so it still fires.
    var changed = this.activeId !== id;
    // ...but a transient reconnect (this.rejoin()) keeps our activeId, so "changed" stays false even
    // though our board needs re-initialising. Force a single re-fire when WE are the returning active
    // seat. Scoped to id===myId so a rebroadcast START to other clients still honours the guard.
    var rejoinSelf = this._rejoining && id === this.myId;
    this._rejoining = false;   // one-shot: consumed (or cleared because the token moved on without us)
    this.activeId = id;
    if ((changed || rejoinSelf) && this.cb.onTurn) this.cb.onTurn(id, id === this.myId);
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
    if (this.cb.onMove) this.cb.onMove({ playerId: s.playerId, category: s.category, score: s.score, log: s.log });
  };

  // NOTE: the compact binary game-record codec (packRecord/unpackRecord) was
  // removed with the acoustic transport (Task A slice 5c) — it was a third,
  // competing serialization of a game alongside serializeGame() and the live
  // wire, with no remaining caller. Records now move only as the canonical
  // serializeGame() JSON envelope; the JSON-paste import path below still
  // hardens any inbound record through sanitizeRecord.

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
      if (p.scores && typeof p.scores === 'object') catKeys.forEach(function (k) { if (typeof p.scores[k] === 'number' && isFinite(p.scores[k])) scores[k] = clampInt(p.scores[k], -1000, 1000, 0); });
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
    var rec = { ts: clampInt(obj.ts, 0, 1e15, Date.now()) || Date.now(), manualMode: !!obj.manualMode, ownerSkipped: !!obj.ownerSkipped, selectKeep: !!obj.selectKeep, players: players, moveLog: moveLog };
    if (typeof obj.name === 'string' && obj.name.trim()) rec.name = obj.name.trim().slice(0, 48);   // keep a custom battle name
    return rec;
  }

  var api = {
    T: T, HOST_ID: HOST_ID, GENDERS: GENDERS, crc8: crc8, utf8: utf8, utf8d: utf8d,
    sanitizeRecord: sanitizeRecord,
    Writer: Writer, Reader: Reader, frame: frame, unframe: unframe,
    hexRGB: hexRGB, rgbHex: rgbHex,
    packBeacon: packBeacon, unpackBeacon: unpackBeacon, packJoinReq: packJoinReq, unpackJoinReq: unpackJoinReq,
    packJoinAck: packJoinAck, unpackJoinAck: unpackJoinAck, packRoster: packRoster, unpackRoster: unpackRoster,
    packStart: packStart, unpackStart: unpackStart, packGrant: packGrant, unpackGrant: unpackGrant,
    packMetaUpd: packMetaUpd, unpackMetaUpd: unpackMetaUpd, packReady: packReady, unpackReady: unpackReady,
    packPrep: packPrep, unpackPrep: unpackPrep, packAICtrl: packAICtrl, unpackAICtrl: unpackAICtrl,
    packMove: packMove, unpackMove: unpackMove, packStateDelta: packStateDelta, packStateSnapshot: packStateSnapshot, unpackState: unpackState,
    Session: Session,
  };
  return api;

});
