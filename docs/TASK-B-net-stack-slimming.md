# Task B — Net-stack slimming: remove the dormant acoustic / adaptive-link layer

**Purpose:** start this cleanly in a fresh session. Read CLAUDE.md first, then this. This is the
"large, orthogonal sweep" deferred at the end of Task A (`docs/completed/TASK-A-state-unification.md`,
§"Also still dormant").

## Goal
The net transport is **WebRTC-only** (PeerJS). When the acoustic (data-over-sound) transport was
removed, its **adaptive band/profile machinery and the acoustic record-transfer protocol were left
behind in `mp.js`** — fully dormant. Remove that dead weight so `mp.js` is just **framing + session
+ game codecs**, the layers WebRTC actually uses. Done **incrementally, one committed+verified slice
at a time** (same discipline as Task A).

**In scope (the dead protocol layer, all in `mp.js` + `test/mp.test.js`):** the adaptive link layer
(`LinkMeter`, `AdaptiveController`, profiles, calibration, `RELAY`/`GOSSIP`/`QUALITY`/`PROFILE_SWITCH`),
the orphaned acoustic record-transfer type constants (`XOFFER…XDONE`), and `crc16`.

**Out of scope / optional tail (app layer — bigger, needs care):** the acoustic **UI remnants** and
the `netKind` machinery in `features/net/net.js` + `features/game/game.js` (16 refs). Acoustic is the
only non-WebRTC `netKind`, so in principle `netKind` collapses to a constant — but it's threaded
through the lobby, rejoin/saved-state payloads, and QR copy. Treat it as a **separate slice 3 that can
be deferred**; slices 1–2 (the protocol layer) stand alone and deliver most of the value.

## Why this is safe (verified — the entanglement finding)
The live WebRTC path does **not** depend on any of it:
- The `PeerBus` transport (`features/net/net.js`, the object with `send`/`onReceive`) implements
  **only** `onReceive` + `send`. It has no `setProfile` / `onMeter` / `measureProbe` / `setRole`, so
  the three constructor guards (`mp.js` ~228–230) already take the `false` branch — no-ops today.
- `netCallbacks()` (`features/net/net.js` ~61–97) never sets `onLink` or `onProfile`. There is **no
  signal-strength / bars UI** anywhere. `_linkTick`'s only outputs (`cb.onLink`, the AdaptiveController
  sample, periodic `QUALITY` sends) all dead-end.
- No `PROFILE_SWITCH` / `QUALITY` / `GOSSIP` / `RELAY` packet is ever **sent** on the WebRTC path;
  `_rxAdaptive` is reached on every receive but matches nothing in practice (defensive dead code).
- `stateHash`, `acceptRelayVersion`, `isBehind`, `pickProfile`, `LinkMeter`, `AdaptiveController`,
  `calibrate`, `switchProfile`, `crc16` — **zero callers** outside `mp.js` + `test/mp.test.js`
  (grepped). Removal is contained.

**The one entanglement:** `_rx` calls `this.meter.record({ ok: !!pkt })` unconditionally and
`this._linkTick()` on each path (`mp.js` ~602–618, incl. the 5c-remainder `try/catch` whose `catch`
also calls `_linkTick`). Removing `meter`/`_linkTick` means editing `_rx` — a few line deletions,
nothing else in `_rx` depends on the meter.

## Slice plan & status
1. ✅ **DONE (commit `40536d5`)** — strip the adaptive link layer (`mp.js` + `test/mp.test.js`). Removed:
   - **Profiles:** `PROFILES`, `ANCHOR`, `getProfile`, `phaseProfile`, `CAL_LADDER`, `pickProfile`.
   - **Classes/methods:** `LinkMeter`, `AdaptiveController`, and `Session.prototype.`
     `_rxAdaptive` / `switchProfile` / `calibrate` / `_worstState` / `_stepDown` / `_linkTick` /
     `_applyProfile`.
   - **Codecs:** `packProfileSwitch`/`unpackProfileSwitch`, `packQuality`/`unpackQuality`,
     `packGossip`/`unpackGossip`, `packRelay`/`unpackRelay`, `packCalReport`/`unpackCalReport`,
     `stateHash`, `acceptRelayVersion`, `isBehind`.
   - **`T` constants:** the adaptive block `CAL_PROBE`/`CAL_REPORT`/`CAL_SELECT`/`CAL_CONFIRM`/
     `PROFILE_SWITCH`/`QUALITY`/`RELAY`/`GOSSIP` (30–37). Leave the stable game/lobby types untouched.
   - **Session fields + constructor wiring:** `this.meter`, `this.ctrl`, `this.clientQ`,
     `this.profile`, `this._linkN`, and the `if (this.tp.onMeter) … / setProfile / setRole` lines.
   - **`_rx` edit:** delete the `this.meter.record(...)` line and every `this._linkTick()` call
     (including the one in the `try/catch`'s `catch`); the `catch` becomes just `{ return; }`.
   - **`api` export:** drop `PROFILES, ANCHOR, getProfile, phaseProfile, CAL_LADDER, pickProfile,
     LinkMeter, AdaptiveController, acceptRelayVersion, isBehind, stateHash`, and the five adaptive
     `pack*/unpack*` pairs.
   - **Tests:** delete the 9 tests under the `// ---- adaptive link layer ----` banner
     (`test/mp.test.js`, ~262–369): `pickProfile…`, `LinkMeter…`, `AdaptiveController…`,
     `relay/gossip guards…`, `adaptive schemas round-trip`, `PROFILE_SWITCH…`, `calibrate…`,
     `onLink surfaces bars…`, `GOSSIP…`. (No adaptive tests in `webrtc.test.js`.)
   - **Verify:** `node --test` (expect the count to drop by ~9 from removed tests — that's intended,
     note it in the commit) + `node scripts/smoke.js` green. Also run the two existing loopback
     full-game tests in `mp.test.js` — they must still converge (they don't touch the adaptive layer).
2. ⬜ **TODO — drop the orphaned acoustic remnants** (`mp.js`). Small, independent of slice 1:
   - `T` constants `XOFFER`/`XWANT`/`XDATA`/`XACK`/`XDONE` (20–24) — acoustic record-transfer
     handshake; `packRecord`/`unpackRecord` were already removed in Task A 5c, these are orphans.
   - `crc16` (its def + the `api` export) — acoustic-era L0 utility, zero callers.
   - The stale comment in the `Session` constructor (~193–196) that justifies the long timer
     intervals by *"each acoustic frame takes ~1–3 s and the link is half-duplex"* — the interval
     defaults stay (fine for WebRTC), but reword the rationale.
   - **Verify:** `node --test` + smoke.
3. ⬜ **TODO (optional / can defer) — acoustic UI + `netKind` simplification** (app layer):
   - `index.html`: the `ac-only` nodes (the "phones in same room / speaker→mic" copy + the
     "Без слушалки!" warning, ~449/451/475) and the stale `<!-- network (acoustic) … -->` comment
     (~444).
   - `features/game/game.js`: `var netKind = 'acoustic'` default (~26) → `'webrtc'`.
   - `features/net/net.js`: the ~14 `netKind` reads / `netKind !== 'webrtc'` guards. **Care:** check
     the rejoin / `netActiveSave`/`netActiveLoad` saved-state payload and the QR/join-code flow before
     collapsing — a persisted `netKind` may be read on resume. Decide whether to keep `netKind` as a
     vestigial always-`'webrtc'` field or excise it entirely.
   - **Verify:** `node --test` + smoke + a manual WebRTC host/join sanity pass if feasible (net has no
     automated app-level coverage beyond the `mp.js` loopback).
4. ⬜ **TODO — docs/README sync** (do as the code slices land, or as a final pass):
   - `README.md` ~322–400: the "Acoustic multiplayer" + "Adaptive link" sections — replace with a short
     "WebRTC-only" paragraph. ~622: the `mp.js` table row ("…audio FSK modem") — rewrite.
   - `CLAUDE.md` ~41–43: the net note already says WebRTC-only but references the dormant layer's
     presence — tighten once removed.
   - `docs/completed/TASK-A-state-unification.md` §"Also still dormant" (~end): mark it done here
     ("removed in Task B").
   - Regenerate `docs/MAP.md` (`bash scripts/genmap.sh`) after the `mp.js` functions are gone.
   - When everything lands, archive this doc to `docs/completed/` (as Task A was).

## Inventory (key line refs — as of `56a30ef`; will drift as slices land — re-grep)
| Symbol(s) | `mp.js` line(s) | Role |
|---|---|---|
| `XOFFER…XDONE` | 23 | acoustic record-transfer types (orphaned post-5c) |
| `CAL_*`/`PROFILE_SWITCH`/`QUALITY`/`RELAY`/`GOSSIP` | 25 | adaptive link message types |
| `crc16` | 776, 917 (export) | acoustic L0 checksum, no caller |
| `_applyProfile`/`switchProfile`/`_worstState`/`_stepDown`/`_linkTick`/`calibrate`/`_rxAdaptive` | 236, 239, 245, 250, 254, 267, 279 | adaptive Session methods |
| `PROFILES`/`ANCHOR`/`getProfile`/`phaseProfile`/`CAL_LADDER`/`pickProfile` | 825–840 | profile table + selection |
| `LinkMeter` / `AdaptiveController` | 854 / 881 | link-quality meter + step-down controller |
| adaptive codecs + `stateHash`/`acceptRelayVersion`/`isBehind` | 898–914 | their wire pack/unpack + guards |
| Session fields `meter`/`profile`/`ctrl`/`clientQ`/`_linkN` + `onMeter`/`setProfile`/`setRole` wiring | 217–230 | constructor wiring (all no-ops on WebRTC) |
| `_rx` `meter.record` + `_linkTick` calls | 604, 605, 607, 616, 617 | the one live-path entanglement |
| adaptive tests | `test/mp.test.js` 262–369 | 9 tests to delete |

## Gotchas
- Classic global scope + load order (see CLAUDE.md). `mp.js` is a UMD module (`require`-able by tests,
  `window.MP` in the app) — keep the `api` export shape valid; just drop the removed keys.
- The two **loopback full-game tests** in `mp.test.js` (`host + 2 clients: …consistent final state`
  and `…per-player turn LOGS converge`) are the real safety net for the Session — they do **not**
  use the adaptive layer, so they must keep passing untouched through slice 1.
- `crc8` (framing) and `GENDERS`/`hexRGB`/`rgbHex` (player meta) are **not** part of this layer —
  keep them.
- Expect the unit-test count to **drop** in slice 1 (≈9 removed). That's the one sanctioned decrease;
  call it out in the commit so it doesn't look like a regression.
- `_rxAdaptive` is called from `_rx`; remove the call site together with the method.
