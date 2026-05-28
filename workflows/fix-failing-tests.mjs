// Fix a suite of failing tests in parallel. One agent per failing test, each isolated, then
// re-tested. Shows: discover work-list first (inline), then fan out one isolated fixer per item.
//
//   devswarm workflows/fix-failing-tests.mjs --target ~/code/my-app \
//     --args '{"testCommand":"npm test"}'

import { defineTask } from '../src/orchestrate.mjs';
import { TEST_RESULT } from '../src/schemas.mjs';

const FAILURES = {
  type: 'object',
  additionalProperties: false,
  required: ['failures'],
  properties: {
    failures: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'description'],
        properties: {
          id: { type: 'string', description: 'short slug for the failing test' },
          description: { type: 'string', description: 'test name + why it fails' },
          file: { type: 'string' },
        },
      },
    },
  },
};

export default defineTask({
  name: 'fix-failing-tests',
  description: 'Run the suite, then fix each failing test in parallel inside isolated worktrees.',
  concurrency: 3,
  tokenBudget: 2_000_000,
  onFailure: 'continue',
  retries: 1,

  async run({ agent, parallel, phase, log, args }) {
    const testCommand = args?.testCommand || 'npm test';

    // 1) Discover the work-list: a tester triages the failures into discrete items.
    phase('Triage');
    const triage = await agent('tester',
      `Run \`${testCommand}\`. List each FAILING test as a discrete item with a slug id, a one-line ` +
      `description of why it fails, and the file it lives in.`,
      { schema: FAILURES, label: 'triage' },
    );
    const failures = triage?.failures ?? [];
    log(`${failures.length} failing test(s): ${failures.map((f) => f.id).join(', ') || '(none)'}`);
    if (!failures.length) return { fixed: [], message: 'no failing tests 🎉' };

    // 2) Fix each failure in its own worktree, then re-run the suite there to confirm.
    phase('Fix (parallel, isolated)');
    const results = await parallel(failures.map((f) => () =>
      agent('implementer',
        `A test is failing:\n${f.description}\nFile: ${f.file || '(find it)'}\n\n` +
        `Fix the underlying cause (prefer fixing the code over weakening the test). Keep the change minimal.`,
        { label: `fix:${f.id}` },
      ).then(async (impl) => {
        if (!impl?.worktree) return { id: f.id, fixed: false, reason: 'fixer produced no changes' };
        const verify = await agent('tester',
          `Run \`${testCommand}\` here and report whether it now passes.`,
          { cwd: impl.worktree.path, schema: TEST_RESULT, label: `verify:${f.id}` },
        );
        return { id: f.id, branch: impl.worktree.branch, fixed: verify?.passed === true, files: impl.worktree.changedFiles };
      }),
    ));

    const fixed = results.filter(Boolean).filter((r) => r.fixed);
    log(`${fixed.length}/${failures.length} fixed and verified`);
    return { results: results.filter(Boolean), fixedBranches: fixed.map((r) => r.branch) };
  },
});
