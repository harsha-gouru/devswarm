# devswarm

**Assign a development task to a swarm of agents and orchestrate it end-to-end.**

You describe a task (e.g. *"add a `/health` endpoint with a test"*). devswarm runs the same shape
a coding agent uses on an assigned task — **Plan → Implement → Test → Review → Integrate** — but
the implement step fans out across **parallel agents, each in its own isolated git worktree**, so
nothing clobbers anything. Every operational concern is a knob you declare up front: concurrency,
token budget, lifetime cap, isolation, resume, and failure handling.

Each agent is a [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)
`query()` call, so agents get real tools (read/edit/bash/grep) and run their own loop to completion.

```
        ┌──────────┐     ┌──────────────────────────────┐     ┌──────────┐
 task → │  PLANNER │ ──▶ │  IMPLEMENTERS (parallel,      │ ──▶ │ INTEGRATE│ → green branches
        │ (read-   │     │  isolated worktrees)          │     │          │
        │  only)   │     │   ├─ impl ─ test ─ review     │     └──────────┘
        └──────────┘     │   ├─ impl ─ test ─ review     │
                         │   └─ impl ─ test ─ review     │
                         └──────────────────────────────┘
   managed by: concurrency · tokenBudget · agentCap · isolation · resume · onFailure
```

---

## Contents
- [Install & configure](#install--configure)
- [Run it](#run-it)
- [How to define a task](#how-to-define-a-task)  ← **the main thing you asked for**
- [The knobs, explained](#the-knobs-explained)
- [The agents (roles) and their tools](#the-agents-roles-and-their-tools)
- [Inside `run(ctx)`](#inside-runctx)
- [The orchestration flow](#the-orchestration-flow)
- [Bundled workflows](#bundled-workflows)
- [CLI](#cli)
- [How it maps to a coding agent's task handling](#how-it-maps-to-a-coding-agents-task-handling)

---

## Install & configure

```bash
cd ~/Developer/devswarm
npm install                 # pulls @anthropic-ai/claude-agent-sdk + ajv
cp .env.example .env        # add ANTHROPIC_API_KEY
```

Requires **Node ≥ 20**, **git** (worktree isolation), and an `ANTHROPIC_API_KEY`.
The agents operate on a **target repo** you point at with `--target` (it should be a git repo).

---

## Run it

```bash
# Implement a feature end-to-end against another repo:
node bin/devswarm.mjs workflows/implement-feature.mjs \
  --target ~/code/my-app \
  --args '{"feature":"Add a /health endpoint returning build SHA + uptime, with a test"}'

# Fix a failing test suite in parallel:
node bin/devswarm.mjs workflows/fix-failing-tests.mjs \
  --target ~/code/my-app --args '{"testCommand":"npm test"}'
```

Install globally for a `devswarm` command: `npm link`.

Each implementer leaves its work on a branch `devswarm/<subtask>` in your target repo — devswarm
never commits to your working branch unless you pass `--args '{"autoMerge":true}'` (and even then,
only branches that pass tests **and** review are merged).

---

## How to define a task

A workflow is a file that `export default defineTask({...})`. The object is split in two: the
**knobs** (how it's managed) and **`run(ctx)`** (the orchestration logic). This is the whole
"how do I define everything" surface:

```js
import { defineTask } from '../src/orchestrate.mjs';
import { PLAN, IMPL_RESULT, TEST_RESULT, REVIEW } from '../src/schemas.mjs';

export default defineTask({
  name: 'implement-feature',
  description: 'Plan, implement in parallel (isolated), test, review, integrate.',

  // ── knobs: declare how the task is managed ──
  concurrency: 4,          // max agents running at once
  tokenBudget: 3_000_000,  // hard output-token ceiling for the whole task (null = unlimited)
  agentCap: 80,            // lifetime backstop against runaway loops
  isolation: undefined,    // per-role default (only `implementer` isolates); or force 'worktree' / false
  resume: true,            // journal results so a re-run skips completed steps
  onFailure: 'continue',   // 'continue' | 'retry' | 'abort'
  retries: 1,              // retries when onFailure === 'retry'

  // ── run: the orchestration logic ──
  async run({ agent, parallel, pipeline, phase, log, budget, args, mergeBranch }) {
    phase('Plan');
    const plan = await agent('planner', `Break this into subtasks:\n${args.feature}`, { schema: PLAN });

    phase('Implement → Test → Review');
    const outcomes = await pipeline(plan.subtasks,
      (st)   => agent('implementer', st.description, { schema: IMPL_RESULT, label: st.id }).then(impl => ({ st, impl })),
      (prev) => agent('tester',  `run tests here`, { cwd: prev.impl.worktree.path, schema: TEST_RESULT }).then(test => ({ ...prev, test })),
      (prev) => agent('reviewer', `review the diff`, { cwd: prev.impl.worktree.path, schema: REVIEW }).then(review => ({ ...prev, review })),
    );

    phase('Integrate');
    return outcomes.filter(Boolean).map(o => ({ branch: o.impl.worktree.branch, passed: o.test?.passed, approved: o.review?.approve }));
  },
});
```

CLI flags override any knob at run time (`--budget`, `--concurrency`, `--on-failure`, `--no-resume`).

---

## The knobs, explained

| Knob | What it controls | When working a dev project |
|---|---|---|
| **`concurrency`** | Max agents running simultaneously (a counting semaphore). A `parallel()` over 20 subtasks still completes — only N run at once, the rest queue. | Keep it ~3–6. Too high → API rate limits + your machine running N test suites at once. |
| **`tokenBudget`** | Hard output-token ceiling for the *entire task*. Once spent, the next `agent()` aborts the task cleanly. `budget.remaining()` lets `run()` scale itself. | Cap what a feature is allowed to cost. A big refactor: a few million; a small fix: a few hundred k. |
| **`agentCap`** | Lifetime cap on total agents spawned. Backstop for loops that never converge. | Leave at the default unless you have a loop-until-done stage. |
| **`isolation`** | Whether agents get their own git worktree. Default: per-role (only `implementer` isolates). Override per `agent()` call. | **Always isolate parallel writers** — it's the thing that makes concurrent edits safe. Read-only agents (plan/review) don't need it. |
| **`resume`** | Journals every `agent()` result. Re-running replays the unchanged prefix from cache and only re-runs what changed. | A 30-minute feature build that dies at the review step shouldn't redo planning + implementation. |
| **`onFailure`** | What happens when an agent errors: `continue` (→ `null`, reported, rest proceed), `retry` (up to `retries`), `abort` (stop the whole task). | `continue` for independent subtasks (one bad subtask shouldn't sink the others); `abort` for a strict pipeline. |

---

## The agents (roles) and their tools

Different workers get different powers — defined in `src/roles.mjs`. This is **what tools each
agent gets**:

| Role | Permission | Tools | Isolates? | Purpose |
|---|---|---|---|---|
| `planner` | read-only (`plan`) | Read, Grep, Glob, Bash | no | decompose the task into independent subtasks |
| `explorer` | read-only (`plan`) | Read, Grep, Glob, Bash | no | investigate the codebase, report |
| `implementer` | act (`bypassPermissions`) | Read, **Write, Edit**, Bash, Grep, Glob | **yes** | implement one subtask in its own worktree |
| `tester` | act | Read, Bash, Grep, Glob | no | run tests/build, report pass/fail |
| `reviewer` | read-only (`plan`) | Read, Grep, Glob, Bash | no | review a diff for correctness/risk |

The key safety property: **only `implementer` can write, and it only ever writes inside its own
isolated worktree.** Add your own role by dropping an object into `ROLES`, or pass an inline role
object to `agent()`.

---

## Inside `run(ctx)`

`ctx` gives you:

| | |
|---|---|
| `agent(role, prompt, opts?)` | Run one agent. Returns its text, or a validated object if `opts.schema` is set, or `{ output, worktree }` if the agent isolated (so you can test/review/merge its branch). `null` on failure. |
| `parallel(thunks)` | Run `() => Promise` thunks concurrently (barrier — waits for all). Errored thunks → `null`. |
| `pipeline(items, s1, s2, …)` | Each item flows through all stages independently — subtask B can be testing while A is still implementing. |
| `phase(title)` / `log(msg)` | Progress grouping + narration. |
| `budget` | `{ total, spent(), remaining() }`. |
| `args` | Your `--args` JSON. |
| `mergeBranch(branch)` | Merge a clean agent branch into the target's current branch. |
| `worktrees` | Worktrees created so far. |

`agent()` options: `{ schema, model, maxTurns, isolation, cwd, label, phase }`.

> **Mental model:** an agent is a pure function — task in, result out, no shared memory. Agents
> coordinate *only* through values your `run()` threads between them (and through branches on disk).
> Get `run()` right and there are no race conditions.

---

## The orchestration flow

1. **Plan** — a read-only `planner` explores and returns a structured list of independent subtasks
   (which files each owns), so the parallel step has minimal file overlap.
2. **Implement** — one `implementer` per subtask, each in its **own worktree** on branch
   `devswarm/<id>`, capped by `concurrency`. They can't see or clobber each other.
3. **Test** — a `tester` runs the suite *inside each worktree*; failures are captured, not fatal.
4. **Review** — a `reviewer` inspects each diff and approves or flags blockers.
5. **Integrate** — devswarm reports which branches are green (tests pass + review approved + no
   blockers). With `--args '{"autoMerge":true}'` it merges the clean ones; otherwise you merge by hand.

Steps 2–4 run as a **pipeline per subtask**, so each subtask progresses independently.

---

## Bundled workflows

| File | Does |
|---|---|
| `workflows/implement-feature.mjs` | the full Plan→Implement→Test→Review→Integrate flow above |
| `workflows/fix-failing-tests.mjs` | triage the suite → one isolated fixer per failing test → re-verify |
| `workflows/codemod.mjs` | find every site of a mechanical change → transform each file in isolation → build-check |

Copy one and edit the knobs + `run()` for your own task.

---

## CLI

```
devswarm <workflow.mjs> [options]

  --target <dir>       repo the agents operate on (default: current dir)
  --args <json|@file>  input exposed to the task as `args`
  --budget <amount>    override tokenBudget: "+3m", "500k", or a number
  --concurrency <n>    override max concurrent agents
  --on-failure <mode>  continue | retry | abort
  --resume <runId>     resume from a previous run's journal
  --no-resume          disable the resume journal
  --json               print only the final result as JSON
```

Progress → stderr; final result → stdout.

---

## How it maps to a coding agent's task handling

When you hand a coding agent a dev task it doesn't fire one giant prompt — it **explores, plans,
splits the work, does the pieces (isolating parallel edits), tests, reviews, and integrates**, all
under resource limits. devswarm makes that loop explicit and re-runnable:

- *Decompose before doing* → the `planner` stage.
- *Parallel workers that don't collide* → `pipeline`/`parallel` + per-agent **worktree isolation**.
- *Bounded autonomy* → `tokenBudget` + `agentCap` + read-only roles for non-writers.
- *Don't redo finished work* → the resume **journal**.
- *One bad worker doesn't sink the run* → `onFailure` policy + `null`-on-error.

See **[docs/PLAYBOOK.md](docs/PLAYBOOK.md)** for when to parallelize, isolation rules, failure/retry
strategy, and how to budget a real task.

## License

MIT
