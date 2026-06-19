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
2. ⬜ **Fold turn state into `game.turn`** — move the scattered turn globals (`dice`, `selected`,
   `diceNew`, `diceGen`, `throwsLeft`, `rollNo`, `awaitingRoll`, `locked`, `aiBusy`, `rerolledAll`,
   `manualCounts`, `curLog`) onto a `game.turn` object. Also make **mode** a single source of truth:
   add `game.manual` (replace the `manualMode` global via a `gManual()` helper, same pattern as `gExp()`).
   Mechanical; verify each step. (~64 `manualMode` sites — but distinguish the **global** from the
   serialized record fields `rec.manualMode` / `snap.manualMode`, which STAY.)
3. ⬜ **Introduce `reduce(state, action)`** for the turn flow (`BEGIN_TURN`, `FIRST_ROLL`, `REROLL`,
   `COMMIT`, `TAP_MANUAL`, `UNDO`, `NEXT_TURN`, `END_GAME`). Route existing mutators through it.
   **Add `reduce()` unit tests** — this is the first real coverage for the app game-loop (today only
   the engine is unit-tested; the loop is puppeteer-only). reduce() being pure makes it testable.
4. ⬜ **Merge the exp parallel path** — `reduce()` picks engine fns by `state.ruleset`
   (`G.scoreFor` vs `G.scoreForExp`, `G.CATEGORIES` vs `G.CATEGORIES_EXP`, `G.assignScore` vs
   `X.assignScore`). Delete `expStartGame`/`expBeginTurn`/`expCommit` duplication and the
   `gExp() ? expRenderAll : renderAll` dispatch where possible. **Riskiest slice.**
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
