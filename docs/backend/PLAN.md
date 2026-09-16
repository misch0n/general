# Backend server — implementation plan & progress tracker

> **Read [`README.md`](./README.md) first.** It holds the architecture facts, the
> constraints, the status-marker legend, and the resume/commit workflow. This file
> is the **plan and the live tracker**: what we build, why, and how far we've gotten.

Status markers: `[ ]` todo · `[~]` in progress · `[x]` done+verified · `[!]` blocked/needs decision.

---

## Current status

**Phase 0 — in progress.** 0.1 (scaffold + shared-module reuse) and 0.2 (config,
logging, graceful shutdown) are **done and verified**. `server/` exists, boots, and
provably runs the browser's own rules modules. There is no listener yet.

**Next step:** **Phase 0, Task 0.3** (HTTP + WS listener skeleton).
⚠️ **Read 0.3's CI note before starting** — it needs the `ws` dependency, and
`.github/workflows/deploy.yml` currently runs `node --test` with *no* `npm install`
(every test to date is dependency-free). That commit must add an install step or CI
breaks on the first server socket test.

**Progress:** 0 / 9 phases complete (Phase 0: 2 / 4 tasks).
`node --test` → **207** tests (was 176 before the server landed).

---

## North star & scope

Build a Node.js **authoritative multiplayer server** for Генерал that:

- owns rooms, turn order, **dice RNG**, and **score computation** — clients send
  intents, never outcomes;
- **reuses the pure modules** (`game.js`, `exp.js`, `reduce.js`, `mp.js`) so the
  server and browser run identical rules;
- **hosts `MP.Session`** per room over a WebSocket transport, extending the wire
  protocol only where server-owned dice require it;
- leaves the **`file://` frontend intact** — server play is opt-in and additive.

**Out of scope (unless a later decision pulls it in):** accounts/sign-in (the game is
open-and-play, no accounts — D5), **server-side game storage/archive/leaderboards**
(persistence stays on-device — D6), ranked matchmaking/ELO, payments, native mobile
clients, voice/chat.

---

## Phase 0 — Foundations & scaffolding

*Goal: a running Node server process that shares the game's pure modules, with a
test lane, changing nothing about the `file://` frontend.*

- [x] **0.1 Server scaffold + shared-module smoke.** Create `server/` at repo root
  (plain Node, no bundler). Add a tiny entrypoint that `require()`s the four pure
  modules and asserts they load under Node (`G.rollAll`, `X`, `GReduce.reduce`,
  `MP.frame`). *Why:* prove the single-source-of-truth reuse works before building on
  it. *Files:* `server/index.js`, `server/package.json` (or root dep additions — see
  Decision D1). *DoD:* `node server/index.js` prints a health line; a unit test
  `require`s each module server-side and passes under `node --test`.
  → **Done.** `server/engine.js` binds the four modules behind a `CONTRACT` +
  `selfTest()`/`assertReady()`; `server/index.js` boots and prints the banner;
  `test/server/engine-reuse.test.js` (10 tests) holds the reuse claim — including
  module *identity* (`===`), `MP.Session` constructing under Node, and game.js's
  rng-less `rollDie()` finding Web Crypto (not Math.random) server-side.
- [x] **0.2 Config & runtime plumbing.** Env-based config (`PORT`, log level, room
  limits), structured logging, graceful shutdown (SIGTERM drains rooms). *Why:*
  every later phase needs config + clean lifecycle. *DoD:* config module unit-tested;
  server starts/stops cleanly.
  → **Done.** `server/config.js` (env table → frozen object; bad values throw
  naming the variable), `server/log.js` (level-filtered JSON/text records, child
  loggers, crash-proof), `server/lifecycle.js` (reverse-order drain hooks under a
  grace deadline). 21 tests in `test/server/runtime.test.js`. Caps default to D4
  (6 players / 100 rooms) and are clamped to the 15 seats the wire format can
  address. Note: with no listener yet the process prints its banner and exits —
  SIGTERM draining is covered by tests until Phase 0.3 gives it something to hold.
- [ ] **0.3 HTTP + WS listener skeleton.** Minimal HTTP server (health/readiness
  endpoint) upgrading to WebSocket via `ws`. No game logic yet — just accept a
  connection, echo a framed ping/pong through `mp.js` framing. *Why:* establishes the
  transport substrate Phase 1 builds `SocketBus` on. *DoD:* an integration test opens
  a `ws` client, round-trips a `PING`/`PONG` frame decoded by `mp.js`.
  ⚠️ **CI:** this is the first test needing a real dependency. `.github/workflows/`
  `deploy.yml` runs `node --test` with **no `npm install`** — add one in the same
  commit, or the test job fails on `require('ws')`. (`ws` is already present in
  `node_modules` transitively via puppeteer, so it passes locally and would only
  break in CI — an easy trap.)
- [~] **0.4 Server test lane.** Extend `node --test` with a `test/server/` area;
  document how server tests run (see Decision D1 on packaging). *DoD:* `node --test`
  discovers and runs server tests alongside the existing 176.
  → **Half done.** `test/server/` exists and needs no new lane: Node's default test
  glob includes `**/test/**/*.js`, so root `node --test` already discovers it (176 →
  207). Careful: that glob means **every** `.js` under `test/` is executed as a test
  file, so shared helpers must live outside it (put them in `server/`). Remaining:
  the dependency/CI half, folded into 0.3.

## Phase 1 — Transport bridge: `SocketBus` + server-hosted `Session`

*Goal: a browser client connects to the server, the server hosts a real `MP.Session`
over WebSocket, and the existing lobby handshake works end-to-end unchanged.*

- [ ] **1.1 Server `SocketBus`.** Implement the `MP.Session` transport contract
  (`send(bytes)`, `onReceive(cb)`) over a room's WebSocket connections, mirroring
  `PeerBus`'s star topology (server relays to all clients; a client's frame goes to
  the server). *Files:* `server/socket-bus.js` (+ tests). *DoD:* unit test drives a
  mock `ws` and asserts framing relay matches `webrtc.test.js`'s star expectations.
- [ ] **1.2 Host a `Session` per connection group.** Server constructs
  `new MP.Session({ transport, isHost: true, … })` and pumps its callbacks. Reuse the
  existing `LOBBY→PREP→IN_GAME→GAME_OVER` machine as-is for now (dice still
  client-declared — Phase 3 fixes that). *DoD:* integration test: a mock client sends
  `JOIN_REQ`, receives `JOIN_ACK` + `ROSTER` from the server-hosted session.
- [ ] **1.3 Browser `SocketBus`.** Add a WebSocket transport in the app
  (`features/net/`) implementing the same contract as `PeerBus`, targeting the
  server URL. Do **not** wire it into the UI yet (Phase 7) — just make it
  constructible and unit-/smoke-testable. *Why:* keep frontend changes isolated and
  `file://`-safe. *DoD:* puppeteer smoke still passes (no regression); the transport
  connects to a locally-run server in a scripted check.
- [ ] **1.4 End-to-end lobby over WS.** With server + browser `SocketBus`, drive a
  full lobby handshake (beacon/join/roster/ready) against a real server process in a
  scripted integration test. *DoD:* a headless client joins a server room and reaches
  `IN_PREP`.

## Phase 2 — Rooms, matchmaking & lifecycle

*Goal: many concurrent rooms, create/join by code, reconnect, and clean expiry.*

- [ ] **2.1 Room registry.** Create-room (mint code, like `genGameCode`), join-by-code,
  route each connection to its room's `Session`. Enforce room/player caps (Decision
  D4). *DoD:* two rooms run concurrently and isolated; caps rejected with `JOIN_NAK`.
- [ ] **2.2 Reconnect via `eph`.** Wire the existing `eph → seat` reseat path through
  the server so a dropped client rejoining the same room resumes its seat and gets a
  snapshot. *Why:* `Session` already supports this; the server just needs to keep the
  room alive across a socket drop. *DoD:* integration test: client drops mid-lobby,
  reconnects with same `eph`, keeps its seat.
- [ ] **2.3 Room lifecycle & GC.** Idle-room expiry, empty-room teardown, `dispose()`
  of the `Session`, connection cleanup on close/error. *DoD:* leak test — N
  create/abandon cycles leave no lingering rooms/timers.

## Phase 3 — Authoritative game loop (the core upgrade) ⭐

*Goal: the server owns dice and scoring. Clients send intents; the server rolls via
`G.rollDie`, computes score via `G.assignScore`/`scoreFor`, runs `GReduce.reduce`,
and broadcasts authoritative results. This is the project's reason to exist.*

- [ ] **3.1 Intent protocol in `mp.js`.** Add message types + JSON/binary codecs for
  client **intents** — `ROLL_REQ`, `REROLL_REQ{ keepMask }`, `COMMIT_REQ{ category }`
  — and a server **`DICE`/roll-result** push. Keep `mp.js` pure + UMD; add round-trip
  tests. *Why:* the current `MOVE` lets a client declare its own score; intents move
  the decision to the server. *Decision:* D2 (protocol shape), D3 (P2P coexistence).
  *DoD:* new codecs round-trip in `mp.test.js`; framing unchanged for old messages.
- [ ] **3.2 Server-side RNG.** Server rolls with `G.rollAll(rng)`/`G.rollDie(rng)`
  using a crypto-strong `rng`, on `GRANT`/`ROLL_REQ` and per `REROLL_REQ` (honoring
  `keepMask`, enforcing the reroll cap `MAX_ROLLS`). Feed faces into
  `GReduce.reduce({type:'FIRST_ROLL'|'REROLL', …})` exactly as the client shell does.
  *DoD:* server unit test: a sequence of roll/reroll intents yields deterministic
  transitions under an injected seedable `rng`.
- [ ] **3.3 Server-side scoring + commit.** On `COMMIT_REQ`, validate the category is
  open and legal, compute the score from the **server's** dice via `G.assignScore` /
  `X` scoring (ruleset-aware), apply through `Session._applyMove` /
  `GReduce APPLY_SCORE`, broadcast the authoritative `STATE` delta. Reject illegal
  intents (out-of-turn, filled category, too many rerolls, bad mask). *Why:* closes
  the trust gap — client can no longer fabricate a score. *DoD:* server rejects a
  crafted illegal commit; a legal one produces the same score the engine computes.
- [ ] **3.4 Turn advance + end-game, server-driven.** Route turn advance and
  end-detection through `Session`'s `_advance`/`_allDone` and broadcast `GRANT`/`END`.
  *DoD:* a full 2-player server game reaches `GAME_OVER` with correct standings.
- [ ] **3.5 Experimental ruleset parity.** Ensure roll/reroll/commit + scoring work for
  the `exp.js` ruleset (free-order card, `X` scoring). *DoD:* server game in `exp`
  mode completes with correct exp scoring.
- [ ] **3.6 Anti-cheat & validation sweep.** Systematic rejection of malformed/illegal
  intents; cap message size; reuse the `sanitizeRecord` hardening pattern for any
  JSON payload. *DoD:* a fuzz/adversarial test of intent inputs never corrupts room
  state.

## Phase 4 — State sync, drops & AI takeover

*Goal: robust sync and graceful degradation, server-driven.*

- [ ] **4.1 Server-sourced snapshots/deltas.** Emit `packStateDelta` during play and
  `packStateSnapshot` on `RESYNC_REQ`/rejoin, now authored by the server's
  authoritative state. *DoD:* a client that misses a delta resyncs from snapshot to
  identical state (mirror `mp.test.js`'s version-gap test, server-side).
- [ ] **4.2 Server-driven AI takeover.** When a seat drops (or is a pure-AI seat), the
  **server** plays it using `G.aiChoose` + server RNG, instead of a client hosting the
  AI. *Why:* authority means the server, not a peer, drives absent players. *DoD:* a
  dropped seat is auto-played to completion by the server; game still ends correctly.
- [ ] **4.3 Pause / forfeit / spectate.** Reuse `Session`'s `paused`/`dropped` and TACT
  live-action relay for spectators, driven by the server. *DoD:* a spectator client
  receives live `TACT` actions; a paused seat no longer blocks the finish.

## Phase 5 — Identity & security

*Goal: a minimal, honest identity + input-hardening layer. Scope gated by Decision D5.*

- [ ] **5.1 Connection identity (anonymous).** Per D5 there are **no accounts** — just
  an opaque, server-issued per-connection token binding a socket to its `eph`/seat, so
  seat ownership can't be spoofed by a reconnecting stranger. No sign-in, no PII.
  *DoD:* a second socket cannot claim another player's seat.
- [ ] **5.2 Transport security & origin.** `wss://` (TLS, typically via reverse proxy),
  WebSocket origin/allowlist checks, per-connection rate limiting and message-size
  caps. *DoD:* rate-limit + oversize-frame tests reject abusive input; documented
  TLS/proxy setup.
- [ ] **5.3 Secrets & config hygiene.** No credentials in repo; all server secrets come
  from env/config. Note the hardcoded Metered.ca TURN credentials in `net.js:380-387`
  are **removed with PeerJS in 7.4** (D3) — no server-side equivalent is needed. *DoD:*
  a check flags any committed credentials; env-driven config verified.

## Phase 6 — Operations & telemetry

*Goal: run the server in production. Per D6, the server keeps **no durable game
storage** — rooms are in-memory, a restart drops in-flight games, and finished games
are archived on-device by the client (as today). Server-side persistence /
archive / leaderboards are out of scope (future, with accounts).*

- ~~6.x Room state persistence~~ — **out of scope (D6).** In-memory only; a restart
  drops live rooms. (Revisit only if accounts + server storage are ever added.)
- ~~6.x Server-side archive~~ — **out of scope (D6).** Finished games stay in the
  client's `localStorage` archive; the server stores nothing durable.
- [ ] **6.1 Telemetry & analytics.** Server-side metrics/analytics (rooms, players,
  game outcomes, errors) — this is what replaces the third-party relay's role and
  removes any need for Metered.ca (D3). Privacy-respecting, no PII (no accounts).
  *DoD:* documented metrics surface; basic dashboards/log-based analytics.
- [ ] **6.2 Ops surface.** Health/readiness endpoints, structured logs, deploy notes
  (process manager, env, graceful drain), TLS/`wss://` termination (D7). *DoD:* health
  endpoint reflects real state; runbook in `docs/backend/`.

## Phase 7 — Frontend integration & migration

*Goal: players can choose "play on our server"; the `file://` app stays intact.*

- [ ] **7.1 UI: server vs P2P selector.** Add a "play on server" path alongside the
  existing WebRTC host/join in `features/setup/` + `features/net/`, wiring the browser
  `SocketBus` through `netCallbacks()`. *Why:* opt-in, non-breaking. *DoD:* both paths
  selectable; local + P2P play unchanged; **bump `APP_VERSION` + CHANGELOG** (user-visible).
- [ ] **7.2 Client intent flow.** In server mode, the client sends `ROLL_REQ`/
  `REROLL_REQ`/`COMMIT_REQ` and renders **server-pushed** dice/score instead of rolling
  locally (`G.rollAll` bypassed in server mode). *DoD:* a full server game is playable
  from the browser; puppeteer smoke covers both rulesets in server mode.
- [ ] **7.3 Reconnect & error UX.** Surface disconnect/resync/room-closed states in the
  net UI. *DoD:* dropping and restoring the socket mid-game recovers cleanly in the UI.
- [ ] **7.4 Remove PeerJS/WebRTC entirely.** Per Decision D3, once server play is the
  proven path, **delete** the WebRTC/PeerJS transport, the PeerJS CDN load, and the
  hardcoded Metered.ca TURN credentials/ICE config (`net.js:375-398`, `PeerBus`, the
  `settings.iceServers` override) — server telemetry replaces what the relay gave us.
  Leave no dead code (root `CLAUDE.md`): grep for orphaned net code/CSS/HTML/deps
  (`peerjs` in `package*.json`, `@roamhq/wrtc` if now unused, `webrtc.test.js` scope)
  and remove them. *DoD:* server is the only network transport; grep confirms no
  PeerJS/WebRTC/TURN remnants; `node --test` + puppeteer smoke green; **`APP_VERSION`
  + CHANGELOG** bumped (`rem` tag).

## Phase 8 — Testing, hardening & docs

*Goal: confidence and a clean handoff.*

- [ ] **8.1 Protocol/integration coverage.** Port `mp.test.js`/`webrtc.test.js`
  patterns to real server sockets (swap the star-topology mock for `ws` clients):
  convergence, idempotency, resync, drop/reconnect, AI takeover. *DoD:* server
  integration suite green.
- [ ] **8.2 Load / soak.** Many concurrent rooms + clients; watch for leaks, latency,
  timer pileups. *DoD:* documented results; no leaks over a soak run.
- [ ] **8.3 End-to-end smoke.** Puppeteer against a real server: full server-backed
  game, both rulesets, no `pageerror`. *DoD:* CI-runnable smoke passes.
- [ ] **8.4 Docs finalization.** Update root `README.md` + `docs/MAP.md`; move this
  plan to `docs/completed/` when done (mirroring `TASK-A`/`TASK-B`). *DoD:* docs
  reflect the shipped server; `bash scripts/genmap.sh` regenerated.

---

## Open decisions

Recommended defaults are in **bold**; a task blocked on one is marked `[!]` above.
When you resolve one, record the outcome here and in the *Decision log*.

- **D1 — Server packaging.** Own `server/package.json` (separate deps) **vs** add
  server deps to root `package.json`. *Default:* **own `server/package.json`** to keep
  the zero-dependency `file://` frontend uncluttered, sharing root modules via
  relative `require('../../game.js')`. (Confirm the relative-require path once
  `server/` layout is fixed in 0.1.)
- **D2 — Intent protocol shape.** New explicit intent message types (`ROLL_REQ`,
  `REROLL_REQ`, `COMMIT_REQ`) **vs** overloading `TACT`/`MOVE`. *Default:* **new
  explicit types** — clearer authority boundary, keeps `MOVE` meaning "authoritative
  result," easier to test.
- **D3 — P2P/PeerJS coexistence.** ✅ **RESOLVED (2026-09-16): scrap PeerJS entirely
  once the server is complete.** P2P may stay wired during development as a working
  fallback, but Phase 7.4 **removes** WebRTC/PeerJS and its dead code. The hardcoded
  Metered.ca **TURN credentials go too** — the server gives us our own telemetry and
  analytics, so we no longer depend on a third-party relay.
- **D4 — Room/player caps.** *Default:* **6 players/room** (matches `maxPlayers`), a
  conservative global room cap (e.g. 100) tunable via config; revisit under load (8.2).
- **D5 — Identity scope.** ✅ **RESOLVED (2026-09-16): no accounts — anonymous
  open-and-play only.** The game is meant to be simple: open and play, no sign-in.
  Identity is just an **anonymous per-connection token** bound to the `eph`/seat to
  stop seat-spoofing. Accounts are explicitly **out of scope** (a possible future
  expansion, not now).
- **D6 — Persistence backend.** ✅ **RESOLVED (2026-09-16): persistence stays
  on-device only — the server keeps no durable game storage.** Server rooms are
  **in-memory**; a server restart drops in-flight games (acceptable for open-and-play).
  Finished games are archived **on the client** (`localStorage`, as today) — in server
  mode the client archives the authoritative final state it receives. Server-side
  archive/leaderboards and restart-survival are **out of scope** (future, with accounts).
- **D7 — Deployment target/env.** Where the server runs (self-host, PaaS, container) and
  the public `wss://` URL the client uses. *Default:* **defer to Phase 6**; keep the
  client's server URL configurable (env/settings), not hardcoded.

> D3/D5/D6 are **resolved** (see above). D1/D2/D4 are implementation defaults — proceed.
> D7 (deployment target + public `wss://` URL) is still open but only bites in Phase 6;
> flag it to the owner before then.

---

## Decision log

Append-only. Each entry: date, what was decided, **why**, and any consequence. This is
the durable "why" that complements the commit history.

- **2026-09-16 — Plan created.** Chose to build the server as a **Node host of the
  existing `MP.Session`** over a WebSocket `SocketBus`, reusing the pure modules
  (`game.js`/`exp.js`/`reduce.js`/`mp.js`) rather than a rewrite. *Why:* `Session` is
  already a transport-pluggable, host-authoritative state machine, and the engine is
  DOM-free/UMD — so the server and browser can run identical rules, and the frontend
  stays `file://`-safe. Identified the **client-rolled-dice trust gap** (host trusts a
  client-declared score) as the core thing Phase 3 fixes by moving RNG + scoring
  server-side. Recorded open product decisions D1–D7 with defaults so work can proceed
  without blocking.
- **2026-09-16 — D3, D5, D6 resolved by owner.**
  - **D3:** scrap PeerJS entirely once the server is complete (P2P may remain a
    dev-time fallback, removed in Phase 7.4). Drop the Metered.ca TURN relay too — the
    server provides our own telemetry/analytics (Phase 6.1), so no third-party relay
    dependency remains.
  - **D5:** no accounts — the game stays simple open-and-play. Identity is only an
    anonymous per-connection token to stop seat-spoofing. Accounts are a possible
    future expansion, out of scope now.
  - **D6:** persistence is on-device only. Server rooms are in-memory (a restart drops
    in-flight games); finished games are archived in the client's `localStorage` as
    today. Server-side storage/archive/leaderboards are out of scope (future, with
    accounts). Phase 6 accordingly drops the room-persistence and server-archive tasks,
    keeping only telemetry + ops.
