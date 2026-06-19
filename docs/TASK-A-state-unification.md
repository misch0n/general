# Task A — State extraction & unification (handoff)

**Purpose:** resume this refactor cleanly in a fresh session. Read CLAUDE.md first, then this.

## Goal
Collapse the scattered runtime game state into **one `GameState` schema** with a
`reduce(state, action)` core, **to avoid future bugs** from duplicated/desynced state.
Local-vs-network becomes just the *source of actions*, not a separate state shape.

**Confirmed scope (user chose "Full, incl. exp merge"):** also **merge the standard and
experimental parallel code paths** (`exp.js` currently duplicates `expStartGame` /
`expBeginTurn` / `expCommit` / the `gExp() ? expRenderAll : renderAll` dispatch) into one
ruleset-parameterized flow. Done **incrementally, one committed+verified slice at a time.**

## Slice plan & status
1. ✅ **DONE** (commit `4f8cc92`) — *single source of truth for ruleset*. `game.ruleset` is now
   set in every creation path (local/net, std/exp, fresh/resume); the `expMode` global is deleted;
   ~19 read sites go through the new `gExp()` helper (in `features/core/core.js`).
2. ✅ **DONE** — *fold turn state + mode into the `game` object.* Two commits:
   - **2a** (`9746349`): mode → `game.manual`, read via the new `gManual()` helper (core.js), same
     null-guarded pattern as `gExp()`. Set at every creation path; serialized `rec.manualMode` /
     `snap.manualMode` and the record key `manualMode:` are unchanged.
   - **2b**: the 12 turn globals (`dice`, `selected`, `diceNew`, `diceGen`, `throwsLeft`, `rollNo`,
     `awaitingRoll`, `locked`, `aiBusy`, `rerolledAll`, `manualCounts`, `curLog`) moved onto a single
     `game.turn` object via `freshTurn()` (game.js), initialized in every creation path. `dice` needed
     hand-care (local `dice` params/vars in exp.js EV-helpers + `$('dice')` strings + `dice:` keys must
     NOT be rewritten); the rest were a guarded perl (`(?<!.)\bNAME\b(?!:)` → `game.turn.NAME`, valid
     for reads AND writes). Also added `scripts/smoke.js` (commit `638ad1a`) as the app-loop safety net.
3. ✅ **DONE** — *introduce `reduce(state, action)` for the turn flow.* New pure, DOM-free module
   `reduce.js` (UMD → `window.GReduce`, loaded after `mp.js`, before the features) implements the turn
   state machine: `BEGIN_TURN` (mode `dice`|`manual`|`net`), `FIRST_ROLL`, `REROLL`, `COMMIT`,
   `TAP_MANUAL`, `UNDO`, `NEXT_TURN`, `END_GAME`. It never mutates its input and rolls **no** random
   dice — the imperative shell rolls and passes faces in via the action, which keeps reduce
   deterministic/testable; side effects (render, net send, timers, AI scheduling, per-turn logging,
   ruleset-coupled score assignment) stay in the shell. `freshTurn()`/`manualDiceArray()` now delegate
   to `GReduce`. Routed mutators in `features/game/game.js`: `beginTurn`, `firstRoll`, `applyReroll`
   (still called by `ai.js`/`exp.js` unchanged), `tapManualDie`, `popUndo`, the local commit-lock in
   `afterCommit`, and `endTurn`. **Added 21 `reduce()` unit tests** (`test/reduce.test.js`) — the first
   coverage for the app game-loop (177 tests pass; smoke green for both rulesets × dice/manual).
   *Not yet routed (by design):* the exp first-roll/commit path (slice 4) and the net commit/snapshot
   mutations (slice 5); `BEGIN_TURN mode:'net'` is wired but the rest of the net turn flow is slice 5.
4. 🟡 **IN PROGRESS** — *merge the exp parallel path.* **4a DONE** — the exp **turn-flow state
   machine** now routes through `GReduce.reduce`, exactly like the standard path: `expBeginTurn`
   (BEGIN_TURN `manual`/`dice` + AI FIRST_ROLL), `expFirstRoll` (FIRST_ROLL), `expCommit`'s local
   lock (COMMIT), and `expEndTurn` (END_GAME + NEXT_TURN) no longer mutate `game.turn` inline.
   Free-order exp needs to skip finished seats, so `reduce()`'s `NEXT_TURN` gained an optional
   `action.done` boolean[] skip-mask (standard passes none → identical single advance); the shell
   computes `done = players.map(X.playerDone)`. The exp **net** commit branches stay inline (slice 5,
   same as standard `afterCommit`). **Added 2 `NEXT_TURN` skip tests** (179 pass; smoke green both
   rulesets × dice/manual). *Score assignment stays shell-side* (`G.assignScore` vs `X.assignScore`)
   by design — `reduce()` COMMIT only locks; it does not pick engine fns.
   **4b DONE** — `renderAll` (`features/game/game.js`) is now the **single render entry** for both
   rulesets × both sources. It dispatches the genuinely-different pieces internally: header/pills →
   `expRenderHeader`/`expRenderPills` only for **local exp** (`gExp() && !netMode`, preserving the
   prior net-exp behavior of standard header/pills); board/hint → `expRenderBoard`/`expRenderHint`
   for any exp (`sumExp()`). `expRenderAll`/`expRenderDice`/`expRenderFire` were **deleted** — the
   standard `renderDice`/`renderFire` are exact supersets (the exp variants were just the no-`fx`,
   no-net-spectating case), so local exp now shares them. All ~10 `gExp() ? expRenderAll : renderAll`
   dispatch sites (game.js, modals.js, tutorial.js) and the inline `expRenderDice/Fire` branches
   collapsed to plain `renderAll()`/`renderDice(); renderFire()`. (179 tests pass; smoke green for
   both rulesets × dice/manual.) *Still duplicated (out of 4b scope):* `expStartGame`/`resumeExpGame`
   start/resume scaffolding (fold into `startGame`/`resumeGame`) and the header/pills exp variants
   themselves (`expRenderHeader`/`expRenderPills` — a 2-line name layout + `expPeek`); these could
   merge later but were left to keep the diff behavior-preserving.
5. ⬜ **Unify serialization** — resume / archive / net wire codec / replay all read **one** schema via
   shared serialize/deserialize. Make the net-apply path **emit the same actions** as local play.

## Target schema (sketch)
```
GameState = {
  ruleset: 'standard' | 'experimental',   // canonical (already on game.ruleset)
  mode:    'dice' | 'manual',              // replaces manualMode global
  source:  'local' | 'net',               // replaces netMode (origin of transitions)
  players, current, round, ownerSkipped,  // board
  turn: { dice, selected, diceNew, diceGen, throwsLeft, rollNo,
          awaitingRoll, locked, aiBusy, rerolledAll, manualCounts, curLog },
  moveLog, undoStack,
}
reduce(state, action) -> nextState   // local play and net-apply both dispatch actions
```

## Inventory (key findings)
- ~80 module-level vars exist, but most are **UI/timer/transport junk** (timers, lobby/net-transport,
  history-view, spur/spectate) that are **not** game state — leave them. The real game state is ~20
  vars: the `game` object + turn state + logs.
- **Duplicated sources of truth (the bug risk):**
  - ruleset — was `settings.ruleset` (pref) / `expMode` (global) / `game.ruleset` / `net.exp`.
    Slice 1 made `game.ruleset` canonical in-game.
  - mode — `manualMode` (global) / `net.manual` (lobby) / `rec.manualMode` (serialized). Slice 2 target.
  - the **experimental ruleset runs as a whole parallel code path** (`exp.js`) — biggest duplication; Slice 4.
- `G.createGame` / `X.createGame` return `{players,current,round}` only — they do **not** set
  `ruleset`. Slice 1 added `game.ruleset = …` at each call site (game.js startGame/resumeGame,
  exp.js expStartGame/resumeExpGame; net.js already set it at ~line 1009).

## Mutation hotspots (where reduce() will absorb logic)
`startGame` / `beginTurn` / `firstRoll` / `humanFire`+`applyReroll` / `commitScore`+`afterCommit` /
`endTurn` (all `features/game/game.js`); `tapManualDie` / `popUndo` (manual); `expStartGame` /
`expBeginTurn` / `expHumanFire` / `expCommit` (`features/exp/exp.js`); net: `startNetGame` /
`netSetTurn` / `netApplyRemote` / `netApplySnapshot` (`features/net/net.js`).

## Serialization boundaries (must keep working through every slice)
- **Resume** — `saveResume`/`loadResume` (`features/core/core.js`), snapshot at each `beginTurn`.
- **Archive** — `archiveGame` + the record shape (core.js; exp games archive via `exp.js` ~L543 — a
  separate path that Slice 4/5 should unify).
- **Net wire** — `MP.packMove`/`packStateDelta`/`packStateSnapshot` + `packRecord` (`mp.js`); net move =
  `{category index, score, rolls, keeps, log}`.
- **Replay** — reconstructs actions from `moveLog` (`features/history/history.js`).

## Verification each slice
- `node --test` (currently **156** pass) — never let it drop except by intentionally adding tests.
- Puppeteer file:// smoke: start a game in **both** rulesets (`settings.ruleset`), roll, commit, reach
  summary; assert **zero `pageerror`**. (Drive via `startFromSetup(false)` after setting `settings.ruleset`.)
- From Slice 3 on, add `reduce()` unit tests under `test/`.

## Gotchas
- Classic global scope + load order (see CLAUDE.md). `reduce()` should live somewhere loaded before its
  callers (core or game) — mind the order.
- `gExp()` reads `game.ruleset`; `game` can be `null` pre-game → helper returns false. Keep that guard
  for `gManual()` too.
- When replacing a global via perl, **exclude the write sites** (`name =`) and property access
  (`.name`) or you'll mangle them (Slice 1 hit `gExp() = false` once — fixed). Prefer explicit edits
  for writes, perl only for bare reads with a negative-lookbehind for `.`.
