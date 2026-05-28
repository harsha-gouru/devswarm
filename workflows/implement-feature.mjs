// FLAGSHIP: orchestrate a whole feature the way a coding agent handles an assigned task.
//
//   Plan  →  Implement (parallel, isolated)  →  Test  →  Review  →  Integrate
//
// Run against a target repo:
//   devswarm workflows/implement-feature.mjs \
//     --target ~/code/my-app \
//     --args '{"feature":"Add a /health endpoint that returns build SHA and uptime, with a test"}'
//
// Every knob is declared at the top — that's the "how do I define everything" surface.

import { defineTask } from '../src/orchestrate.mjs';
import { PLAN, IMPL_RESULT, TEST_RESULT, REVIEW } from '../src/schemas.mjs';

export default defineTask({
  name: 'implement-feature',
  description: 'Plan a feature, implement subtasks in parallel inside isolated worktrees, test, review, integrate.',

  // ───────────────── management knobs ─────────────────
  concurrency: 4,            // at most 4 implementer agents at once (API rate + machine load)
  tokenBudget: 3_000_000,    // hard ceiling on output tokens for the whole feature
  agentCap: 80,              // lifetime backstop
  isolation: undefined,      // use per-role defaults: only `implementer` isolates (writes code)
  resume: true,              // journal results; --resume replays the unchanged prefix
  onFailure: 'continue',     // a failed subtask becomes null and is reported; the rest proceed
  retries: 1,                // ...but give each failing agent one retry first

  async run({ agent, parallel, pipeline, phase, log, budget, args, mergeBranch }) {
    const feature = args?.feature;
    if (!feature) throw new Error('pass --args \'{"feature":"<what to build>"}\'');

    // 1) PLAN — a read-only planner decomposes the feature into independent subtasks.
    phase('Plan');
    const plan = await agent('planner',
      `Feature request:\n${feature}\n\nExplore the repo, then break this into INDEPENDENT subtasks ` +
      `that touch as few overlapping files as possible. Each subtask should be small enough for one ` +
      `agent to implement end-to-end.`,
      { schema: PLAN, label: 'plan' },
    );
    if (!plan) throw new Error('planning failed');
    log(`plan: ${plan.subtasks.length} subtask(s) — ${plan.subtasks.map((s) => s.id).join(', ')}`);

    // 2) IMPLEMENT → 3) TEST → 4) REVIEW, pipelined per subtask.
    // Each subtask flows through its own implement→test→review chain independently; subtask B
    // can be testing while subtask A is still implementing. Implementers isolate by default.
    phase('Implement → Test → Review');
    const outcomes = await pipeline(
      plan.subtasks,

      // stage 1: implement the subtask in its own worktree
      (st) => agent('implementer',
        `Subtask: ${st.title}\n${st.description}\nFiles you likely own: ${(st.files || []).join(', ')}\n\n` +
        `Implement it in your working directory. Keep the project building.`,
        { schema: IMPL_RESULT, label: `impl:${st.id}` },
      ).then((r) => ({ st, impl: r })),

      // stage 2: run tests inside that worktree
      async (prev) => {
        if (!prev?.impl) return prev; // implementer failed → carry forward as-is
        const wt = prev.impl.worktree;
        const test = await agent('tester',
          `Run the project's test/build commands here and report pass/fail with failing output.`,
          { cwd: wt?.path, schema: TEST_RESULT, label: `test:${prev.st.id}` },
        );
        return { ...prev, test };
      },

      // stage 3: review the diff
      async (prev) => {
        if (!prev?.impl) return prev;
        const wt = prev.impl.worktree;
        const review = await agent('reviewer',
          `Review the change on branch ${wt?.branch} (run \`git diff ${wt?.base}\`). ` +
          `Approve only if it correctly implements: "${prev.st.title}".`,
          { cwd: wt?.path, schema: REVIEW, label: `review:${prev.st.id}` },
        );
        return { ...prev, review };
      },
    );

    // 5) INTEGRATE — report what's green, optionally auto-merge clean branches.
    phase('Integrate');
    const report = outcomes.filter(Boolean).map((o) => ({
      subtask: o.st?.id,
      branch: o.impl?.worktree?.branch ?? null,
      implemented: !!o.impl?.output?.done,
      filesChanged: o.impl?.worktree?.changedFiles ?? [],
      testsPassed: o.test?.passed ?? null,
      reviewApproved: o.review?.approve ?? null,
      blockers: (o.review?.issues ?? []).filter((i) => i.severity === 'blocker'),
    }));

    const greenlit = report.filter((r) => r.branch && r.testsPassed === true && r.reviewApproved === true && r.blockers.length === 0);
    log(`${greenlit.length}/${report.length} subtask(s) green (tests pass + review approved)`);

    let merges = [];
    if (args?.autoMerge) {
      for (const g of greenlit) {
        const m = mergeBranch(g.branch);
        merges.push({ branch: g.branch, ...m });
        log(`merge ${g.branch}: ${m.merged ? 'ok' : 'conflict — left for you'}`);
      }
    }

    return {
      plan: plan.summary,
      report,
      greenlitBranches: greenlit.map((g) => g.branch),
      merges,
      hint: args?.autoMerge ? 'green branches merged where clean' : 'review the branches above, then `git merge devswarm/<id>`',
    };
  },
});
