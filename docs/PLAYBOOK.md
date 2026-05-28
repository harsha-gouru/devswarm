# Playbook — orchestrating a real development task

Practical guidance for the decisions that actually matter when you point a swarm at a dev project.

---

## 1. Decompose first, always

The single biggest lever is the **plan**. Parallelism only helps if the subtasks are *independent*.
A good planner prompt forces:

- subtasks that **own disjoint files** (so even without isolation they wouldn't collide),
- explicit `dependsOn` edges when they can't be disjoint,
- subtasks small enough for one agent to finish end-to-end.

If the planner returns 1 giant subtask, you gain nothing from the swarm — tighten the prompt or
split manually. If it returns 30 subtasks that all edit the same file, you'll get merge pain — ask
it to consolidate.

---

## 2. When to parallelize vs sequence

| Situation | Shape |
|---|---|
| Subtasks touch different files, no ordering | `parallel()` / `pipeline()` over all of them |
| Subtask B needs A's output (e.g. B imports a module A creates) | put A first; use the plan's `dependsOn` to order, or run them in sequence |
| Implement → test → review for each subtask | `pipeline()` — each subtask flows independently, no barrier |
| "Merge all results into one summary" | `parallel()` (a barrier) then a single synthesis `agent()` |

Default to `pipeline()`. Reach for the `parallel()` barrier only when the next step genuinely needs
*all* results at once.

---

## 3. Isolation rules

- **Any agent that writes files in parallel MUST isolate.** That's the whole reason worktrees exist
  here. The `implementer` role isolates by default.
- **Read-only agents must not isolate** — it just wastes a checkout. `planner`/`explorer`/`reviewer`
  run in the shared repo (read-only) or are pointed at a specific worktree with `cwd`.
- A `tester`/`reviewer` for a given subtask is pointed at that subtask's worktree via
  `{ cwd: impl.worktree.path }` — it reads the implementer's branch, it doesn't make its own.
- Unchanged worktrees are auto-removed; changed ones stay on `devswarm/<id>` for review/merge.
- **Cleanup:** `git worktree list` in the target repo shows leftovers; `git worktree prune` +
  deleting `devswarm/*` branches clears them. devswarm only auto-removes the *unchanged* ones.

---

## 4. Failure strategy

| `onFailure` | Use when |
|---|---|
| `continue` *(default)* | Subtasks are independent. A failed one becomes `null`, is reported, and the rest finish. You triage the gaps after. |
| `retry` (+`retries`) | Flaky steps (a tester that hit a transient error). Retries the *same* agent before giving up. |
| `abort` | Strict pipelines where a failure makes everything downstream meaningless. Stops the whole task and returns `{ aborted, reason }`. |

`null` propagates — always `.filter(Boolean)` arrays of agent results before using them, and guard
`prev?.impl` in later pipeline stages (an earlier stage may have produced `null`).

Budget/cap breaches are **always** an abort (they raise regardless of `onFailure`) — they're safety
limits, not task failures.

---

## 5. Budgeting a task

`tokenBudget` counts **output tokens** across every agent in the run. Rough sizing:

- small fix / codemod per file: tens of k each → a few hundred k total
- a feature with 3–6 subtasks, each implemented + tested + reviewed: 1–3M
- a large refactor: set it generously and watch the `… output tokens` line

Scale work to the budget inside `run()`:

```js
// only spin up more exploration while there's budget headroom
while (budget.total && budget.remaining() > 200_000 && needMore()) {
  await agent('explorer', '...', { label: 'probe' });
}
```

Without a budget, `budget.remaining()` is `Infinity` — so guard budget loops on `budget.total &&`,
or they'll run into `agentCap`.

---

## 6. Resume

Every run writes `~/.devswarm/runs/<runId>/journal.jsonl`. Re-run with `--resume <runId>`: agents
whose `(role, prompt, opts)` and call-order are unchanged return their recorded result instantly;
the first changed call and everything after it run live.

Caveats:
- Resume **replays recorded results** — it does *not* re-create the worktrees from the first run.
  If a later stage needs to act inside an earlier agent's worktree, either keep that worktree around
  or re-run that branch with `--no-resume`.
- Keep nondeterminism (timestamps, random ids) out of prompts, or pass it via `--args` so keys stay
  stable across runs.

---

## 7. Concurrency sizing

The cap is a counting semaphore. Picking it:

- Each isolated implementer runs a full agent **and** may run a test suite → CPU + memory heavy.
  4–6 is usually the sweet spot on a laptop.
- You'll also hit **API rate limits** before you hit machine limits if you set it to 20.
- Mechanical work (codemod) is lighter → you can push concurrency higher (the bundled codemod uses 6).

---

## 8. Recipe: adapt a workflow

1. Copy `workflows/implement-feature.mjs`.
2. Set the knobs for your task's size (budget, concurrency, onFailure).
3. Rewrite the `planner` prompt for your domain (what "independent subtask" means here).
4. Adjust the test command / review criteria.
5. Dry-run the plan first: comment out the implement stage and just `return plan` to sanity-check
   the decomposition before spending tokens on implementation.
