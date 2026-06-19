# Task A — State extraction & unification (✅ COMPLETE — archived)

> **STATUS: DONE.** All slices (1–5 incl. 5c-remainder) landed; the standard and experimental
> code paths are merged — exp is now a *parameterization* of the one flow (engine factory + a
> couple of internal `gExp()`/`sumExp()` branches), not a parallel set of functions. The turn flow
> runs through `GReduce.reduce`; resume/archive/net-wire/replay all read one schema; the net wire
> payload is canonical JSON. This file is kept in `docs/completed/` for historic context only — it
> is **not** an active worklist. The single remaining item below ("Also still dormant" — the
> acoustic modem/adaptive-link layer) is **orthogonal to Task A** and was never in its scope.
>
> *As-built notes on the final slice-4 merge (start/resume scaffolding, pills+peek, header):* see
> the slice-4 entry below; the exp functions `expStartGame`/`resumeExpGame`/`expRenderHeader`/
> `expRenderPills`/`expPeek` were deleted and folded into `startGame`/`resumeGame`/`renderHeader`/
> `renderPills`/`openPeek`. Two latent exp bugs were fixed in passing (ownerDetached at start;
> `resumeExpGame` ignoring `snap.manualMode`).

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
4. ✅ **DONE** — *merge the exp parallel path.* **4a DONE** — the exp **turn-flow state
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
   **4c DONE (final)** — those leftovers are now folded in. `expStartGame`/`resumeExpGame` →
   `startGame`/`resumeGame` (branch only on the engine factory + ruleset tag + begin-turn fn);
   `expRenderHeader` → an internal local-exp branch in `renderHeader`; `expRenderPills`/`expPeek` →
   the shared `renderPills` + a ruleset-aware `openPeek` (picks `expMiniBoard` via `sumExp()`).
   `renderAll` calls plain `renderHeader()`/`renderPills()` now — no ruleset dispatch. Fixed two
   latent exp bugs in passing: start ignored `ownerDetached`; `resumeExpGame` hard-coded
   `game.manual = false` (now honors `snap.manualMode`). `syncHintBtn` became ruleset-aware
   (`exactReady` vs `evReady`). The exp **board + hint** stay as `sumExp()`-dispatched helpers
   (`expRenderBoard`/`expRenderHint`) — genuinely different, by design (4b). (185 tests pass; smoke
   green: 4 play + 2 resume + 1 replay.)
5. ✅ **DONE** — *unify serialization* — resume / archive / net wire codec / replay all read
   **one** schema via shared serialize/deserialize; make the net-apply path **emit the same actions**
   as local play.
   **5a DONE** — one shared **JSON envelope** for resume + archive, both rulesets. New
   `serializeGame()` (`features/core/core.js`, after `serializePlayers`) returns the canonical
   `{ruleset, manualMode, ownerSkipped, net, players, moveLog}`; `saveResume` adds `v/ts/current/round`,
   `saveCurrentGame` (summary.js) adds `id/ts/ownerNamed/selectKeep`, and `archiveExpGame` (exp.js) adds
   `id/ts` — all three stopped hand-building their own object. The **exp archive's bespoke player shape
   is gone**: it used to omit `bet/bonus/selectKeep/diceBatch` and store a `pts` total, but `recTotal()`
   always recomputes exp totals from `scores` (history.js) so `pts` was dead data — exp now archives via
   the same `serializePlayers()` as standard. On the read side, `resumeExpGame` now rebuilds players via
   the shared `reconstructPlayers()` (history.js) instead of its inline map — identical to standard
   resume. Added a **resume round-trip to `scripts/smoke.js`** (play 3 turns → reload → `loadResume` →
   `resume(Exp)Game` → assert restored, both rulesets) — the first coverage for the resume path.
   (179 tests pass; smoke green: 4 play + 2 resume.)
   **5b DONE** — the net-apply score write now goes **through the reducer** instead of mutating
   player state inline. New pure `APPLY_SCORE` action (`reduce.js`) mirrors a committed score onto a
   seat — the net-apply analogue of the local engine's `assignScore` (it trusts the already-validated
   remote/host score, so no dice check, but keeps the same "never overwrite a filled cell" guard). It
   clones only the touched seat (untouched seats keep identity) and returns a new `players` array; the
   shell reassigns `game.players = reduce(…).players`. All three inline `pl.scores[key] = …` writes on
   the net path now route through it: `netApplyRemote`, `netApplySnapshot` (re-reads the seat per cell,
   since the array is replaced each apply — fixing a latent stale-`pl` read), and the spectator preview
   in `playSpecAction`. **Added 4 `APPLY_SCORE` unit tests** (183 pass; local smoke green for both
   rulesets × dice/manual — the net path has no smoke, but the change is a mechanical guard-preserving
   reroute covered by the new pure tests).
   **5c (partial) DONE** — closed the two *safe, behavior-preserving* halves of "5c+":
   - **Replay extracts from state.** `rpStateAt` (`features/history/history.js`) no longer rebuilds
     the board with its own loop over committed cells; it folds each commit through the shared reducer
     (`GReduce.reduce` `APPLY_SCORE`), so replay uses the *same* "a committed score lands on a seat"
     rule (+ filled-cell guard) as live/net play. The roll/commit *render* vocabulary in
     `buildReplayActions` is intentionally kept — it carries display-only data the reducer has no
     concept of (`gens` batch-ordering, `keep`/`reroll` highlight masks, `rollNo`). Added 2 reducer
     tests (round-robin fold + scrub-prefix) and a **replay round-trip to `scripts/smoke.js`** (play a
     standard game → open its archived record → step every frame → assert the reconstructed board
     matches) — the first app-level coverage of the replay path.
   - **Removed the dead acoustic record codec.** `packRecord`/`unpackRecord` (`mp.js`) were a *third*,
     competing game serialization (compact binary record) alongside `serializeGame()` and the live
     wire; they outlived the acoustic transport but had no remaining caller. Deleted (+ their export,
     the pure round-trip test, and the stale README/CLAUDE.md references). `sanitizeRecord` stays — it
     still hardens the live JSON-paste import (`settings.js`).

   **5c-remainder DONE** — the net wire **payload** is now the canonical game shape, JSON-encoded
   (see the section below for the full plan this closed). **Step 0** first: added a loopback
   **turn-log convergence** test (`test/mp.test.js`) — the existing 3-device full-game test only
   asserted the numeric scoreboard converged; the new one asserts the full per-player `mv.log`
   (the canonical JSON) converges on every device too (host included), proving it survives
   host→clients (STATE delta) and client→host (MOVE). Then the rewrite: `packMove`/`unpackMove`,
   `packStateDelta`, `packStateSnapshot`/`unpackState` (`mp.js`) dropped their hand-packed binary
   fields and now emit/parse a UTF-8 **JSON** payload — a move action `{playerId, category, score,
   log}` and a `{kind, version, scores}` projection. The L1 frame (type/sender/seq/CRC) is
   untouched; only the payload bytes changed (the `log` field already did exactly this). The dead
   binary `rolls`/`keeps` sidecar (never read on receive — the detail rides in `log`) and the
   unused `ackVersion` are gone, including from the two app-side `mv` literals in `afterCommit`
   (`features/game/game.js`). `category` stays a numeric **index** on the wire (net.js bridges
   index↔key at the edge via `catIndexOf`/`catKeyAt`, as before). No wire back-compat needed
   (single live version); JSON also natively carries minus-ruleset negatives and drops the old
   ±32768 i16 clamp. (185 tests pass — the negative-score round-trip still green through JSON;
   smoke green: 4 play + 2 resume + 1 replay.) (Still pre-existing, left as-is: `resumeExpGame`
   hard-codes `game.manual = false`, ignoring `snap.manualMode`.)

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
- **Net wire** — `MP.packMove`/`packStateDelta`/`packStateSnapshot` (`mp.js`); since 5c-remainder
  these carry the **canonical shape as JSON**: net move = `{playerId, category index, score, log}`,
  state = `{kind, version, scores}`. (`packRecord` was removed in 5c.)
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

---

## 5c-remainder — net wire **payload** → canonical schema (✅ DONE)

**Status:** DONE (see the slice-5 "5c-remainder DONE" entry above for the as-built summary). Step 0
(the loopback turn-log convergence harness in `test/mp.test.js`) landed first, then the three codecs
in `mp.js` were rewritten to JSON. The original plan is kept below for context.

### The vision (from the repo owner)
One **grand unified schema** (the Target schema above) + `reduce(state, action)` as the *only* mutator;
**ruleset is a reduction** (a parameterization of reduce), not a parallel path. **Local play, network,
resume, and replay are all just different *sources of actions/state* feeding that one schema.**
**Transport is a means to get data, NOT something that defines state.** The acoustic transport that
once forced everything into a constrained binary protocol is **scrapped** — so that constraint is
gone. **Version mismatch is a non-issue** (everyone plays the single live version). The owner explicitly
**accepts a one-time loss of old-history rendering** as long as games created *going forward* process
correctly through the unified schema.

### What's already true (so you don't re-discover it — this session's findings)
- **The receive/apply path is already on the schema (slice 5b).** `netApplyRemote`
  (`features/net/net.js`) and `netApplySnapshot` already translate inbound wire data into a reducer
  `APPLY_SCORE` action — they do **not** mutate `pl.scores` inline. So "network feeds data *into* the
  schema" is essentially done; what remains is cosmetic on the *encoding* side.
- **The wire already carries canonical JSON.** `packMove`/`packStateDelta` embed a
  **JSON-stringified turn-log entry** (`mv.log`) — that's how every device reconstructs full
  per-player history. The other fields (`category` **index**, `score`, `rolls`, `keeps`) are a
  binary sidecar that's partly redundant with `log`.
- **No record is transferred over WebRTC during normal play.** Game-end fires `T.END`; each device
  builds its **own** local archive from its own `moveLog` via `serializeGame()` (slice 5a). (The
  `packRecord` codec that *used* to transfer a whole game was acoustic-only and was deleted in 5c.)

### The actual remaining work
Replace the bespoke binary field-packing in **three** codecs so the payload *is* the canonical
shape (a serialized action, or a `serializeGame()`-shaped projection), making transport a dumb pipe:
| Codec (`mp.js`) | Today (binary fields) | Target (canonical) |
|---|---|---|
| `packMove`/`unpackMove` | `[playerId u8][ackVersion u16][category u8][score i16][rolls…][keeps…][log str16]` | a move **action** payload `{seat, key, score, log}` (+ ack/seq stays in the **frame header**, which is unchanged) |
| `packStateDelta`/`unpackState` (delta) | `[sub=0][version u16][playerId u8][category u8][score i16][log str16]` | the same move action + version |
| `packStateSnapshot`/`unpackState` (snapshot) | `[sub=1][version u16]` then per-player/per-cell `[catIdx u8][score i16]` | a `serializeGame()`-shaped scores projection |
- **Keep the frame layer.** `MP.Session` framing is `[type u8][sender u8][seq u8][payload…][crc8]`
  with ack/resend/gossip — that's the *reliable-link* machinery and must stay. Only the **payload
  bytes** change (from hand-packed primitives to a UTF-8 JSON string — the `log` field already does
  exactly this, so framing/CRC/seq/ack are unaffected).
- **Category index ↔ key boundary (gotcha).** The wire carries `category` as a **numeric index**;
  the reducer/schema use a **string key**. `net.js` already bridges via `catKeyAt`/`catIndexOf`
  (`features/game/game.js`). Decide explicitly whether the new payload carries the index (translate
  at the edge, smaller) or the key (self-describing); keep the translation in *one* place.

### Step 0 — PREREQUISITE: stand up net test coverage (do this first)
There is **no** automated coverage of two peers actually exchanging moves — only pure codec
round-trips in `test/mp.test.js`/`test/webrtc.test.js` and single-process app smoke in
`scripts/smoke.js`. Before rewriting any payload:
1. **Loopback two-`Session` harness** (Node, no network): construct a host `MP.Session` and a client
   `MP.Session`, wire each one's `_send` to deliver bytes straight into the other's `_rx`, and drive a
   full game (START → GRANT → MOVE → STATE delta → END). Assert both sides converge to the same
   `serializeGame()`. `mp.js` is already `require`-able by the test suite, and the callback/dispatch
   map is fully inventoried below — this is the missing safety net that makes the payload rewrite safe.
2. Optionally extend `scripts/smoke.js` with a two-page (two browser contexts) loopback, but the Node
   harness is the higher-value, lower-flake option.

### Wiring map (so you don't re-explore — current as of 5c)
- **Receive dispatch:** `Session._rx(bytes)` → `unframe` → `_rxHost`/`_rxClient` switch on `pkt.type`
  (`mp.js`). Type constants `T.*` at `mp.js:15-26`.
- **Callbacks the app assigns** (`netCallbacks()` in `features/net/net.js`, passed as
  `opts.callbacks`): `onStart(roster,order)`→`startNetGame`; `onTurn(activeId,isMe)`→`netSetTurn`;
  `onMove(mv)`→`netApplyRemote` (mv = `{playerId, category(index), score, log}`);
  `onResync(scores,version)`→`netApplySnapshot` (scores = `{id:{catIdx:score}}`); `onEnd`→`endGame`;
  plus lobby/roster/spectate hooks (`onRoster`,`onStart`,`onAction`,`onSpur`,`onDrop`,…).
- **Send chain:** local commit → `commitScore`→`afterCommit` builds `mv` (`features/game/game.js`,
  search `var mv = {`) → `net.submitMove(mv)` → host `_applyMove`→`_send(T.STATE, packStateDelta)`;
  client `_send(T.MOVE, packMove)`. Host AI seats: `net.submitMoveFor(id, mv)`. Reconnect catch-up:
  `Session.rebroadcast()`→`_send(T.STATE, packStateSnapshot)`.

### Also still dormant (not part of 5c-remainder, separate cleanup if ever wanted)
**✅ Done — removed in Task B** (`docs/completed/TASK-B-net-stack-slimming.md`). The broader acoustic
**modem** layer was still present and unused: `PROFILES`, the adaptive link layer (`_rxAdaptive`,
`AdaptiveController`, `LinkMeter`), and the `XOFFER`/`XWANT`/`XDATA`/`XACK`/`XDONE` type constants.
That was the "large, orthogonal sweep" — Task B carried it out, leaving `mp.js` as framing + session
+ game codecs.
