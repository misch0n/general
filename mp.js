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
    META: 13, READY: 14, PREP: 15, AICTRL: 16,              // lobby preparation + AI takeover
    XOFFER: 20, XWANT: 21, XDATA: 22, XACK: 23, XDONE: 24,   // acoustic record transfer
    // adaptive link & resilience (reserved 30-39)
    CAL_PROBE: 30, CAL_REPORT: 31, CAL_SELECT: 32, CAL_CONFIRM: 33, PROFILE_SWITCH: 34, QUALITY: 35, RELAY: 36, GOSSIP: 37,
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
  function writeMeta(w, p) { w.u8(p.id || 0); w.bytes(hexRGB(p.color)); w.u8(genIx(p.gender)); w.u8((p.ready ? 1 : 0) | (p.isAI ? 2 : 0)); w.str(p.name, 28); }
  function readMeta(r) { var id = r.u8(), rgb = r.bytes(3), g = r.u8(), fl = r.u8(), name = r.str(); return { id: id, color: rgbHex(rgb), gender: GENDERS[g] || 'm', ready: !!(fl & 1), isAI: !!(fl & 2), name: name }; }
  // a player's self-edit in the lobby (sender identifies the player; can't edit others)
  function packMetaUpd(meta) { var w = new Writer(); w.bytes(hexRGB(meta.color)); w.u8(genIx(meta.gender)); w.str(meta.name, 28); return w.out(); }
  function unpackMetaUpd(p) { var r = new Reader(p); return { color: rgbHex(r.bytes(3)), gender: GENDERS[r.u8()] || 'm', name: r.str() }; }
  function packReady(ready) { return new Writer().u8(ready ? 1 : 0).out(); }
  function unpackReady(p) { return !!(new Reader(p).u8() & 1); }
  function packPrep(settingsBits) { return new Writer().u8(settingsBits & 0xff).out(); }       // host → all: enter lobby prep + enabled-settings summary
  function unpackPrep(p) { return new Reader(p).u8(); }
  function packAICtrl(id, on) { return new Writer().u8(id).u8(on ? 1 : 0).out(); }              // host → all: a seat is now AI-driven (display)
  function unpackAICtrl(p) { var r = new Reader(p); return { id: r.u8(), on: !!r.u8() }; }

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
    // adaptive link state (§4-6)
    this.meter = new LinkMeter();
    this.profile = this.isHost ? phaseProfile('gameplay') : ANCHOR;   // host runs gameplay; clients start on the safe floor
    this.ctrl = this.isHost ? new AdaptiveController() : null;
    this.clientQ = {};                 // host: client id → its reported link quality
    this._linkN = 0;
    var self = this;
    this.tp.onReceive(function (bytes) { self._rx(bytes); });
    if (this.tp.onMeter) this.tp.onMeter(function (ev) { self.meter.record(ev); self._linkTick(); });  // richer events from L0 (ecc/snr/fail)
    if (this.tp.setProfile) this.tp.setProfile(this.profile);
    this.settingsBits = 0;             // host's enabled pre-game settings (summary shown to clients)
    this.takeover = {};                // host: id → true when that seat is AI-driven mid-game
    if (this.isHost) this.roster.push({ id: HOST_ID, name: this.me.name, color: this.me.color, gender: this.me.gender, ready: true, isAI: false });
  }
  Session.prototype._applyProfile = function (p) { this.profile = p; if (this.tp.setProfile) this.tp.setProfile(p); if (this.cb.onProfile) this.cb.onProfile(p); };
  // §5 host announces a profile change on the ANCHOR (so a degraded client still
  // hears it), then adopts it; clients ack with CAL_CONFIRM.
  Session.prototype.switchProfile = function (id) {
    if (!this.isHost) return;
    if (this.tp.setProfile) this.tp.setProfile(ANCHOR);
    this._send(T.PROFILE_SWITCH, packProfileSwitch(id, this.version));
    this._applyProfile(getProfile(id));
  };
  Session.prototype._worstState = function () {
    var worst = this.meter.state(), rank = { GOOD: 0, DEGRADING: 1, CRITICAL: 2 };
    for (var k in this.clientQ) { var q = this.clientQ[k], s = q.bars <= 1 ? 'CRITICAL' : q.bars <= 2 ? 'DEGRADING' : 'GOOD'; if (rank[s] > rank[worst]) worst = s; }
    return worst;
  };
  Session.prototype._stepDown = function () {                 // move broadcast toward a robuster profile
    var to = this.profile.id === ANCHOR.id ? ANCHOR.id : (this.profile.id === getProfile(1).id ? ANCHOR.id : getProfile(1).id);
    if (to !== this.profile.id) this.switchProfile(to);
  };
  Session.prototype._linkTick = function () {
    var bars = this.meter.bars(), state = this.meter.state();
    if (this.cb.onLink) this.cb.onLink({ bars: bars, state: state, worst: this.isHost ? this._worstState() : state, clientQ: this.clientQ });
    if (this.isHost && this.ctrl && this.state === 'IN_GAME') {
      var act = this.ctrl.sample(this._worstState());
      if (act === 'down' || act === 'recal') this._stepDown();
    }
    if (!this.isHost && this.state === 'IN_GAME' && (++this._linkN % 10 === 0)) {
      this._send(T.QUALITY, packQuality(bars, Math.min(100, Math.round(this.meter.errorRate() * 100)), Math.min(100, Math.round(this.meter.eccLoad() * 100))));
    }
  };
  // host-coordinated calibration: probe candidates, pick the fastest comfortable one,
  // and switch everyone to it. Uses the transport's measureProbe when available.
  Session.prototype.calibrate = function (done) {
    var self = this;
    if (!this.isHost) { if (done) done(this.profile); return; }
    if (!this.tp.measureProbe) { this._applyProfile(phaseProfile('gameplay')); if (done) done(this.profile); return; }
    var ladder = CAL_LADDER, reports = {}, i = 0;
    (function step() {
      if (i >= ladder.length) { var chosen = pickProfile(reports, { threshold: 0.05, margin: 0.5 }); self.switchProfile(chosen.id); if (done) done(chosen); return; }
      var p = ladder[i++];
      self.tp.measureProbe(p, function (er) { reports[p.id] = er; step(); });
    })();
  };
  // adaptive message types handled for both roles
  Session.prototype._rxAdaptive = function (pkt) {
    if (pkt.type === T.PROFILE_SWITCH && !this.isHost) {
      var ps = unpackProfileSwitch(pkt.payload); this._applyProfile(getProfile(ps.profileId)); this._send(T.CAL_CONFIRM, new Writer().u8(ps.profileId).out());
    } else if (pkt.type === T.QUALITY && this.isHost) {
      this.clientQ[pkt.sender] = unpackQuality(pkt.payload);
    } else if (pkt.type === T.GOSSIP) {
      var g = unpackGossip(pkt.payload);
      if (!this.isHost && isBehind(this.version, g.version)) this._send(T.RESYNC_REQ, new Writer().u16(this.version).out());  // detect → resync from host
    } else if (pkt.type === T.RELAY && !this.isHost) {
      var rl = unpackRelay(pkt.payload);
      if (acceptRelayVersion(rl.version, this.version)) { var s = unpackState(rl.snapshot); if (s.kind === 'snapshot') this._rxState(s); }  // host stays the only truth
    }
  };
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
  };
  Session.prototype.submitMoveFor = function (playerId, mv) {
    if (!this.isHost || this.state !== 'IN_GAME' || playerId !== this.activeId) return false;
    mv.playerId = playerId; mv.ackVersion = this.version;
    if (this._applyMove(mv)) { this._send(T.STATE, packStateDelta(this.version, mv)); this._advance(); return true; }
    return false;
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
    var pkt = unframe(bytes);
    this.meter.record({ ok: !!pkt });          // §4 meter every decode attempt (clean vs failed)
    if (!pkt) { this._linkTick(); return; }
    var sig = bytes && bytes.join ? bytes.join(',') : String(bytes);
    if (sig === this._lastBytes) { this._linkTick(); return; }   // drop an immediate duplicate retransmit
    this._lastBytes = sig;
    if (this.isHost) this._rxHost(pkt); else this._rxClient(pkt);
    this._rxAdaptive(pkt);
    this._linkTick();
  };
  Session.prototype._rxHost = function (pkt) {
    if (pkt.type === T.JOIN_REQ && this.state === 'LOBBY') {
      var jr = unpackJoinReq(pkt.payload);
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
      this._send(T.JOIN_ACK, packJoinAck(jr.eph, existing.id));
      this._send(T.ROSTER, packRoster(this.roster));
    } else if (pkt.type === T.MOVE && this.state === 'IN_GAME') {
      var mv = unpackMove(pkt.payload);
      if (mv.playerId === this.activeId && (this.scores[mv.playerId] || {})[mv.category] == null) {
        if (this._applyMove(mv)) { this._send(T.STATE, packStateDelta(this.version, mv)); this._advance(); }
      } else {
        this._send(T.STATE, packStateDelta(this.version, { playerId: mv.playerId, category: mv.category, score: (this.scores[mv.playerId] || {})[mv.category] || 0 }));
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
      if (ja.eph === this.eph) { this.myId = ja.id; this._acked = true; this.state = 'IN_LOBBY'; this._ct(this._timers.join); if (this.cb.onJoined) this.cb.onJoined(ja.id); }
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

  // ============================================================ adaptive link layer
  // Profiles parameterise L0 (band / baud / ecc / volume). The ladder runs
  // fastest→safest; ANCHOR is the ultra-robust always-on floor used for calibration
  // and control. Per-phase defaults: handshake/transfer are fast & close-range,
  // gameplay is slow/robust/long-range (tiny human-paced messages hide the slowness).
  var PROFILES = [
    { id: 0, name: 'anchor',   f0: 1700, f1: 2100, baud: 24, volume: 0.5,  ecc: 3 },  // floor: loud, mid-band, heavy ECC
    { id: 1, name: 'gameplay', f0: 5200, f1: 6200, baud: 40, volume: 0.46, ecc: 2 },  // upper-audible, robust, long range
    { id: 2, name: 'setup',    f0: 6000, f1: 7000, baud: 70, volume: 0.42, ecc: 1 },  // faster, close range
    { id: 3, name: 'transfer', f0: 6200, f1: 7200, baud: 96, volume: 0.42, ecc: 0 },  // fast, one-time, close
    { id: 4, name: 'stealth',  f0: 15000, f1: 16000, baud: 70, volume: 0.5, ecc: 1 }, // near-ultrasonic ~1m
  ];
  var ANCHOR = PROFILES[0];
  function getProfile(id) { for (var i = 0; i < PROFILES.length; i++) if (PROFILES[i].id === id) return PROFILES[i]; return ANCHOR; }
  function phaseProfile(phase) { return getProfile({ handshake: 2, setup: 2, gameplay: 1, transfer: 3 }[phase] != null ? { handshake: 2, setup: 2, gameplay: 1, transfer: 3 }[phase] : 1); }
  // calibration ladder for a phase: candidate profiles fastest→safest
  var CAL_LADDER = [getProfile(3), getProfile(2), getProfile(1), ANCHOR];

  // §3.3 pick the FASTEST profile whose measured error sits comfortably below the
  // threshold (with margin) — not the one that barely scraped through.
  function pickProfile(reports, opts) {
    opts = opts || {}; var thr = opts.threshold != null ? opts.threshold : 0.05, margin = opts.margin != null ? opts.margin : 0.5;
    var ladder = opts.ladder || CAL_LADDER, comfortable = thr * margin, best = null, bestEr = 2;
    for (var i = 0; i < ladder.length; i++) {
      var p = ladder[i], er = reports[p.id];
      if (er == null) continue;
      if (er <= comfortable) return p;                 // fastest comfortable wins
      if (er <= thr && er < bestEr) { best = p; bestEr = er; }
    }
    return best || ANCHOR;                              // none comfortable → safest that passed, else the floor
  }

  // §4 rolling link-quality meter → bars (0-4) + state. ECC correction load is the
  // early-warning signal: high load means you're near the cliff before failures show.
  function LinkMeter(opts) {
    opts = opts || {};
    this.win = opts.window || 16; this.events = [];
    this.thr = opts.thresholds || { degrading: 0.12, critical: 0.35, eccWarn: 0.6 };
  }
  LinkMeter.prototype.record = function (ev) { this.events.push(ev || {}); if (this.events.length > this.win) this.events.shift(); };
  LinkMeter.prototype._avg = function (f) { var n = 0, s = 0; this.events.forEach(function (e) { var v = f(e); if (typeof v === 'number') { s += v; n++; } }); return n ? s / n : 0; };
  LinkMeter.prototype.errorRate = function () { var n = this.events.length; if (!n) return 0; var bad = 0; this.events.forEach(function (e) { if (e.ok === false) bad++; }); return bad / n; };
  LinkMeter.prototype.eccLoad = function () { return this._avg(function (e) { return e.ecc; }); };
  LinkMeter.prototype.retxRate = function () { var n = this.events.length; if (!n) return 0; var r = 0; this.events.forEach(function (e) { if (e.retx || e.resync) r++; }); return r / n; };
  LinkMeter.prototype.bars = function () {
    if (!this.events.length) return 4;                 // assume fine until proven otherwise
    var q = 1 - Math.max(this.errorRate(), this.eccLoad() * 0.7, this.retxRate() * 0.5);
    var b = q >= 0.85 ? 4 : q >= 0.65 ? 3 : q >= 0.4 ? 2 : q >= 0.15 ? 1 : 0, st = this.state();
    if (st === 'CRITICAL') b = Math.min(b, 1);         // tie bars to the link state
    else if (st === 'DEGRADING') b = Math.min(b, 2);
    return b;
  };
  LinkMeter.prototype.state = function () {
    var er = this.errorRate(), ecc = this.eccLoad();
    if (er >= this.thr.critical) return 'CRITICAL';
    if (er >= this.thr.degrading || ecc >= this.thr.eccWarn) return 'DEGRADING';
    return 'GOOD';
  };

  // §5 adaptive controller: meter state → step/recal decision, with hysteresis
  // (N consecutive samples + a cooldown) so the link doesn't flap between profiles.
  function AdaptiveController(opts) {
    opts = opts || {};
    this.need = opts.consecutive || 3; this.cooldown = opts.cooldown || 5; this.upFactor = opts.upFactor || 2;
    this._streak = { GOOD: 0, DEGRADING: 0, CRITICAL: 0 }; this._cool = 0;
  }
  AdaptiveController.prototype.sample = function (state) {
    if (this._cool > 0) { this._cool--; this._reset(); return null; }
    for (var k in this._streak) this._streak[k] = (k === state) ? this._streak[k] + 1 : 0;
    if (this._streak.CRITICAL >= this.need) { this._fire(); return 'recal'; }   // severe/persistent → recalibrate
    if (this._streak.DEGRADING >= this.need) { this._fire(); return 'down'; }   // minor → step to a robuster profile
    if (this._streak.GOOD >= this.need * this.upFactor) { this._fire(); return 'up'; }  // sustained good → conservative step up
    return null;
  };
  AdaptiveController.prototype._reset = function () { this._streak = { GOOD: 0, DEGRADING: 0, CRITICAL: 0 }; };
  AdaptiveController.prototype._fire = function () { this._cool = this.cooldown; this._reset(); };

  // §6.1 RELAY/GOSSIP guards — peers relay/detect, the host stays the only truth.
  function acceptRelayVersion(incoming, local) { return incoming > local; } // ignore stale re-broadcasts
  function isBehind(localVersion, peerVersion) { return peerVersion > localVersion; }

  // ---- adaptive message schemas (§8) ----
  function packProfileSwitch(profileId, effVersion) { return new Writer().u8(profileId).u16(effVersion).out(); }
  function unpackProfileSwitch(p) { var r = new Reader(p); return { profileId: r.u8(), effVersion: r.u16() }; }
  function packQuality(bars, errorPct, eccPct) { return new Writer().u8(bars).u8(errorPct).u8(eccPct).out(); }
  function unpackQuality(p) { var r = new Reader(p); return { bars: r.u8(), errorPct: r.u8(), eccPct: r.u8() }; }
  function packGossip(version, hash) { return new Writer().u16(version).u16(hash).out(); }
  function unpackGossip(p) { var r = new Reader(p); return { version: r.u16(), hash: r.u16() }; }
  function packRelay(version, snapshot) { return new Writer().u16(version).bytes(snapshot).out(); }
  function unpackRelay(p) { var r = new Reader(p), v = r.u16(); return { version: v, snapshot: p.slice(2) }; }
  function packCalReport(rows) { var w = new Writer().u8(rows.length); rows.forEach(function (x) { w.u8(x.profileId).u8(Math.max(0, Math.min(255, Math.round(x.errorRate * 255)))).u8((x.snr | 0) & 0xff); }); return w.out(); }
  function unpackCalReport(p) { var r = new Reader(p), n = r.u8(), a = []; for (var i = 0; i < n; i++) { var pid = r.u8(), er = r.u8(), snr = r.u8(); a.push({ profileId: pid, errorRate: er / 255, snr: (snr << 24) >> 24 }); } return a; }
  function stateHash(scores) {                          // cheap state fingerprint for GOSSIP
    var h = 0x1234; Object.keys(scores).sort().forEach(function (id) { var c = scores[id]; Object.keys(c).sort().forEach(function (k) { h = (h * 31 + (+id) * 7 + (+k) * 13 + (c[k] | 0)) & 0xffff; }); }); return h;
  }

  var api = {
    T: T, HOST_ID: HOST_ID, GENDERS: GENDERS, crc8: crc8, crc16: crc16, utf8: utf8, utf8d: utf8d,
    packRecord: packRecord, unpackRecord: unpackRecord, sanitizeRecord: sanitizeRecord, Transfer: Transfer,
    PROFILES: PROFILES, ANCHOR: ANCHOR, getProfile: getProfile, phaseProfile: phaseProfile, CAL_LADDER: CAL_LADDER,
    pickProfile: pickProfile, LinkMeter: LinkMeter, AdaptiveController: AdaptiveController,
    acceptRelayVersion: acceptRelayVersion, isBehind: isBehind, stateHash: stateHash,
    packProfileSwitch: packProfileSwitch, unpackProfileSwitch: unpackProfileSwitch, packQuality: packQuality, unpackQuality: unpackQuality,
    packGossip: packGossip, unpackGossip: unpackGossip, packRelay: packRelay, unpackRelay: unpackRelay,
    packCalReport: packCalReport, unpackCalReport: unpackCalReport,
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
      this.volume = opts.volume || 0.4;
      this.ctx = null; this.stream = null; this._cb = null; this._meterCb = null; this._rxTimer = null;
      this._sending = false;
    }
    // §2 adopt a profile (band / baud / volume); the receiver retunes its detector too
    AudioFSK.prototype.setProfile = function (p) {
      if (!p) return; this.f0 = p.f0; this.f1 = p.f1; this.baud = p.baud; if (p.volume) this.volume = p.volume;
      this.fsync = Math.max(800, p.f0 - 400);   // keep the preamble just below the data band
    };
    AudioFSK.prototype.onMeter = function (cb) { this._meterCb = cb; };   // §4 per-decode quality events
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
        // §7 soft attack/release so the burst reads as a neutral chirp, not a harsh ping
        g.gain.setValueAtTime(0.0001, start); g.gain.exponentialRampToValueAtTime(self.volume, start + 0.004);
        g.gain.setValueAtTime(self.volume, start + dur - 0.004); g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
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
      var nbytes = Math.floor(st.bits.length / 8); if (nbytes < 3) { this._meter(false); return; }
      var bytes = new Uint8Array(nbytes); for (var i = 0; i < nbytes; i++) bytes[i] = bitsToByte(st.bits, i * 8);
      var len = bytes[0]; if (len + 3 > bytes.length) { this._meter(false); return; }
      var payload = bytes.slice(1, 1 + len), got = (bytes[1 + len] << 8) | bytes[1 + len + 1];
      if (crc16(payload) !== got) { this._meter(false); return; }   // failed CRC ⇒ drop + meter
      this._meter(true);
      if (this._cb) try { this._cb(payload); } catch (e) {}
    };
    AudioFSK.prototype._meter = function (ok) { if (this._meterCb) try { this._meterCb({ ok: ok }); } catch (e) {} };
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
