# Subagent workflow (orchestrator + delegated subtasks)

Goal: keep the **orchestrator's** context window small and cheap by pushing reads, implementation,
and review into **subagents** that each return a *tight summary* — exactly what the orchestrator
needs, not their working transcript. (In a long session, ~97% of token cost is the orchestrator
re-reading its own accumulated context every turn; fan-out keeps that context lean.)

## Roles

| Role | Who | Reads/writes | Returns to orchestrator |
|---|---|---|---|
| **Orchestrator** | the main session (you) | delegates; reviews; integrates | — |
| **explorer** | `.claude/agents/explorer.md` (haiku) | read-only | `file:line` + conclusion (≤~25 lines) |
| **implementer** | `.claude/agents/implementer.md` (inherit) | read-write + runs tests | what changed + verify result + risks |
| **reviewer** | `.claude/agents/reviewer.md` (sonnet) | read-only (diff) | findings only |

## The orchestrator's discipline
1. **Don't read broadly yourself.** Any "where/how/which across files" → spawn **explorer**. You keep
   the conclusion, not the file dumps.
2. **Specify the return contract.** Tell each subagent *exactly* what to hand back ("return the
   file:line of every caller of `beginTurn` and whether each is local/net" — not "look into beginTurn").
   The Agent tool returns only the subagent's final message, so a tight contract = a small context cost.
3. **Delegate scoped changes** to **implementer**; give it the full spec up front (one well-specified
   task beats a back-and-forth). It verifies its own work and reports.
4. **Review risky/large diffs** with **reviewer** (fresh context, independent). Apply fixes via the
   implementer or directly, then re-verify.
5. **You** own commits, sequencing, and cross-cutting decisions. Commit per logical slice.
6. **Parallelize** independent reads/changes — spawn multiple subagents in one turn when they don't
   depend on each other.

## Testing agent — decision
**Bundle test-running into the implementer; do NOT keep a separate "test runner" agent.** An
implementer that doesn't verify its own change is an anti-pattern, and running `node --test` + a
puppeteer smoke is cheap and belongs with whoever made the change (it's the implementer's *definition
of done*). The separately-valuable role is **independent review** (the `reviewer`, with fresh
context) — that catches what self-review misses. A standalone test-executor would just add a hop
without adding judgment. (If a change is verification-heavy — e.g. building the `reduce()` test
suite in Task A — treat "write the tests" as the implementer's task, still bundled.)

## Typical loop
```
explorer  → "where does X live / how does Y work"   (orchestrator keeps the map)
implementer → scoped change + node --test + smoke    (returns summary)
reviewer  → independent diff review (risky changes)  (returns findings)
orchestrator → integrate, fix, commit, next slice
```

## Cost notes
- explorer on **haiku**, reviewer on **sonnet**, implementer **inherits** the orchestrator's model.
  Tune in each agent's frontmatter `model:` if quality/cost needs shift (haiku may miss nuance in the
  global-scope coupling — bump explorer to sonnet for subtle traces).
- Keep orchestrator sessions **task-scoped**; `/clear` between unrelated tasks so the cached prefix
  doesn't grow unbounded.
