// Role presets — what each kind of agent is ALLOWED to do.
//
// This is the heart of "what tools each agent gets." A coding agent assigned a task doesn't
// give every worker the same powers: explorers and reviewers are read-only; implementers can
// write, but only inside an isolated worktree; testers can run commands. Each role maps to a
// Claude Agent SDK permission mode + an allow-list of tools + a default model + a system prompt.
//
// Agent SDK tool names are PascalCase: Read, Write, Edit, Bash, Glob, Grep.
// permissionMode: 'plan' = read-only (no edits), 'bypassPermissions' = act without prompts.

const M = {
  plan: process.env.DEVSWARM_MODEL_PLAN || 'claude-opus-4-8',
  implement: process.env.DEVSWARM_MODEL_IMPLEMENT || 'claude-opus-4-8',
  review: process.env.DEVSWARM_MODEL_REVIEW || 'claude-opus-4-8',
  light: process.env.DEVSWARM_MODEL_LIGHT || 'claude-sonnet-4-6',
};

export const ROLES = {
  // Reads the codebase and reports. Cannot modify anything.
  explorer: {
    model: M.light,
    permissionMode: 'plan',
    allowedTools: ['Read', 'Grep', 'Glob', 'Bash'],
    isolate: false,
    system:
      'You are an EXPLORER. Investigate the codebase with read-only tools and report findings ' +
      'precisely. You must not modify any files.',
  },

  // Breaks a feature into independent, parallelizable subtasks. Read-only.
  planner: {
    model: M.plan,
    permissionMode: 'plan',
    allowedTools: ['Read', 'Grep', 'Glob', 'Bash'],
    isolate: false,
    system:
      'You are a PLANNER. Explore the repo, then decompose the requested work into INDEPENDENT ' +
      'subtasks that can be implemented in parallel without touching the same files where possible. ' +
      'Be concrete about which files each subtask owns. Do not modify files.',
  },

  // Implements ONE subtask. Writes code — but the orchestrator runs it inside its own
  // git worktree, so parallel implementers can never clobber each other.
  implementer: {
    model: M.implement,
    permissionMode: 'bypassPermissions',
    allowedTools: ['Read', 'Write', 'Edit', 'Grep', 'Glob', 'Bash'],
    isolate: true, // => the orchestrator gives this agent its own worktree by default
    system:
      'You are an IMPLEMENTER assigned exactly ONE subtask. Your working directory is an isolated ' +
      'checkout of the repo — make your change here, keep it scoped to the subtask, and make sure ' +
      'the project still builds. Do not touch files outside your subtask. When done, summarize what ' +
      'you changed and why.',
  },

  // Runs the test/build commands in a worktree and reports pass/fail + failing output.
  tester: {
    model: M.light,
    permissionMode: 'bypassPermissions',
    allowedTools: ['Read', 'Bash', 'Grep', 'Glob'],
    isolate: false, // runs in whatever cwd it's pointed at (usually an implementer's worktree)
    system:
      'You are a TESTER. Run the project\'s test/build commands in the given directory and report ' +
      'whether they pass, with the exact failing output if not. Do not fix anything.',
  },

  // Reviews a diff for correctness/risk. Read-only.
  reviewer: {
    model: M.review,
    permissionMode: 'plan',
    allowedTools: ['Read', 'Grep', 'Glob', 'Bash'],
    isolate: false,
    system:
      'You are a REVIEWER. Inspect the change (use `git diff` and read files) for correctness, ' +
      'missed edge cases, and risk. Be specific and cite file:line. Do not modify files.',
  },
};

export function resolveRole(role) {
  if (typeof role === 'object' && role) return role; // allow inline custom role objects
  const preset = ROLES[role];
  if (!preset) throw new Error(`Unknown role '${role}'. Known roles: ${Object.keys(ROLES).join(', ')}`);
  return preset;
}
