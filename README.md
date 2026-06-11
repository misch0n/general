# Генерал 🎲

A web player for **Генерал** (General), the Bulgarian dice game in the family of
Yahtzee / Generala. Single-page, no build step, no dependencies — just open
`index.html`.

The UI is a phone-first, comically over-decorated **military parody** (ЩАБ
edition): camouflage field, classification banner, brass medals and stencil type.

## Features

- **Full-screen board.** Fills the viewport with a thin margin: scoreboard up
  top, a **medal divider**, and the **dice console** anchored at the bottom.
- **Select-to-reroll.** The turn opens on the general's order with the dice
  **unrolled** (`?`); **tap the dice to make your first throw** (anticipation).
  Then dice default to **kept** — tap the ones to re-roll (a ✛ reticle marks
  them) and hit **ОГИН!**; selection clears each throw. 3 throws per turn. Thrown
  dice are always **sorted by face**.
- **Suggestions live inside the scoreboard.** After each throw every open
  category shows the points the dice would score as a tappable brass chip; combos
  fillable several ways (e.g. two pairs for `2x`) show **one chip per option**. A
  small **×** forfeits a slot. The single best move is flagged with a ★.
- **Marching orders.** Each turn opens with a brass comic **speech bubble** —
  _🎖 Майор, генералът ти заповядва да хвърлиш каре!_ — naming one of your still
  open categories to aim for (flavour only). Shows for ~4s.
- **Roasts.** End a turn in disappointment — re-roll the whole hand, or commit
  next to nothing — and a brutal comic-book **speech bubble** pops up for a
  couple of seconds (_Майка ти съжалява, че те е родила…_). The criterion lives
  in `isDisappointing()`.
- **Any number of players** with custom names, colours and AI toggles; a
  separate scoreboard each, with the current player's shown and the rest
  reachable from the player pills (tap to peek).
- **AI players & personas.** AI seats keep a generated metallic name (_Сержант
  Нано Динамо_) and show their persona under it; the **persona is the playstyle** —
  a five-tier ladder of genuinely different decision procedures (calibrated in
  `tools/calibrate-bots.js`):
  | Persona | Tier | Policy | Strength |
  | --- | --- | --- | --- |
  | Мушица | Random | 1–2 blind rethrows of the whole hand, then the best immediate placement | ~25% |
  | Комар | Easy | no table lookup — pure immediate-gain heuristics | ~64% |
  | Леля ти | Medium | ε-greedy (ε = 0.2) over the optimal table | ~77% |
  | Кварталния любител | Hard | softmax (τ = 0.8) over the optimal table | ~85% |
  | Господ бог | God | always the optimal move | 100% |

  None of them ever scratches at random — a forfeit happens only when nothing
  scores (Господ бог alone may scratch _strategically_).
- **Optimal-play hints.** Toggle **СЪВЕТ** for a live order from HQ — _"Щабът
  нарежда да стреляш по 1, 2, 3. Търсиш малка кента."_ — plus the **top-3 keeps
  with their EVs** (off for serious play).
- **Per-game report (luck vs skill).** Each game is decomposed via the engine's
  value function into `final = par + luck + skill`, then dissected: **decision
  accuracy** and avg EV loss/turn, **hold vs category** leak (with mistake
  counts), **blunder categorisation** (minor / major / fatal), **outstanding
  moves**, a **deep luck deconstruction** (net dice variance split first throw vs
  rerolls, plus the **clutch factor** — late-game luck), **zero-out avoidance**
  (mathematically forced vs self-inflicted), a **tilt metric** (does your EV loss
  spike after a terrible roll?), a **bailout rating** (how well you pivot when
  the opening throw breaks the plan), **upper-section efficiency** (vs the
  three-of-each yardstick), **early/mid/late section ratings**, and a colour-coded
  **playstyle fingerprint** (Хирургът, Комарджията, Чиновникът, Късметлията…).
  A collapsed **Ход по ход** panel expands into the turn-by-turn breakdown. The
  end screen has two tabs — **Класиране** (standings, points only) and **По
  умение** (luck-fair, by decision quality) — and the report is **selectable per
  player** (any seat, incl. AI). Per-game only (no cross-game storage).
- **Полеви отчет (manual mode).** A second start option runs the board as a
  manual scorekeeper for a real table game: **tap in all five table dice** on the
  six entry dice at the bottom, and the scoreboard lights up with **every fillable
  category** exactly like in regular play — pick one (or scratch with ×). Entering
  the full hand means you can't mentally miss a combo, and it feeds the
  analytics: manual games get the same report **adapted to what's knowable** —
  category-decision accuracy, blunders, zero-outs, stage ratings, the turn
  breakdown — while the luck/keep metrics are omitted (the real rolls/rerolls
  were never seen). An **ОПА** button undoes action-by-action (dice taps and
  commits) across the whole game. Roasts, HQ orders, rare-name bonuses and the
  non-dice penalties all still fire.
- **Table setup.** **Drag the grip** (⠿) to reorder seats to match how people sit
  around the real table.
- **Rare names & starting bonuses.** Every name component (title / adjective /
  noun) sits in a **hardcoded percentile bracket** — `0-1`, `1-2`, `2-3`, `3-4`,
  `4-5`, `5-10` or `10+` (common) — so rarities are **consistent across loads**
  (the only randomness is the draw). A component is drawn with a probability set
  by its bracket; the **name's percentage is the product** of its three
  components' fractions, so _common title × rare adjective × rare noun_ multiplies
  into something genuinely scarce. Titles span **every Bulgarian age** (modern
  ranks, imperial dignities — _Хан, Боляр, Кавхан_ — and revival-era resistance —
  _Войвода, Хайдутин, Комита, Опълченец_). Draw (or **type**) a rare _Title +
  Adjective + Noun_ and a brag bubble exclaims the odds tier-style — _ГОСПОДИ!
  0.1% шанс…_, _Ебаси, 1.5%…_, _ЕХЕ! 4.5%…_ — plus an HQ **starting bonus** by the
  name's bracket (`0-1`→5 … `4-5`→1, `5-10`→just a 🙂, no points), **colour-coded**:
  0-1 purple, 1-2 gold, 2-3 orange, 3-4 yellow, 4-5 green, 5-10 blue. Typing a name
  checks it live (debounced) against the seed — _🎯 Позна!_ — and adopts the
  name's own gender; landing a rare combo still earns the bonus. Works in manual
  mode too. (Initial brackets are arbitrary — tune them in the dev editor.)
- **Stupid bets.** Every player is dealt one idiotic wager (_Залага кучето си_,
  _майка си_, _достойнството си_…) and is stuck with it — no take-backs.
- **Gender switch.** Each seat picks **мъжко / то / женско** (m / n / f), random
  initially. Switching gender **keeps the same name and its rarity** — it only
  re-coheres grammatically: the adjective re-agrees and the noun **morphs in
  place** when it carries a sibling-gender form (_Маймун → Маймуна → Маймунче_),
  otherwise it's swapped for a same-rarity sibling. Callouts and roasts agree too
  (incl. neuter), via the agreement engine.
- **How to play + menu.** A **📖 Как се играе** briefing on setup, and a
  pronounced in-game **☰ menu** (how-to · settings · restart) explain the turn and
  every combo's requirement. **Restart** returns to the muster screen with the
  **same roster** (player & AI counts intact) so the lineup can be tweaked before
  the next battle.
- **Shaming combo tooltips.** Touch a category name in-game and HQ explains the
  combo — the tooltip pops **right next to it** and then ambushes you with a
  random **penalty** (the tooltip names it): a points fine (sometimes an absurd
  −9999999), a hidden field, a blanked score, a forfeited slot, a shuffled board,
  a swapped or confiscated die, a "your turn is the next guy's", or an outright
  **ГУБИШ!**. Each penalty runs on its **own clock**, reverting after a few
  seconds with _"Ебавам се, ей ти ги пак."_ floated **next to whatever the
  penalty hit** (the tile, the dice, the score). You can rack up **several at
  once** — a new hint replaces the tooltip but earlier penalties stand, and the
  same penalty stacks as long as it claims a fresh target. **Every bubble in the
  game can be tapped away** — tooltips, refunds, roasts and orders alike. (The
  how-to deliberately keeps quiet about the fine — the ambush is the joke. Dice
  penalties don't apply in manual mode; everything else does.)
- **Censor toggle.** A **⚙ settings** switch — _Цензура, само прилични имена_ —
  is **off by default** (this is an adult party game). Flip it **on** to drop all
  NSFW-flagged words and generate from the SFW set only; names already on the
  muster screen are re-cohered so nothing crude slips through.
- **Settings + a secret dev word-editor.** Settings also toggle the rare-name
  bonuses and the in-game advice. Each row hides a tiny clickable box on its right
  edge; tap them **in order with rising counts** (1st row once, 2nd row twice, …)
  to unlock a **developer mode** — a full **word-list editor**. Every title /
  adjective / noun (and the AI pools) is editable across its **м / ср / ж** forms,
  with a **percentile-bracket selector** (colour-cued) and an **NSFW** flag; rows
  are **ranked by rarity** for quick scanning. You can **add** entries, hit
  **↻ Приложи** to re-roll the live pools and preview, and **📋 КОПИРАЙ** to export
  the whole edited set as JSON (brackets included; unchanged entries verbatim) to
  hand back for baking into the source. The roast / shame / combo message banks
  are shown read-only.
- **End screen.** Final ranking plus the stakes: the winner **keeps** their bet
  (_X запази Y_) while everyone else **loses** theirs (_Z загуби W_). A tie for
  first is settled with a **manual dice roll** (highest wins, re-roll on ties).

## EV engine (`engine.js`)

The optimal-play features sit on one expected-value engine that solves Генерал as
an acyclic MDP by backward induction over the bare 14-bit category mask (16384
states). It **consumes `game.js`'s scoring as the single source of truth** — it
never re-implements the rules.

- `evaluate(scores, dice, rolls_left)` → state value, ranked keeps, ranked
  categories. Pure and deterministic.
- `analyzeGame(turns)` → the luck/skill decomposition over a move log, plus the
  deep metrics (severity, stages, clutch, tilt, bailout, aggression…).
- `analyzeManualGame(turns)` → the category-only variant for manual games
  (final dice + pick per turn; judged against the table at `rolls_left = 0`).
- `botKeep` / `botCategory` → the persona policies: `optimal`, `softmax`,
  `epsilon` (ε-greedy), `greedy` (no lookup) and `random` (blind rethrows).

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

## Bulgarian agreement engine

Names and roasts are generated from word lists, so they must be grammatically
coherent. A small morphology engine in [`game.js`](game.js) handles agreement:

- **Names** are _Title + Adjective + Noun_, and the **adjective agrees with the
  noun's gender** — _Ефрейтор Смотан**а** Пишка_ (f), _Майор Смотан Петел_ (m),
  _Капитан Стоманен**о** Динамо_ (n). Indeclinable prefixes (_Електро_, _Турбо_)
  stay put. AIs draw from electric / metallic word lists. Noun entries can carry
  optional **sibling-gender forms** (`gv`) so a gender switch morphs the word in
  place rather than re-rolling; each entry also carries an optional `nsfw` flag
  (censor toggle) and an optional `b` **percentile bracket** (hardcoded rarity).
- **Roasts** agree with the staked combo's gender via possessive forms — _Твоят
  генерал си замина_ (m), _Твоята малка кента си замина_ (f), _Твоето каре_ (n).

`inflectAdj`, `possessive`, `renderRoast` and the word/grammar tables are all
pure and unit-tested.

## Scoreboard & scoring

| Category        | Bulgarian      | Scores |
| --------------- | -------------- | ------ |
| Ones … Sixes    | 1 … 6          | Sum of the dice showing that face (or 0) |
| Two of a kind   | 2x             | Sum of **two** equal dice (you choose which pair) |
| Three of a kind | 3x             | Sum of the **three** equal dice |
| Four of a kind  | 4x             | Sum of the **four** equal dice |
| Full house      | фул хаус       | A pair + a triple → **sum of all five dice** |
| Small straight  | малка кента    | Exactly **1-2-3-4-5** → 15 |
| Large straight  | голяма кента   | Exactly **2-3-4-5-6** → 20 |
| General         | генерал        | All five dice equal → **50 + the dice total** |
| Chance          | шанс           | Sum of all five dice |

Each category is scored exactly once per player. When nothing qualifies you can
**sacrifice** a category by recording it as 0.

The point values live in one place — the `SCORING` object and the `candidates()`
function near the top of [`game.js`](game.js) — so they're easy to tune later.

## The greedy heuristic (`game.js`)

The no-lookup brain used by the **Комар** (Easy) and **Мушица** (Random)
personas, in pure functions (`aiChooseHolds`, `aiChooseCategory`):

- **Holds** the largest matching group of dice (chasing x-of-a-kind / general);
  with no pair, it keeps the high dice (5s and 6s). (Мушица skips even this and
  rethrows blindly.)
- **Scores** the highest-value open category; if nothing scores, it sacrifices
  in a fixed order (hardest combos first) — never a random forfeit.

It also doubles as the engine-free fallback if the EV table fails to load.

## Running locally

It's a static page — open `index.html`, or serve the folder:

```bash
python3 -m http.server 8000   # then visit http://localhost:8000
```

## Tests

All rules, the suggestion engine, the AI and the name generators live in
dependency-free, DOM-free code in [`game.js`](game.js) and are covered by Node's
built-in test runner (no `npm install` needed):

```bash
node --test     # or: npm test
```

The suite covers every scoring category (including multi-option suggestions and
the worked examples `1 2 2 5 5` and `2 2 4 4 4`), dice rolling, score assignment
and forfeit, turn rotation, game-over, ranking, hit-probabilities, risk
detection, the AI's choices, and the Bulgarian agreement engine (adjective /
possessive agreement, name coherence, roast rendering).

The game screen itself (`index.html`) is verified separately with an ad-hoc
jsdom smoke test during development; it is not part of the dependency-free CI
suite.

## Deployment

[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) runs the tests and
then deploys the site to **GitHub Pages** on every push to `main`. Pages is
already enabled for this repo, so a push publishes the latest build.

## Project layout

```
index.html   # single-page app: military UI + controller
game.js      # pure logic: scoring, heuristic AI, roasts, personas, ranks, BG engine
engine.js    # EV engine: solver, evaluate(), luck/skill, calibrated bot policies
ev-table.js  # precomputed optimal value table (generated by tools/build-ev.js)
tools/       # offline build + calibration scripts
test/        # node:test unit tests (game + engine)
.github/     # CI + Pages deploy workflow
```
