# Генерал 🎲

A web player for **Генерал** (General), the Bulgarian dice game in the family of
Yahtzee / Generala. Single-page, no build step, no dependencies — just open
`index.html`.

This is the base version; it will be expanded later.

## Features

- **Dice front and centre.** Five large, tactile dice are the focus of the
  screen. Players roll manually, then click dice to **hold** them and re-roll
  the rest — up to **3 rolls** per turn.
- **A suggestion panel under the dice** (never covering them). After each roll
  it lists every scoring entry the dice make — respecting categories you've
  already used — as a tap-to-score button. Combos that can be filled several
  ways (e.g. two different pairs for `2x`) show **one button per option**.
- **Hit-chance on tap.** Tap any category name on the scoreboard to reveal its
  live probability of hitting — computed from the current dice and rolls left,
  updating as you roll. Subtle and on-demand, never in the way.
- **Roasts.** Gamble a made combo away (rerolling a full house, straight, four
  of a kind…) and the game taunts you with rotating brutal messages — a lighter
  jab when you take the risk, and the harshest ones when it backfires.
- **Forfeit.** A "Откажи се" button opens a selector to write **0** into any
  unfilled category (a deliberate sacrifice to save a better one). When the dice
  make no combinations at all, forfeiting is mandatory.
- **Full scoreboard on scroll.** Below the dice the complete board shows every
  category with its score/suggestion next to it and a running **total**
  underneath — score or forfeit from here too.
- **Turn-switch animation.** Picking or forfeiting ends the turn; after a brief
  pause an animated card announces the next player and play continues.
- **Any number of players**, each set up on its own card — name on its own line,
  with colour and AI toggle below — plus a separate, rotating scoreboard.
- **AI players.** Flip the toggle next to any player before the game to make
  them computer-controlled; the AI rolls, holds and scores on its own.
- **English UI**, with themed names: Title + Noun — humans get silly military
  names (_General Willy_, _Major Rooster_); AIs get electric / metallic ones
  (_General Camel_, _Major TinCan_). All editable.
- **Stupid bets.** Every player wagers something idiotic (_Bets his dog_,
  _his mother_, _his dignity_…), re-rollable in setup.
- **Peek** at any player's board from the sidebar — read-only, off to the side.
- **End screen.** Final ranking plus the stakes: the winner **keeps** their bet
  (_X запази Y_) while everyone else **loses** theirs (_Z загуби W_). A tie for
  first is settled with a **manual dice roll** (highest wins, re-roll on ties).

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
the worked examples `1 2 2 5 5` and `2 2 4 4 4`), dice rolling / holding, score
assignment and sacrifice, turn rotation, game-over, ranking, the AI's hold and
category choices, and the name generators.

## Deployment

[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) runs the tests and
then deploys the site to **GitHub Pages** on every push to `main`. Pages is
already enabled for this repo, so a push publishes the latest build.

## Project layout

```
index.html   # single-page app (UI + controller)
game.js      # pure game logic, suggestion engine, AI, name generators
test/        # node:test unit tests
.github/     # CI + Pages deploy workflow
```
