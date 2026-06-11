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
  them) and hit **ОГЪН**; selection clears each throw. 3 throws per turn. Thrown
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
  a calibrated difficulty from a fixed ladder: **Мушица** (~20%, harmless),
  **Комар** (~32%, a _комарджия_/gambler — risk-seeking), **Леля ти** (~53%),
  **Кварталния любител** (~75%) and **Господ бог** (100%, optimal). They play weak
  _dice_ but still bank points — no random scratching (calibrated softmax/risk
  policy; see `tools/calibrate-bots.js`).
- **Optimal-play hints.** Toggle **СЪВЕТ** for a live order from HQ — _"Щабът
  нарежда да стреляш по 1, 2, 3. Търсиш малка кента."_ — plus the **top-3 keeps
  with their EVs** (off for serious play).
- **Per-game report (luck vs skill).** Each game is decomposed via the engine's
  value function into `final = par + luck + skill`, with **decision accuracy**,
  **biggest blunder**, **sharpest play**, where you leak most (keeps vs category),
  the генерал result and scratched categories. The end screen has two tabs —
  **Класиране** (standings, points only) and **По умение** (luck-fair, by decision
  quality) — and the report is **selectable per player** (any seat, incl. AI).
  Per-game only (no cross-game storage; it's served statically).
- **Полеви отчет (manual mode).** A second start option runs the board as a
  manual scorekeeper for a real table game — no number pad: **pick a category,
  then tap the dice that made it** (each tap counts; re-pick the combo to reset)
  and hit **Запиши!**. The two straights are fixed (15 / 20). An **ОПА** button in
  the bottom action row undoes action-by-action across the whole game. Roasts, HQ
  orders, rare-name bonuses and the shaming combo penalties (the non-dice ones)
  all still fire; only luck/skill is omitted (dice are unknown).
- **Table setup.** **Drag the grip** (⠿) to reorder seats to match how people sit
  around the real table.
- **Rare names & starting bonuses.** Word pools are re-rolled **on every page
  load** — a slice of titles, adjectives and nouns is dealt a rarity percentile
  (down to sub-1%), so each session has its own rare breeds. Draw (or **type**) a
  rare _Title + Adjective + Noun_ and a brag bubble announces the odds and an HQ
  **starting bonus** (rarer ⇒ bigger). Typing a name checks it live (debounced)
  against the seed — _🎯 Позна!_ — and adopts the name's own gender; landing a
  rare combo still earns the bonus. Switching gender re-rolls the name, so the
  bonus doesn't carry over (nor across a restart — see below). The whole feature
  works in manual mode too.
- **Stupid bets.** Every player is dealt one idiotic wager (_Залага кучето си_,
  _майка си_, _достойнството си_…) and is stuck with it — no take-backs.
- **Gender switch.** Each seat picks **мъжко / то / женско** (m / n / f). It's
  random initially and re-generates a **gender-matching name**; callouts agree too
  — the agreement engine inflects names and roasts (incl. neuter) coherently.
- **How to play + menu.** A **📖 Как се играе** briefing on setup, and an in-game
  **☰ menu** (how-to + restart) explain the turn and every combo's requirement.
  **Restart** deals a fresh game with the **same seats and AI count but brand-new
  names**, so nobody smuggles a rare-name bonus into the next round.
- **Shaming combo tooltips.** Touch a category name in-game and HQ explains the
  combo — then ambushes you with a random **penalty** (the tooltip names it): a
  points fine (sometimes an absurd −9999999), a hidden field, a blanked score, a
  forfeited slot, a shuffled board, a swapped or confiscated die, a "your turn
  is the next guy's", or an outright **ГУБИШ!**. Each penalty runs on its **own
  clock**, reverting after a few seconds with _"Ебавам се, ей ти ги пак."_ You
  can rack up **several at once** — asking for a new hint hides the old tooltip
  but the earlier penalty stands, and the same penalty can stack as long as it
  hits a fresh target. (The how-to deliberately keeps quiet about the fine — the
  ambush is the joke. Dice penalties don't apply in manual mode; everything else
  does.)
- **Settings + a secret dev mode.** A **⚙ settings** panel toggles the rare-name
  bonuses and the in-game advice. Each row hides a tiny clickable box on its right
  edge; tap them **in order with rising counts** (1st row once, 2nd row twice, …)
  to unlock a **developer panel** that lists every title / adjective / noun (and
  the AI pools) with their dealt percentiles, plus all the roast / shame / combo
  message banks — a way to inspect the live seed without reading the source.
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
- `analyzeGame(turns)` → the luck/skill decomposition over a move log.
- `botKeep` / `botCategory` → calibrated softmax (and risk-seeking) bot policies.

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
  stay put. AIs draw from electric / metallic word lists.
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

## AI strategy (base version)

A deliberately simple, greedy bot, all in pure functions in `game.js`
(`aiChooseHolds`, `aiChooseCategory`):

- **Holds** the largest matching group of dice (chasing x-of-a-kind / general);
  with no pair, it keeps the high dice (5s and 6s).
- **Scores** the highest-value open category; if nothing scores, it sacrifices
  in a fixed order (hardest combos first).

It's intentionally beatable and a clean starting point to improve later.

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
