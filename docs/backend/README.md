# Backend server — orientation & how to use this plan

This directory holds the **plan and progress tracker** for giving Генерал a real
**authoritative multiplayer server**, replacing the current browser-only,
peer-to-peer (PeerJS/WebRTC) host model with a dedicated server that is the single
source of truth for every game.

- **[`PLAN.md`](./PLAN.md)** — the master plan **and the live work tracker**. It is
  the source of truth for *what we are building*, *why*, and *how far we've gotten*.
- **This file** — orientation: the architecture facts you need before touching
  anything, and the workflow for picking up and continuing the work.

> **New session? Start here.** Read this file top-to-bottom, then read `PLAN.md`,
> then run `git log --oneline main..HEAD` on this branch. That is enough to know
> exactly where we are and what to do next — you should not need to re-explore the
> codebase to resume.

---

## 1. The goal

Today, network play works with **no server of our own**: one phone is the "host"
(referee), others join over WebRTC via PeerJS's public broker (`features/net/net.js`
+ `mp.js`). The host is authoritative *in principle*, but the device holding the
turn rolls its own dice and **declares its own score**, which the host trusts.

We want a **true authoritative server**:

- The **server** owns every room, the turn order, the dice (RNG), and score
  computation. Clients send **intents** ("roll", "reroll these", "commit category
  X"); the server rolls, validates, scores, and broadcasts the authoritative result.
- A client can never fabricate a roll or a score. Reconnects, drops, and AI
  takeover are handled by the server.

## 2. Guiding constraints (do not violate)

1. **The frontend must keep working over `file://`.** The whole game already opens
   by double-clicking `index.html` with no server. Server play is **additive and
   opt-in** — the page still opens and plays locally offline. No bundler, no ES
   modules, no `fetch()` of local files in the browser (see root `CLAUDE.md`).
   - WebSocket is **allowed** from a `file://` page (unlike ES modules / `fetch` of
     local files), so a `wss://` client transport is fine.
2. **Reuse the pure engine — one source of truth for the rules.** The server runs
   the *exact same rules code* as the browser by `require()`-ing the pure modules.
   Do **not** re-implement scoring, the reducer, or the wire codecs on the server.
3. **The server runs `MP.Session`, it does not replace it.** `mp.js`'s `Session` is
   already a transport-pluggable, host-authoritative state machine. The server hosts
   an instance per room over a WebSocket transport. We *extend* the protocol for
   server-owned dice; we don't rewrite it.
4. **`mp.js` stays pure and UMD.** It is shared by browser and server and unit-tested
   in Node. Any protocol change lands there with round-trip tests, DOM-free.
5. **Incremental & always-green.** Every phase is independently verifiable. Run
   `node --test` before every commit; the frontend puppeteer smoke (per `CLAUDE.md`)
   before any commit that touches browser files.

## 3. Architecture at a glance (so you don't have to re-explore)

**Pure, Node-usable modules the server reuses (all UMD, DOM-free):**

| Module | Global | What the server uses it for |
|---|---|---|
| `game.js` | `window.General` (**G**) | scoring (`scoreFor`, `assignScore`), categories, **RNG** (`rollDie(rng)`, `rollAll(rng)` — already pluggable!), AI (`aiChoose`…), player/game factories |
| `exp.js` | `window.GeneralExp` (**X**) | experimental-ruleset flow + scoring |
| `reduce.js` | `window.GReduce` | **pure turn reducer** — `reduce(state, action)`; the shell rolls dice and feeds faces in via the action (server becomes that shell) |
| `mp.js` | `window.MP` | L1 framing (`frame`/`unframe`, CRC-8), all wire codecs, and **`MP.Session`** — the host-authoritative lobby→turn→end state machine |

> ⚠️ `features/exp/exp.js` (the *app glue*) is DOM-coupled — **not** server-usable.
> Only the four root modules above are pure. `features/**` is browser-only.

**How the transport seam works (this is where the server plugs in):**

- `MP.Session` takes `opts.transport` with just `send(bytes)` + `onReceive(cb)`.
- In the browser, `PeerBus` (`features/net/net.js:460+`) implements that over WebRTC:
  host relays to all clients (star topology), client sends only to host.
- **Server plan:** a `SocketBus` implements the same two-method contract over `ws`.
  The server constructs `new MP.Session({ transport: socketBus, isHost: true, … })`
  per room. The browser gets a matching `SocketBus` (WebSocket to the server) as an
  alternative transport to `PeerBus`.
- **Already built (Phase 0.3):** `server/listener.js` hands each accepted socket to
  `onConnection(conn)` as a `{ send, onReceive, onClose, isOpen, close }` object —
  the same two transport methods, per socket, plus what a grouping layer needs to
  know when a socket vanished (`onClose`, single-slot) and whether it is still
  alive at all (`isOpen` — `'close'` is one-shot, so a conn adopted after it died
  would leave a ghost member).
- **Already built (Phase 1.1):** `server/socket-bus.js` is that grouping step — fan
  one room's connections into one bus with `PeerBus`'s star topology. The bus **is**
  the transport (`send`/`onReceive` live on it), so it goes straight into
  `new MP.Session({ transport: bus, isHost: true, … })`. Star means: the session's
  frame reaches every socket; a socket's frame reaches the session and **nobody
  else**. That last part is the authority model — relaying a client's bytes to its
  peers would let a client speak with the host's voice.
- **Already built (Phase 1.2):** `server/room.js` is the session on top of that bus,
  and `index.js` opens exactly one room at boot and routes every accepted socket to
  it. Two things a browser-hosted session never has to think about, and which any
  code added here must keep doing:
  - **The server referees, it does not play.** The room builds its session with
    `hostPlays: false` (`mp.js`), so the host holds **no roster seat** — seats start
    at 1. A browser host is a player at its own table and takes seat 0; a server host
    that did the same would put an empty chair in the turn order and grant it a turn
    nobody was ever going to play.
  - **`Session` timers are unref'd** (`room.unrefTimeout`). The lobby beacon re-arms
    every few seconds for as long as the room is open; under Node that keeps the
    event loop alive, so the process would outlive its own listener.
- **Already built (Phase 1.3):** `features/net/socket-bus.js` is the **browser** end —
  the client half of `PeerBus` over a WebSocket to the server, with the same
  `send`/`onReceive` + `start()`/`stop()` surface, so Phase 7 can hand either bus to
  `newSessionWith()` (`net.js:334`). It is loaded by `index.html` and **called by
  nothing yet**. Two things to know before touching it:
  - **It is UMD and DOM-free on purpose** — a documented exception to "`features/**`
    is browser-only" — so `test/server/socket-bus-client.test.js` can `require()` the
    real file and drive it against a real server with `ws` injected as
    `opts.WebSocket`. Keep it DOM-free; UI wiring belongs in `net.js`.
  - **A HOST session never answers `PING`** (`_rxHost` has no PING branch — it is in
    `_rxClient`, `mp.js:688`). To probe a server room, wait for the lobby `BEACON` or
    send `JOIN_REQ`. The listener's own PING/PONG echo is socket-level, not this.

**Wire protocol (in `mp.js`):**

- Framing: `[TYPE][SENDER][SEQ][PAYLOAD…][CRC8]` (binary `Uint8Array`; WebSocket
  carries binary frames natively).
- Message types `T`: `BEACON, JOIN_REQ, JOIN_ACK, ROSTER, START, GRANT, MOVE, STATE,
  RESYNC_REQ, PING, PONG, END, META, READY, PREP, AICTRL, TACT, SPUR, JOIN_NAK, BYE`.
- Lobby/roster/turn codecs are compact binary; **game payloads are JSON**
  (`packMove` → `{playerId, category, score, log}`, `packStateDelta/Snapshot`).
- `MOVE` today = *client declares the final score*; `log` is an opaque per-turn
  detail string (rolls/keeps) that the host never re-parses or validates. **This is
  the contract Phase 3 changes.**

**Identity today:** none. `Session.myId` is a numeric seat id assigned by the host on
`JOIN_ACK`; `eph` is a random per-device token that survives reconnects (host maps
`eph → seat`). No authentication; names/colours are free text, deduped for display.

**The authority gap (the heart of the project):** `game.js:143-145` states rolls
happen on the turn-holder's device and only the *result* is shared — "no shared-RNG
path to desync." The host checks only `playerId === activeId` and "category not
already filled" (`mp.js` `_rxHost`), **not** the dice or score. Phase 3 moves RNG +
scoring to the server.

## 4. How to use `PLAN.md` (it's the tracker)

The plan is organized into **phases**, each a list of **tasks** with a status marker:

| Marker | Meaning |
|---|---|
| `[ ]` | not started |
| `[~]` | in progress (leave a one-line note of where it stands) |
| `[x]` | done **and verified** (tests green, committed) |
| `[!]` | blocked / needs a decision (see the note; often an entry in *Open decisions*) |

At the top of `PLAN.md`, **`## Current status`** always points at the phase/task in
flight and the immediate next step. Keep it accurate — it is the first thing the
next session reads.

### The resume loop (for any session, human or agent)

1. Read this README, then `PLAN.md`'s `## Current status`, then `git log`.
2. Pick the first `[ ]`/`[~]` task in phase order (unless *Current status* says
   otherwise). Re-read that task's *why*, *files*, and *Definition of Done*.
3. Do the work in a scoped way. Prefer the repo's subagents
   (`docs/SUBAGENT-WORKFLOW.md`): `explorer` for reads, `implementer` for the change,
   `reviewer` for a diff check.
4. **Verify** per the task's DoD: `node --test`; add/extend tests; puppeteer smoke if
   browser files changed.
5. **Commit** (see conventions below), then **update `PLAN.md`**: tick the box, move
   `## Current status`, and add a line to the *Decision log* if you made a
   non-obvious call.
6. Push to the working branch.

### Commit conventions (commits are our memory)

Per the user's direction and root `CLAUDE.md`:

- Each commit is **one logical slice**. The message says **what** changed and
  **why**, with reasoning for any tricky decision — enough that the commit history
  reconstructs *why we did it this way*, without being bloated. A future session
  (or reviewer) should be able to read the log and understand the design intent
  per file / per decision.
- Reference the phase/task, e.g. `backend(P1): SocketBus WebSocket transport …`.
- Keep the plan and the code in sync **in the same commit** when practical (tick the
  box in the commit that finishes the task).
- End messages with the `Co-Authored-By` / `Claude-Session` trailers (per session
  attribution rules).
- If a change is **user-visible in the browser**, bump `APP_VERSION` + add a
  CHANGELOG entry in `features/core/core.js` (root `CLAUDE.md` rule). Pure server or
  docs/tests changes skip the bump.

## 5. Running & verifying the server

Phase 0 has landed, so this is real now:

```
npm install                     # one manifest at the repo root (Decision D1)
node server/index.js            # listener + one open room; Ctrl-C / SIGTERM drains and exits 0
node --test                     # engine + protocol + server suites (283 tests)
node scripts/smoke.js           # the frontend's file:// smoke — required if you touched mp.js
```

**Layout (`server/`, plain Node CommonJS — never runs in a browser):**

| File | Role |
|---|---|
| `engine.js` | binds the four pure modules; `CONTRACT` + `selfTest()`/`assertReady()` |
| `config.js` | env → frozen config; bad values throw at boot naming the variable |
| `log.js` | structured `{ts, level, msg, ...fields}` records, json/text, child loggers |
| `lifecycle.js` | reverse-order drain hooks under a grace deadline |
| `listener.js` | HTTP health endpoints + `/ws` upgrade; hands out transport-shaped sockets |
| `socket-bus.js` | one room's sockets fanned into the single `MP.Session` transport (star) |
| `room.js` | one bus + one host-side `MP.Session` — the server as referee |
| `index.js` | `boot()` wires it all; `main()` installs signal handlers and listens |

**Endpoints:** `GET /healthz` (liveness — is the process up?), `GET /readyz`
(readiness — should a balancer route to it? 503 while draining), `WS /ws`.

**Config** is all env, defaults in `server/config.js` (`config.describe()` lists the
operator-facing set): `PORT` (8787; `0` = any free port), `HOST`, `LOG_LEVEL`,
`LOG_FORMAT` (defaults to text on a TTY, json otherwise), `MAX_PLAYERS_PER_ROOM`
(6), `MAX_ROOMS` (100), `ROOM_IDLE_MS`, `HEARTBEAT_MS` (30000; `0` disables),
`MAX_FRAME_BYTES`, `ALLOWED_ORIGINS` (empty = any; a `file://` page sends
`Origin: null`, so name `null` explicitly if you set an allowlist),
`SHUTDOWN_GRACE_MS`.

**The invariant `listener.js` exists to keep: one bad connection must never take
the process down.** A server refereeing many rooms cannot let a single rude or
broken client kill every other game on the box, so every boundary where foreign
code or foreign bytes enter is wrapped — the accept callback, the receive
callback, the health handler — and `send()` **never rejects** (`MP.Session` calls
it without a `.catch()`, so a rejection would be an unhandled rejection, which
Node turns into an exit). Keep that property when adding to this file; the tests
under "one bad connection must never take the process down" are the guard.

**Server tests** need no separate lane: they live in `test/server/` and Node's
default test glob (`**/test/**/*.js`) already finds them. Two things to know:

- That glob **executes every `.js` under `test/`** as a test file, so shared test
  helpers must live in `server/`, not `test/`.
- `ws` is also pulled in transitively by puppeteer, so a genuinely missing
  dependency would still pass locally. CI installs explicitly
  (`npm ci --omit=dev`) to catch that.

The frontend keeps its zero-tooling workflow untouched: open `index.html` over
`file://`, `node --test`, puppeteer smoke — exactly as documented in root `CLAUDE.md`.

## 6. Open decisions

Product/architecture questions that need an owner call are tracked in
**`PLAN.md` → `## Open decisions`** with a recommended default each. They are
flagged `[!]` on the tasks that depend on them. Don't silently assume — either use
the recorded default or raise it.
