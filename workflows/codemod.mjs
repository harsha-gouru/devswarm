// Apply the same mechanical change across many files. Discover the sites, transform each in
// its own worktree, verify, integrate. Good for renames, API migrations, lint-rule rollouts.
//
//   devswarm workflows/codemod.mjs --target ~/code/my-app \
//     --args '{"change":"Replace all uses of the deprecated logger.warn(msg) with logger.warning(msg)","glob":"src/**/*.js"}'

import { defineTask } from '../src/orchestrate.mjs';
import { TEST_RESULT } from '../src/schemas.mjs';

const SITES = {
  type: 'object',
  additionalProperties: false,
  required: ['files'],
  properties: { files: { type: 'array', items: { type: 'string' } } },
};

export default defineTask({
  name: 'codemod',
  description: 'Find every site of a mechanical change and transform each file in isolation.',
  concurrency: 6,            // mechanical edits are cheap → more parallelism
  tokenBudget: 2_000_000,
  onFailure: 'continue',
  retries: 0,                // a clean codemod either applies or doesn't; no point retrying

  async run({ agent, parallel, phase, log, args }) {
    const change = args?.change;
    if (!change) throw new Error('pass --args \'{"change":"<the change>","glob":"src/**/*.js"}\'');

    // 1) Discover the sites (read-only).
    phase('Find sites');
    const found = await agent('explorer',
      `Find every file that needs this change applied:\n${change}\n` +
      (args?.glob ? `Limit to files matching: ${args.glob}\n` : '') +
      `Return the list of file paths.`,
      { schema: SITES, label: 'find' },
    );
    const files = found?.files ?? [];
    log(`${files.length} file(s) to transform`);
    if (!files.length) return { changed: [], message: 'no matching sites' };

    // 2) Transform each file in its own worktree, then sanity-check the build.
    phase('Transform (parallel, isolated)');
    const results = await parallel(files.map((file) => () =>
      agent('implementer',
        `Apply EXACTLY this change to \`${file}\` and nothing else:\n${change}`,
        { label: `mod:${file}` },
      ).then(async (impl) => {
        if (!impl?.worktree?.changed) return { file, applied: false };
        const check = await agent('tester',
          `Run a quick build/lint check here and report pass/fail.`,
          { cwd: impl.worktree.path, schema: TEST_RESULT, label: `check:${file}` },
        );
        return { file, branch: impl.worktree.branch, applied: true, buildPasses: check?.passed ?? null };
      }),
    ));

    return { results: results.filter(Boolean) };
  },
});
