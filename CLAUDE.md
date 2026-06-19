# Генерал (General) — Claude Code guide

A single-page, **no-build** web player for the Bulgarian dice game Генерал. Pure vanilla
JS/CSS/HTML. It must keep working when you **double-click `index.html` (the `file://`
protocol)** — there is no server, bundler, or transpile step.

## Hard constraints (do not break these)
- **No build step, no deployment change.** No bundler, no `npm run build`, no TypeScript.
  Ship the files as-is. (A Vite/TS migration was tried and reverted because it broke `file://`.)
- **Must run over `file://`.** Therefore:
  - **No ES modules** (`<script type="module">`, `import`/`export`) — Chrome blocks them over file://.
  - **No `fetch()` of local files**; cannot split HTML into fetched fragments (HTML stays in `index.html`).
  - Scripts are **classic, global-scope** `<script src>` tags. Every top-level `var`/`function`
    is effectively a **global shared across all files**.
  - **Load order matters** (defined in `index.html`): a file's top-level *executed* code can only
    call functions already defined by an **earlier-loaded** file. Function *declarations* hoist only
    within their own file, not across files. (This is why `boot.js` loads last.)
- CSS is plain `<link>`ed stylesheets; **link order = cascade order**.

## Run & verify
- **Open:** just open `index.html` in a browser, or `file://<abs-path>/index.html`.
- **Unit tests:** `node --test` (engine + net/session logic; currently **156 tests**).
- **UI smoke (headless, over file://):** the app game-loop has **no unit tests** — puppeteer is the
  app-level safety net. Write a short script (puppeteer is in `node_modules`) that loads
  `file://$PWD/index.html`, drives `#playBtn` (dispatch real `pointerdown`+`pointerup`+`click`),
  and asserts **no `pageerror`**. Test BOTH rulesets (`settings.ruleset = 'standard'|'experimental'`).
- **After any change:** run `node --test` AND a puppeteer load before committing.

## Architecture
Two layers, loaded in this order (see `index.html`):

**1. Engine (pure logic, repo root) — `window.*` globals, unit-tested:**
| File | Global | Role | Tests |
|---|---|---|---|
| `game.js` | `window.General` (**G**) | core rules: scoring, categories, AI, game/player factories | `game.test.js`, `engine.test.js` |
| `exp.js` | `window.GeneralExp` (**X**) | experimental ruleset engine | `exp.test.js` |
| `engine.js` | `window.GeneralEV` (**EV**) | optimal-value tables, skill/luck analysis | `engine.test.js` |
| `ev-table*.js`, `ev-exp-exact-table.js` | — | precomputed EV data | — |
| `mp.js` | `window.MP` | net **session/lobby state machine** (`MP.Session`) + wire codecs (`packMove`/`packStateDelta`/`unframe`…) + dormant link-adaptation layer | `mp.test.js`, `webrtc.test.js` |

> Net is **WebRTC-only** (PeerJS). The acoustic (data-over-sound) and optical (QR-handshake)
> transports were removed; `mp.js` keeps `MP.Session` + codecs (the shared core WebRTC uses).

**2. App (UI + game loop) — `features/<name>/*.js`, classic global scope:**
Load order: `core → setup → net → game → exp → game/ai → modals → summary → history → tutorial → settings → core/boot` (**boot runs last**).
- `features/core/core.js` — bootstrap: binds G/EV/X, EV tables, analytics, `settings`, storage/resume, owner helpers, `$`, `gExp()`.
- `features/core/boot.js` — app init, runs after every global is defined.
- `features/setup/setup.js` — muster/start screen, roster, ruleset & local/network selectors.
- `features/net/net.js` — WebRTC multiplayer: lobby, host/join, QR invite + scan-to-join, spectating, sync.
- `features/game/game.js` — **the core game loop**: state, board render, manual mode, dice interaction, commit/turn flow.
- `features/game/ai.js` — bots, speech bubbles, combo tooltip.
- `features/exp/exp.js` — experimental ruleset engine glue: the exp turn flow (`expBeginTurn`/`expCommit`/…),
  exp board/hint rendering, and the exp evaluator hooks. Start/resume, header, pills and the dice tray are
  **shared** with `game.js` (exp is a parameterization of the one flow, not a parallel path — Task A is done).
- `features/modals/modals.js` — how-to-play, combo reference, settings panel, dev string editor.
- `features/summary/summary.js` — end game, tie-break, awards.
- `features/history/history.js` — archive, replay viewer, career charts, calendar.
- `features/tutorial/tutorial.js` — scripted tutorial.
- `features/settings/settings.js` — export/import, owner, ruleset picker, storage gauge.
- CSS mirrors this under `features/<name>/<name>.css` (+ `features/base/base.css`).

**Per-file function index:** `docs/MAP.md` (regenerate: `bash scripts/genmap.sh`).
**Completed refactor (historic context):** `docs/completed/TASK-A-state-unification.md` — state
unification: one `GameState` + `GReduce.reduce`, one serialize/deserialize across
resume/archive/net/replay, canonical-JSON net wire, and std/exp merged into one parameterized flow.

## Conventions
- Big files use section banners — `// ===== MAJOR` and `// ---------- minor ----------`. **Grep these
  to jump** instead of reading whole files.
- Engine globals: `G` (General), `EV`, `X` (exp), `MP`; `$ = document.getElementById`.
- Live game state currently lives on a global `game` object **plus scattered globals**
  (`dice`, `selected`, `throwsLeft`, `manualMode`, `netMode`, …). Single source of truth for the
  ruleset is `game.ruleset`, read via `gExp()`. (The turn flow now runs through `GReduce.reduce`
  and std/exp share one flow — Task A, complete; see `docs/completed/`.)
- Don't bump `APP_VERSION`/CHANGELOG for pure structural refactors; **do** for user-visible behavior changes.

## Token hygiene (keep sessions cheap)
- Prefer `grep`/section-banners and **ranged reads** over whole-file reads.
- **Delegate** broad searches/reads to the `explorer` subagent, scoped changes to `implementer`, and
  independent diff review to `reviewer` (`.claude/agents/`). Keep only their summaries in the main
  thread. Full workflow + the "do we need a testing agent?" decision: `docs/SUBAGENT-WORKFLOW.md`.
- Use short, **task-scoped sessions**; `/clear` between unrelated tasks.

## Git
- Develop on the active feature branch; commit per logical slice; verify (`node --test` + puppeteer
  smoke) before each commit. End commit messages with the `Co-Authored-By` / `Claude-Session` trailers.
