# Генерал 🎲

A web player for **Генерал** (General), the Bulgarian dice game in the family of
Yahtzee / Generala. Single-page, no build step, no dependencies — just open
`index.html`.

This is the base version; it will be expanded later.

## Features

- **Any number of players**, with customizable **names** and **colours**.
- 5 dice, up to **3 rolls** per turn:
  - 1st roll throws all dice;
  - 2nd / 3rd roll re-throws all dice or any subset you choose (click a die to
    hold it).
- A **separate scoreboard per player**. The board on screen is always the
  current player's; turns rotate automatically after a category is scored.
- **Peek** at any other player's board from the sidebar — it stays off to the
  side and read-only, so you can glance without disturbing your turn.
- Live score **previews**: after rolling, each open category shows what it would
  score if you picked it.
- End-of-game ranking screen.

## Scoreboard & scoring

The categories, in board order:

| Category        | Bulgarian      | Scores |
| --------------- | -------------- | ------ |
| Ones            | 1              | Sum of dice showing **1** |
| Twos            | 2              | Sum of dice showing **2** |
| Threes          | 3              | Sum of dice showing **3** |
| Fours           | 4              | Sum of dice showing **4** |
| Fives           | 5              | Sum of dice showing **5** |
| Sixes           | 6              | Sum of dice showing **6** |
| Two of a kind   | 2x             | Sum of **all** dice, if ≥2 of a kind (else 0) |
| Three of a kind | 3x             | Sum of **all** dice, if ≥3 of a kind (else 0) |
| Four of a kind  | 4x             | Sum of **all** dice, if ≥4 of a kind (else 0) |
| Full house      | фул хаус       | **25**, for a triple + a pair |
| Small straight  | малка кента    | **30**, for four in a row (1-2-3-4, 2-3-4-5 or 3-4-5-6) |
| Large straight  | голяма кента   | **40**, for five in a row (1-2-3-4-5 or 2-3-4-5-6) |
| General         | генерал        | **50**, for all five dice equal |
| Chance          | шанс           | Sum of all dice |

Each category is scored exactly once per player. You may "sacrifice" a category
by scoring it as 0 when nothing else fits.

### Rules I had to decide (please confirm / correct)

A few details weren't fully specified, so I picked sensible defaults. They all
live in one place — the `SCORING` object and the `SCORERS` map near the top of
[`game.js`](game.js) — so they're easy to change:

- **`генерал` = five of a kind.** You described it as "6 same sides", but the
  game uses 5 dice, so I implemented it as **all 5 dice equal** (a Yahtzee).
  If генерал should mean something else, this is the thing to revisit.
- **`2x` / `3x` / `4x` score the sum of all five dice** (not just the matching
  dice). Switch the `twoKind`/`threeKind`/`fourKind` scorers if you'd rather
  sum only the matching dice.
- **`малка/голяма кента`** are interpreted Yahtzee-style: small = any **four**
  consecutive dice, large = all **five** consecutive.
- **Fixed point values** (full house 25, small straight 30, large straight 40,
  general 50) — tune them in `SCORING`.
- **No upper-section bonus** is included (the scoreboard you gave didn't list
  one). Easy to add later if Генерал uses one.

## Running locally

It's a static page — just open `index.html` in a browser. Or serve the folder:

```bash
python3 -m http.server 8000   # then visit http://localhost:8000
```

## Tests

All game rules and workflows live in dependency-free, DOM-free code in
[`game.js`](game.js) and are covered by the test suite using Node's built-in
test runner (no `npm install` needed):

```bash
node --test
# or
npm test
```

The suite covers every scoring category (hits and misses), dice rolling /
holding, score assignment, turn rotation, game-over detection, ranking, and a
full play-through.

## Deployment

[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) runs the tests
and then deploys the site to **GitHub Pages** on every push to `main`.

To turn it on: repo **Settings → Pages → Build and deployment → Source:
GitHub Actions**. The next push to `main` will publish the page.

## Project layout

```
index.html   # the single-page app (UI + controller)
game.js      # pure game logic, shared by the page and the tests
test/        # node:test unit tests
.github/     # CI + Pages deploy workflow
```
