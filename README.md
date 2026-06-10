# Генерал 🎲

A web player for **Генерал** (General), the Bulgarian dice game in the family of
Yahtzee / Generala. Single-page, no build step, no dependencies — just open
`index.html`.

The UI is a phone-first, comically over-decorated **military parody** (ЩАБ
edition): camouflage field, classification banner, brass medals and stencil type.

## Features

- **Full-screen board.** Fills the viewport with a thin margin: scoreboard up
  top, a **medal divider**, and the **dice console** anchored at the bottom.
- **Select-to-reroll.** Dice default to **kept**. Tap the ones you want to
  re-roll (a ✛ reticle marks them) and hit **ОГЪН**; selection clears after every
  throw. Up to **3 throws** per turn (one automatic roll + two rerolls). Thrown
  dice are always **sorted by face** for easy scanning.
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
- **AI players.** Flip a toggle in setup; the AI marks targets, fires and scores
  on its own.
- **Stupid bets.** Every player is dealt one idiotic wager (_Залага кучето си_,
  _майка си_, _достойнството си_…) and is stuck with it — no take-backs.
- **End screen.** Final ranking plus the stakes: the winner **keeps** their bet
  (_X запази Y_) while everyone else **loses** theirs (_Z загуби W_). A tie for
  first is settled with a **manual dice roll** (highest wins, re-roll on ties).

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
game.js      # pure logic: scoring, AI, probabilities, roasts, BG agreement engine
test/        # node:test unit tests
.github/     # CI + Pages deploy workflow
```
