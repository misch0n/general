# Генерал 🎲

A web player for **Генерал** (General), the Bulgarian dice game in the family of
Yahtzee / Generala. Single-page, **no build step, no dependencies, no network** —
just open `index.html`.

The UI is a phone-first, comically over-decorated **military parody** (ЩАБ
edition): camouflage field, classification banner, brass medals and stencil type.
Under the gloss sits a real **expected-value engine** that solves the game
optimally and powers the AI, the hints and a deep post-game analysis.

```bash
# it's a static page — just open it, or serve the folder:
python3 -m http.server 8000      # → http://localhost:8000
node --test                      # run the dependency-free test suite
```

## Architecture at a glance

| File | Role |
| --- | --- |
| `index.html` | The whole app: inline CSS + one IIFE controller. Owns the DOM, the game loop, settings, history, the summary screen, the replay viewer and the dev editor. |
| `game.js` | **Pure, DOM-free logic** (UMD): scoring, dice, turn/player/game state, the greedy AI, names, roasts, personas, ranks, rarity and the Bulgarian morphology engine. The single source of truth for the rules. |
| `engine.js` | The **EV engine** (UMD): an MDP solver, `evaluate()`, the luck/skill decomposition and the calibrated bot policies. Consumes `game.js`'s scoring — never re-implements the rules. |
| `ev-table.js` | The precomputed optimal value table (16384 floats), generated offline so the page needs no heavy compute at load. |
| `mp.js` | **Acoustic multiplayer** (UMD): a layered, dependency-free data-over-sound stack — L1 framing, General-specific schemas, a host-authoritative `Session`, and a browser-only `AudioFSK` modem. Pure protocol logic is DOM-free and unit-tested. |
| `tools/` | Offline `build-ev.js` (writes `ev-table.js`) and `calibrate-bots.js` (the τ ↔ strength curve). |
| `test/` | `node:test` unit tests for `game.js` and `engine.js`. |

The controller talks to the engine through a tiny ready-gate: `ev-table.js`
calls `EV.setTable(...)`, the controller flips `evReady`, and every EV-dependent
feature (hints, AI lookups, post-game report) checks that flag and degrades
gracefully to the greedy heuristic if the table never loads.

Two `localStorage` keys persist everything: `general:settings:v1` and
`general:history:v1`.

## Gameplay

- **Full-screen board.** Fills the viewport with a thin margin: the scoreboard up
  top, a **medal divider**, and the **dice console** anchored at the bottom. The
  header carries the current player's name, their ★/persona, and the in-game **☰
  menu** (which sits where the player badge used to be).
- **Select-to-reroll.** A turn opens on the general's order with the dice
  **unrolled** (`?`); **tap the dice to make the first throw**. After that, dice
  default to **kept** — tap the ones to re-roll (a ✛ reticle marks them) and hit
  **ОГИН!**; the selection clears each throw. Three throws per turn, and thrown
  dice are always **sorted by face**.
- **Suggestions live inside the scoreboard.** After each throw every open
  category shows what the current dice would score, as a tappable brass chip.
  Combos fillable several ways (e.g. two different pairs for `2x`) show **one chip
  per distinct value**. A small **×** sacrifices a slot.
- **Tap-the-box submit.** Tapping a combo's row commits it **when there's exactly
  one way to score it**; a multi-way combo nudges you with a small guide tooltip
  to *tap the exact number*, and an unscoreable row points you at the ×. (Wiring
  in `renderLower` → `row.onclick`, deciding on `positives.length`.)
- **Any number of players** with custom names, colours and AI toggles, each with
  a separate scoreboard. The current player's board is shown; the rest are
  reachable by tapping their **player pill**. **Drag the grip (⠿)** to reorder
  seats to match the real table.
- **Resume an unfinished battle.** The game is snapshotted to `localStorage`
  (`general:resume:v1`) at every turn boundary; reload (or come back later) and
  you're offered **Продължи / Откажи** — resume rebuilds the state and continues
  from that turn, abort discards it. Cleared automatically when a game ends.

## The goofy layer — РЕЖИМ КАЗАРМА

A single settings switch, `settings.barracks`, gates the entire comedy layer
through the helper `fun()`. It is **off by default** and flippable **even
mid-game**.

- **Off** strips the game to its core — clean play and manual modes, no callouts,
  no combo tooltips or their pranks, no bets and no end-screen stakes.
- **On** switches all of it back on. Everything below lives in the code
  regardless; the switch just blocks it. (The СЪВЕТ hint and the analytics report
  are *core* and stay available either way. The **rare-name titles** are their own
  switch now — see below — independent of КАЗАРМА.)

What the switch governs:

- **Marching orders.** Each turn opens with a brass comic **speech bubble** —
  *🎖 Майор, генералът ти заповядва да хвърлиш каре!* — naming one of your still-open
  categories to aim for (flavour only; `showOrder()`, built from `ORDER_NAMES`).
- **Roasts.** End a turn in disappointment — re-roll the whole hand, or commit
  next to nothing — and a brutal comic **bubble** pops up for a couple of seconds.
  The trigger is `game.js`'s `isDisappointing()`; the line is rendered with
  gender agreement (see below).
- **Shaming combo tooltips + penalties.** Touch a category name in-game and HQ
  "explains" the combo — the tooltip pops **right next to it**, then ambushes you
  with a random **penalty** that it names out loud. `applyPenalty()` draws from a
  context-aware pool:

  | Penalty | Effect |
  | --- | --- |
  | `points` | a fine (`3–47`, or an occasional absurd **−9999999**) |
  | `hideReq` / `hideRand` | hides a category field |
  | `blank` | temporarily zeroes a filled score |
  | `forfeit` | sacrifices an open slot |
  | `shuffle` | reorders the whole board |
  | `changeDice` / `removeDice` | swaps a die's face / confiscates a die (dice mode only) |
  | `pretend` | "the guy next to you is playing now" |
  | `youlose` | an outright **ГУБИШ!** |

  Each penalty runs on its **own timer** and reverts after a few seconds with
  *"Ебавам се, ей ти ги пак."* floated **next to whatever it hit** (the tile, the
  dice, the score — `penAnchor()`). You can stack **several at once**: a new hint
  replaces the tooltip but earlier penalties stand, and the pool refuses to
  double-target (it tallies what's already live before picking). Dice penalties
  are skipped in manual mode; everything else applies.
- **Rare-name starting bonuses, rarity bubbles and the stupid bets** (all below).
- **Every bubble in the game is tappable-away** — tooltips, refunds, roasts and
  orders alike.

## AI players & personas

AI seats keep a generated metallic name (*Сержант Нано Динамо*) and show their
persona beneath it. The **persona is the playstyle** — a five-tier ladder of
genuinely different decision procedures, calibrated in `tools/calibrate-bots.js`
and implemented as `EV.botKeep` / `EV.botCategory`:

| Persona | Tier | Policy | Strength |
| --- | --- | --- | --- |
| Мушица | `random` | 1–2 blind rethrows of the whole hand, then the best immediate placement | ~25% |
| Комар | `greedy` | no table lookup — pure immediate-gain heuristics (`game.js`) | ~64% |
| Леля ти | `epsilon` | ε-greedy (ε = 0.2) over the optimal table | ~77% |
| Кварталния любител | `softmax` | softmax (τ = 0.8) over the optimal table | ~85% |
| Господ бог | `optimal` | always the EV-maximising move | 100% |

None of them ever scratches at random — a forfeit happens only when nothing
scores (Господ бог alone may scratch *strategically*, when the EV table says a
zero now beats a bad placement later).

## Optimal-play hints — СЪВЕТ

Enable **Съвети** in settings (off by default) and a **СЪВЕТ** button appears
in-game (`syncHintBtn()` shows it only when the EV table is loaded, you're in
dice mode and advice is on). Tapping it surfaces **three distinct top moves** from
HQ, each on its own line, with **mini dice** for what to keep and the target
combo — *Щабът съветва: дръж 🎲🎲 · търсиш малка кента* — and **no EV jargon**.

How it's built (`renderHint` + `keepForTarget`):

1. For every still-open category, `keepForTarget(dice, key)` returns the
   **intuitive** keep — only the dice that actually contribute to that target
   (the matching face for `1…6`, the largest group for x-of-a-kind/general, the
   pairs for full house, the distinct run dice for a straight, the high dice for
   chance). No stray dice — if you're chasing fours it keeps the fours, not a
   spare one.
2. Each candidate keep is scored with `EV.keepValue(mask, dice, throwsLeft, keep)`
   and the list is sorted by EV.
3. The list is **deduped by keep signature** so the three lines are genuinely
   different holds, then the top three are shown. On the final throw (no rerolls
   left) it instead lists the three best categories to score right now.

## The post-game report — luck vs skill

Every finished game opens a summary screen, also reachable by opening any archive
entry (the same code path renders both — `showGameOver()` works off the live
`game`/`moveLog`, and the archive reconstructs those before calling it).

Two pieces of shared math feed the whole layer (`engine.js`): the **per-category
cube** — `analyzeGame`/`analyzeManualGame` emit a `byCategory` cell
(`{score, leak, luck, optimal}`) per (player × category), the atom every
per-category view reduces — and **`marginSplit(a, b, M)`**, which decomposes a
point margin `M = ΔLuck + ΔSkill` (par cancels) into integer parts reconciled to
sum *exactly* to the visible margin.

### Headline, verdict & badges

- **Hero line** (`renderWinHeadline`): the winner's name on its own line, then
  *спечели с N точки*, with the margin **split** against the runner-up below
  (*+18 умение / +7 късмет*).
- **Verdict**, anchored on the field's **skill leader** (not necessarily 2nd on
  points): **Тотална победа** (won on skill *and* luck), **Заслужена победа** (won
  on skill, with or against the dice), or **Късметлийска победа** when the points
  winner wasn't the best player — and then it *quotes the exact luck margin that
  overturned it* (e.g. *+9 т. късмет обърнаха мача*).
- **Badges** (`renderWinBadges`) — small accents under the headline: **🥇 Победител**
  (points), **🎯 Тактик** (skill leader), **🍀 Късметлия** (luckiest), and
  **📋 Майстор** for the player holding the most category records.

### Layout

- **A progress chart first.** A collapsible SVG line chart (open by default) sits
  **above** the player list, because it's the general overview. `renderProgressChart()`:
  - On the **Класиране** (standings) tab it plots each player's **running total**
    over the rounds (`progressSeries`).
  - On the **По умение** (skill) tab it plots each player's **running
    optimal-play %** over the turns (`optimalSeries`), with a percentage axis.
  - Every player is drawn in **their own colour**; when you expand a player below,
    the other lines **dim to 45%** so their trajectory stands out. No legend — the
    colours are read straight off the results.
  - **Swing annotations** (`swingsFor`): lead-change rings and big-jump / Генерал
    dots; when a player is highlighted, their swings get a **`+X т.`** label.
  - The collapse state survives re-renders via `summary.chartOpen`.
- **Player rows in every tab.** Each row is a coloured **rank title** (the rank is
  tinted in the player's colour — that *is* their colour key, so there's no
  separate dot), the name, and a per-tab value. **Tap a name** to expand that
  player's full report **inline, between the rows** (reachable from any tab); tap
  again to collapse. Nothing is expanded by default.
- **Four tabs**, each keeping the rows and swapping the top visual + the row value:
  **Класиране** (points, points chart), **Умение** (re-orders by accuracy, optimal
  % + optimal-play chart), **Късмет** (a cumulative-luck-over-turns chart with a
  zero baseline; rows sort by luck and show *резултат · късмет · без късмет* =
  score − luck; hidden in manual), and **Категории** (`renderCatBoard`) — the
  cross-player board laid out as the **in-game scoreboard** (6 upper + 8 lower
  tiles): each cell shows the **% who scored it** and the **highest result**,
  **tinted in the record-holder's colour**, plus the category-master sub-award.
- **Share** (`shareSelected`): the 📤 button captures the **actual summary panel as
  shown** (including an expanded player) to a PNG via DOM → SVG `<foreignObject>` →
  canvas, falling back to a hand-drawn card if the browser taints the canvas.

### Per-player report (`renderReport`)

The engine decomposes the game via its value function into
`final = par + luck + skill` (the header **rounds the parts so they sum to the
shown final** — the remainder is absorbed into `par`, so adding them up never
shows a gap), then dissects it. Highlights:

- A **playstyle box**: the stylised archetype chip (`playstyleFor` →
  Хирург / Комарджия / Чиновник / Каскадьор / Късметлия / Новобранец / Боец), a
  **🎖 ГЕНЕРАЛ** badge when a general was rolled, the **optimal %** on the right,
  the archetype's one-liner, and the average EV lost per turn.
- A **coaching line** (`coachLine`): one synthesised *„Поработи над: X“*
  prescription for this game, collapsing the leak/blunder/stage diagnostics into a
  single weakness (e.g. *избора на категория, особено в края*).
- When you open a **past owner game from the archive**, the report adds a
  **delta line** — this result vs your running averages (*резултат +12 т. ·
  точност −3% …*).
- **Biggest blunder** as a headline + a detail line: *✗ Най-скъпа грешка: игра X*
  then *по-добре Y · −Z т.*; and the **best move** above it.
- Colour-coded stat lines, several broken onto **one item per row**: **Изтичане**
  (hold vs category leak with mistake counts), **Издънки** (дребни / сериозни /
  фатални), **Късмет под лупа** (first throw vs rerolls vs *в решителния край*),
  **Изнервяне** (does EV loss spike after a bad roll?), **Спасения** (bailout
  rating), **Нули** (forced vs self-inflicted), and — **last** — **По етапи**,
  the early/mid/late EV-loss-per-turn each labelled with **its turn range**
  (*начало (ход 1–5) — …*).
- A collapsed **Ход по ход** panel. Each turn row reads
  `[Хn] [combo]` on the left and `[points] [luck EV] [decision EV] [quality]` on
  the right, in uniform columns:
  - **Хn** turn markers; the **combo name turns red** when the slot was
    sacrificed, and the whole row glows **gold when a Генерал was rolled**.
  - Two signed EV numbers (luck, then decision) where a zero reads as a green
    **+0**.
  - A **CSS/SVG quality thumb**: 👍👍 optimal · 👍 okay · 👎 blunder.
  - Beneath it, the **1–3 dice rolls** the player decided from, with the **kept
    dice highlighted between throws** (each non-final roll lights up the dice it
    carried forward; the final roll lights up in full).

EV itself is explained once, in the **?** help window (`buildReportHelp`), whose
terms are colour-matched to the report.

## Полеви отчет — manual mode

A second start option runs the board as a **manual scorekeeper** for a real
table game: tap in all five table dice on the six entry dice at the bottom, and
the scoreboard lights up with **every fillable category** exactly like in regular
play — pick one (or scratch with ×). Entering the full hand means you can't
mentally miss a combo, and it feeds the analytics: manual games get the same
report **adapted to what's knowable** (`EV.analyzeManualGame` — category-decision
accuracy, blunders, zero-outs, stage ratings, the turn breakdown) while the
luck/keep metrics are omitted, since the real rolls were never seen. An **ОПА**
button undoes action-by-action — every die tap and every commit — across the
whole game. Roasts, HQ orders, rare-name bonuses and the non-dice penalties all
still fire.

## Names, rarity, bets & gender

- **Rare names & starting bonuses — the „Титли“ switch.** This whole system is
  **its own opt-in toggle**, independent of КАЗАРМА, and **off by default**. Turning
  **Титли** on shows the rarity notifications and reveals a hidden sub-toggle
  **„Бонус точки“**; turning *that* on as well makes rare names also award **extra
  starting points**. So: off → nothing; Титли → notifications only; Титли + Бонус
  точки → notifications *and* points (`namePointsOn()`). Every name component
  (title / adjective / noun) sits in a **hardcoded percentile bracket** — `0-1` … `5-10` or `10+`
  (common) — so rarities are **consistent across loads**. A component is drawn
  with a probability set by its bracket, and a name's chance is the **product** of
  its three components, so *common title × rare adjective × rare noun* multiplies
  into something genuinely scarce (chances like `1 на 100 000`). Because that
  product skews tiny, awards are **frequency-ranked, not fixed-bracket**: at load
  the engine Monte-Carlos the chance distribution (`randomNameRarity`,
  `bonusForPct`) and only the **rarest ~5 % of name rolls** earn a bonus —
  rarest 1 % → +5 … the 4–5 % band → +1, the 5–10 % band gets just a 🙂. The brag
  bubble talks **odds, not the raw tiny %** — *ГОСПОДИ! 1 на 106 667 имена — топ
  1 % рядкост!* — colour-coded by tier. Titles span **every Bulgarian age** (Хан,
  Боляр, Кавхан, Войвода, Хайдутин, Комита, Опълченец). Draw or **type** a name;
  typing checks it live against the seed (*🎯 Позна!*, `matchSeed`) and adopts the
  name's own gender. Works in manual mode too. (Brackets are tuned in the dev
  editor.)
- **Stupid bets.** Each player is dealt one idiotic wager (*Залага кучето си*,
  *майка си*, *достойнството си*…) from `BETS` and is stuck with it — no
  take-backs.
- **Gender switch.** Each seat picks **мъжко / то / женско** (m / n / f), random
  initially. Switching gender **morphs the same name in place** when the noun
  carries a sibling-gender form (`gv` — *Маймун → Маймуна → Маймунче*), keeping the
  rarity; if the noun has no form for the new gender, it **rolls a fresh name with
  refreshed rarity** instead (`recohereName`). Callouts and roasts agree too,
  including neuter.

## Device owner — the ★ token

One player is **you, the device owner**, marked with a brass **★ token** (in
setup, the header, the peek, the standings and the report). The flag `p.owner`
**follows the player** if you drag them to another seat (`recOwnerIdx` finds it).
In **⚙ settings** you can enter your **battle name** and toggle **„Използвай моето
име“**: on → the owner is always that name; off → the owner gets a random name but
is still the owner. The name persists across sessions.

The setup ★ is **touchable**: tapping it pops a dismissible explainer and a
**„Пропусни старшината за следващата игра“** toggle. That covers the case where
someone else is playing on your phone — flip it and the next game is saved
**without owner attribution** (`game.ownerSkipped`, surfaced as `recOwnerIdx → -1`),
so it shows a ⊘ in the archive and is **excluded from your trends** rather than
polluting them with a result that wasn't yours. It's a one-game decision and
resets when the game starts.

## Acoustic multiplayer — „🔊 Мрежова игра“ (`mp.js`)

Play across **several phones in the same room with no server and no network** —
the speaker→microphone channel carries the game. The protocol is built in the
spec's layers and is **dependency-free**:

- **L1 framing** — `[TYPE][SENDER][SEQ][payload][CRC-8]`; schema-packed payloads
  carry only values (both ends run the same code).
- **L3 General payloads** — the roster (each player's **name / colour / gender**),
  `GRANT`, `MOVE` (a turn's category + rolls/keeps + score), and `STATE`
  delta/snapshot.
- **Host-authoritative `Session`** — one device is the host (single source of
  truth, channel arbiter, referee). The **turn token is the transmit token**, so
  contention only exists in the lobby (ALOHA-style join) and recovery. It runs the
  whole lobby → `GRANT`/`MOVE`/`STATE` loop → `END`, with **idempotent** moves,
  **version-gap resync** (snapshot re-baseline) and retransmit timeouts.
- **L0 `AudioFSK`** — a browser-only Web-Audio FSK modem (sync preamble + length +
  CRC-16; mic echo-cancel/noise-suppression/AGC disabled, since that DSP destroys
  data-over-sound). Pluggable: swap it for ggwave without touching the layers above.

In the app: tap **🔊 Мрежова игра**, then host or join. The roster broadcasts, and
`START` builds the **same game on every phone**. In network mode the **active
player drives input on their own device**; the host's `GRANT`/`STATE` advance
everyone else's board (you watch the score land). Crucially, **each device owns its
own player** — that seat is flagged the owner locally (the ★ on your own name), so
the archived game and your dossier attribute *your* performance. The local player
keeps a full move log; remote players are mirrored score-only.

**Acoustic export / import.** The same channel also transfers a single game
between devices. Export offers **📡 Изпрати по звук**, the archive offers
**🔊 Приеми по звук**: the sender advertises (`XOFFER`), the receiver wants
(`XWANT`), they handshake on a tag and ping-pong a stop-and-wait, CRC-16'd
chunked transfer of a **compact record** (`packRecord` — final dice + category
per turn, the board mask reconstructed on the far end), shown with a progress
bar. The received blob is decoded and run through **`sanitizeRecord`** before it
touches anything — a hard whitelist that **clamps every value and drops unknown
fields, non-primitives, functions and `__proto__` keys** (the key set is
null-proto, so a `__proto__` category can't bypass it). The JSON paste import
sanitises through the same gate, so **every imported record is pure data** — it
can never carry anything executable. The receiver then picks which player is
*them* (owner attribution) and files it.

**The `Акустика` switch.** Every data-over-sound feature — network play and the
sound transfer — lives behind a single settings toggle, **off by default**; when
off they're hidden entirely.

The pure protocol logic is covered by `test/mp.test.js` — framing/CRC, every
schema, a full **3-device game converging to identical state**, idempotency,
gap→snapshot resync, the record codec, the **sanitiser** (junk/`__proto__`
stripping), and a full chunked **blob transfer**. The acoustic L0 itself needs
real two-device tuning (range, volume, room noise) and is best-effort.

## Военен архив — history & replay

Every finished battle is saved to `localStorage` (`archiveGame`) in a format that
**reproduces its end-game summary and analysis exactly** — the record carries the
players (scores, colours, owner flag, persona) and the full `moveLog`, so opening
a game replays the identical standings, tabs, chart and per-player report. Games
are kept as far as storage allows (oldest dropped on overflow), deleted inline,
or the whole archive **cleared from settings** (with a confirm).

- **The archive list.** Each row is a **player-count square** + the game's **date**
  (with a 👑 next to it if the owner won, or a ⊘ if the owner was skipped) on top,
  the **24-hour time** below, then the owner's score and the replay / **export** /
  delete buttons (`renderHistory`). Owner games carry a **percentile tag** (*топ
  15%*) ranking that score against your distribution to date — it **drifts as the
  archive grows**, by design.
- **Export / import** (share local history across devices). Any game exports to a
  JSON file (from its archive row, or the summary when opened from history). The
  **📥 Импортирай игра** flow takes pasted JSON, validates it, asks **which player
  is you** (or none), and files it sorted by timestamp; errors abort with an inline
  notice. So a game tracked on someone else's phone can be merged into your dossier.
- **Owner dossier** (`ownerOverview` / `computeOwnerCareer`, owner-flagged human
  games only, honouring `ownerSkipped`) — a **collapsible** panel showing just your
  name + battles / wins / accuracy until expanded. The ★ token is gone and the name
  falls back to **„Старшина“** when no battle-name is set. Expanded it reduces the
  per-category cube across your games into: win-rate, a rank, personal best, average
  score and luck, generals, **favourite blunder**, **consistency** (score/accuracy
  spread), an **improvement slope** of accuracy over time, the category section as
  the **end-game board grid** (hit % + personal record, tinted red by EV-leak), a
  **career-averages** block mirroring every per-player report stat (luck, decisions,
  изтичане, издънки, късмет под лупа, нули, по етапи — all updating as games accrue),
  and a **career coaching line**. If no analysable owner games exist yet, a goofy
  *„Няма досие на стопанина“* notice explains you need to play as the owner.
- **Replay — Бойна хроника.** Every game has a scrubbable, auto-playing
  turn-by-turn / roll-by-roll viewer (`buildReplayActions` flattens the move log
  into atomic roll/commit actions in true round-robin order). CSS-drawn transport
  controls (play / pause / step / restart), a **speed gear** that clicks through
  x0.5 · x1 · x1.5 · x2 · x4 over a 1 s/move base (x1 white, each other gear its own
  colour), and an **action slider** that jumps to any roll or commit. The board
  fills and the dice that get **re-rolled** light up (matching the select-to-reroll
  flow); a static **Хn/14 · pts** line tracks the turn. A **filter** dropdown left
  of the name replays a single player's turns (Всички / per player).

## Settings & the secret dev editor

Settings (`SETTINGS_ROWS`, persisted to `general:settings:v1`) lead with the
**owner block** (battle name + „Използвай моето име“ with a `?` helper), then
positive toggles: **КАЗАРМА**, **Титли** (with its nested **Бонус точки**
sub-toggle, shown only while Титли is on), **Съвети**, **Цензура**, and
**Акустика** (off by default — reveals every data-over-sound feature, hidden
otherwise). The two pre-game-only rows (Титли, Съвети) hide once a battle is on;
you can also clear the archive here.

- **Censor toggle** — *Цензура, само прилични имена* — is **off by default** (this
  is an adult party game). On, it drops every NSFW-flagged word and regenerates
  from the SFW set only (`setCensor`); names already on the muster screen are
  re-cohered so nothing crude slips through.
- **Secret dev editor.** Each settings row hides a tiny clickable box on its right
  edge. A **rolling tap-sequence matcher** (`devBoxClick` against `devKey()`)
  unlocks **developer mode** when the recent taps hit the escalating key — box 0
  once, box 1 twice, … the 1-2-3-x pattern — so a mistap just means re-tapping. Dev
  mode is a full **editor over every game string**: word pools (titles / adjectives
  / nouns + their AI variants), all roast / shame banks, bets, ranks, combo
  descriptions, HQ orders, rarity exclamations, AI persona names + flavour, and
  playstyle names + descriptions. **Touching an entry opens an edit panel** (so the
  list stays clean) with **Приложи / Отказ**, a **Възстанови** for modified ones,
  and **Премахни**; words also get **м / ср / ж** forms, a percentile-bracket
  selector and an NSFW flag. **↻ Приложи всичко** loads the editable changes live
  for preview (`rebuildFromSource`), and **📋 Копирай промените** exports a compact
  **diff** — only the changes, each with an executable identifier and an action
  marker (`~ nouns[21]: {…}`, `+ roasts.flop: "…"`, `- adjs[4]`) — to hand back for
  baking into the source.

## How to play + menu

A **📖 Правила** briefing (setup and the in-game ☰ menu) explains the turn, and a
**📋 Комбинации** reference sheet lists every category, what it needs and what it
scores, **with an example roll of dice** under each (`buildComboSheet`). **Начало**
returns to the muster screen with the **same roster** (player & AI counts intact)
so the lineup can be tweaked before the next battle.

## End screen

Final ranking plus the stakes (in КАЗАРМА mode): the winner **keeps** their bet
(*X запази Y*) while everyone else **loses** theirs (*Z загуби W*). A tie for
first is settled with a **manual dice roll** (highest wins, re-roll on ties).

## EV engine (`engine.js`)

The optimal-play features sit on one expected-value engine that solves Генерал as
an **acyclic MDP by backward induction** over the bare 14-bit category mask
(16384 states). It **consumes `game.js`'s scoring as the single source of truth** —
it never re-implements the rules.

- `evaluate(scores, dice, rolls_left)` → state value, ranked keeps, ranked
  categories. Pure and deterministic.
- `keepValue(mask, dice, rolls_left, keepBools)` → the EV of a specific hold (used
  by the СЪВЕТ hint); `bestTarget` → the category a hold is aiming at.
- `analyzeGame(turns)` → the luck/skill decomposition over a move log, plus the
  deep metrics (severity, stages, clutch, tilt, bailout, aggression…) and the
  `byCategory` cube (one cell per filled category).
- `analyzeManualGame(turns)` → the category-only variant for manual games (final
  dice + pick per turn; judged against the table at `rolls_left = 0`).
- `marginSplit(a, b, M)` → the `M = ΔLuck + ΔSkill` decomposition between two
  players, parts reconciled to sum exactly to the point margin (luck `null` when
  either side is manual). Backs the headline split and the verdict.
- `botKeep` / `botCategory` → the persona policies: `optimal`, `softmax`,
  `epsilon` (ε-greedy), `greedy` (no lookup) and `random` (blind rethrows).

Within a turn the engine pre-builds the reroll transition table over dice
multisets (`MULTISETS`, `KEEPS`, `keepResult`) and solves the three-throw stage
game (`turnArrays`, `expectRoll`); the across-turn value comes from one pass over
masks ordered by population count (`computeTable`).

The value table is **precomputed offline** and shipped as `ev-table.js` (~115 KB)
so the page needs no heavy compute at load:

```bash
node tools/build-ev.js        # writes ev-table.js, prints par + a validation
node tools/calibrate-bots.js  # prints the τ ↔ strength curve for the personas
```

`par(Генерал) ≈ 195.41`. The build validates the machinery end-to-end: the engine
plays its own optimal policy against **real** random dice over 20k games and the
mean converges to par (a divergence would expose a reroll-table bug). The
well-known ≈254.59 figure is standard Yahtzee's par (upper bonus + joker), a
different game, so it isn't compared here.

## Bulgarian agreement engine (`game.js`)

Names and roasts are generated from word lists, so they must be grammatically
coherent. A small morphology engine handles agreement:

- **Names** are *Title + Adjective + Noun*, and the **adjective agrees with the
  noun's gender** — *Ефрейтор Смотан**а** Пишка* (f), *Майор Смотан Петел* (m),
  *Капитан Стоманен**о** Динамо* (n) — via `inflectAdj`. Indeclinable prefixes
  (*Електро*, *Турбо*) stay put. AIs draw from electric / metallic word lists.
  Noun entries can carry optional **sibling-gender forms** (`gv`) so a gender
  switch morphs the word in place rather than re-rolling; each entry also carries
  an optional `nsfw` flag (censor) and an optional `b` **percentile bracket**.
- **Roasts** agree with the staked combo's gender via possessive forms
  (`possessive`, `renderRoast`) — *Твоят генерал си замина* (m), *Твоята малка
  кента си замина* (f), *Твоето каре* (n).

`inflectAdj`, `possessive`, `renderRoast` and the word/grammar tables are all
pure and unit-tested.

## Scoreboard & scoring

| Category | Bulgarian | Scores |
| --- | --- | --- |
| Ones … Sixes | 1 … 6 | Sum of the dice showing that face (or 0) |
| Two of a kind | 2x | Sum of **two** equal dice (you choose which pair) |
| Three of a kind | 3x | Sum of the **three** equal dice |
| Four of a kind | 4x | Sum of the **four** equal dice |
| Full house | фул хаус | A pair + a triple → **sum of all five dice** |
| Small straight | малка кента | Exactly **1-2-3-4-5** → 15 |
| Large straight | голяма кента | Exactly **2-3-4-5-6** → 20 |
| General | генерал | All five dice equal → **50 + the dice total** |
| Chance | шанс | Sum of all five dice |

Each category is scored exactly once per player. When nothing qualifies you can
**sacrifice** a category by recording it as 0. The point values live in one place
— the `SCORING` object and the `candidates()` function near the top of `game.js` —
so they're easy to tune, and the EV engine reads them rather than hard-coding its
own copy.

## The greedy heuristic (`game.js`)

The no-lookup brain used by the **Комар** (Easy) and **Мушица** (Random) personas,
in pure functions (`aiChooseHolds`, `aiChooseCategory`):

- **Holds** the largest matching group of dice (chasing x-of-a-kind / general);
  with no pair, it keeps the high dice (5s and 6s). (Мушица skips even this and
  rethrows blindly.)
- **Scores** the highest-value open category; if nothing scores, it sacrifices in
  a fixed order (hardest combos first) — never a random forfeit.

It also doubles as the engine-free fallback if the EV table fails to load.

## Tests

All rules, the suggestion engine, the AI, the name generators and the EV engine
live in dependency-free, DOM-free code and are covered by Node's built-in test
runner (no `npm install` needed):

```bash
node --test     # or: npm test
```

The suite (`test/game.test.js`, `test/engine.test.js`, `test/mp.test.js`) covers
every scoring category (including multi-option suggestions and the worked examples
`1 2 2 5 5` and `2 2 4 4 4`), dice rolling, score assignment and forfeit, turn
rotation, game-over, ranking, hit-probabilities, risk detection, the AI's choices,
the Bulgarian agreement engine, the EV engine (table sanity, `evaluate`, luck/skill
bookkeeping, the `byCategory` cube, the `marginSplit` reconciliation and the bot
policies), and the **multiplayer protocol** (framing/CRC, schemas, a full 3-device
game converging to identical state, idempotency and resync).

The game screen (`index.html`) is verified separately with an ad-hoc **jsdom**
smoke test during development — driving the real controller to check the summary
screen, the chart, the history list and the dev editor — but it is not part of the
dependency-free CI suite.

## Deployment

[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) runs the tests and
then deploys the site to **GitHub Pages** on every push to `main`. Pages is
already enabled for this repo, so a push publishes the latest build.

## Project layout

```
index.html   # single-page app: military UI, game loop, summary, history, replay, dev editor
game.js      # pure logic: scoring, heuristic AI, roasts, personas, ranks, rarity, BG engine
engine.js    # EV engine: MDP solver, evaluate(), luck/skill decomposition, bot policies
ev-table.js  # precomputed optimal value table (generated by tools/build-ev.js)
mp.js        # acoustic multiplayer: framing, schemas, host Session, audio FSK modem
tools/       # offline build + calibration scripts
test/        # node:test unit tests (game + engine + multiplayer protocol)
.github/     # CI + Pages deploy workflow
```
