// The orchestrator. You declare a task with defineTask({ ...knobs, run(ctx) }) and runTask()
// executes run(ctx), enforcing every knob:
//
//   concurrency  — counting semaphore: max agents running at once
//   tokenBudget  — hard output-token ceiling for the whole task (null = unlimited)
//   agentCap     — lifetime backstop against runaway loops
//   isolation    — implementers get their own git worktree (safe parallel writes)
//   resume       — journal results; re-running replays the unchanged prefix from cache
//   onFailure    — 'continue' (agent => null) | 'retry' (up to `retries`) | 'abort' (stop the task)
//
// Inside run(ctx) you get: agent(), parallel(), pipeline(), phase(), log(), budget,
// args, cwd (the target repo), worktrees (created so far), and mergeBranch().

import { resolveRole } from './roles.mjs';
import { runAgent } from './agent.mjs';
import { Journal } from './journal.mjs';
import { makeValidate } from './validate.mjs';
import { isGitRepo, createWorktree, inspectWorktree, removeWorktree, mergeBranch } from './worktree.mjs';

class AbortTaskError extends Error {}

function semaphore(max) {
  let active = 0;
  const q = [];
  return (fn) => async (...a) => {
    if (active >= max) await new Promise((r) => q.push(r));
    active++;
    try { return await fn(...a); } finally { active--; q.shift()?.(); }
  };
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 28) || 'agent';

/** Declare a task. Returns a config object with sensible defaults; override any knob. */
export function defineTask(def) {
  if (!def || typeof def.name !== 'string') throw new Error('defineTask: `name` (string) is required');
  if (typeof def.run !== 'function') throw new Error('defineTask: `run(ctx)` (function) is required');
  return {
    concurrency: 4,
    tokenBudget: null,
    agentCap: 200,
    isolation: undefined, // per-role default (implementer isolates) unless an agent() call overrides
    resume: true,
    onFailure: 'continue',
    retries: 1,
    ...def,
  };
}

/**
 * Execute a task definition.
 * @param {object} task     a defineTask() result
 * @param {object} runOpts  { args, cwd (target repo), runId, journalPath, onEvent }
 */
export async function runTask(task, runOpts = {}) {
  const { args, cwd = process.cwd(), runId = 'run', journalPath = null, onEvent = () => {} } = runOpts;
  const { concurrency, agentCap, tokenBudget } = task;

  const validate = makeValidate();
  const journal = new Journal(task.resume ? journalPath : null);
  const limit = semaphore(concurrency);

  let count = 0;
  let spent = 0;
  let currentPhase = null;
  const logs = [];
  const failures = [];
  const worktrees = [];

  function checkLimits() {
    if (count >= agentCap) throw new AbortTaskError(`Agent lifetime cap (${agentCap}) reached — likely a runaway loop. Raise agentCap or add a stop condition.`);
    if (tokenBudget != null && spent >= tokenBudget) throw new AbortTaskError(`Token budget exceeded (${spent} / ${tokenBudget} output tokens).`);
  }

  // Run a single agent: resolve isolation, (maybe) create a worktree, call the SDK, inspect changes.
  const runOne = async (roleName, prompt, opts) => {
    checkLimits();
    const n = ++count;
    const role = resolveRole(roleName);
    const iso = opts.isolation !== undefined ? opts.isolation
      : task.isolation !== undefined ? task.isolation
      : (role.isolate ? 'worktree' : false);
    const phaseTitle = opts.phase ?? currentPhase ?? task.name;
    const label = opts.label ?? (typeof roleName === 'string' ? roleName : 'agent');
    onEvent({ type: 'agent:start', role: label, phase: phaseTitle, n });

    let runCwd = opts.cwd ?? cwd;
    let wt = null;
    if (iso === 'worktree') {
      if (isGitRepo(cwd)) {
        wt = createWorktree(cwd, `${slug(label)}-${n}`);
        runCwd = wt.path;
        worktrees.push(wt);
      } else {
        onEvent({ type: 'warn', msg: `isolation:'worktree' requested but ${cwd} is not a git repo — running in the shared checkout` });
      }
    }

    const output = await runAgent(role, prompt, {
      cwd: runCwd,
      schema: opts.schema,
      model: opts.model,
      maxTurns: opts.maxTurns,
      recordUsage: (t) => { spent += t || 0; },
      validate,
    });
    onEvent({ type: 'agent:done', role: label, n, tokens: spent });

    if (wt) {
      const info = inspectWorktree(wt);
      if (!info.changed) { removeWorktree(cwd, wt); onEvent({ type: 'worktree', removed: true, branch: wt.branch }); }
      else onEvent({ type: 'worktree', removed: false, branch: wt.branch, files: info.changedFiles.length });
      return { output, worktree: { ...wt, ...info } };
    }
    return output;
  };

  // Failure policy wrapper (retry / continue / abort).
  const withPolicy = async (roleName, prompt, opts) => {
    const maxAttempts = task.onFailure === 'retry' ? task.retries + 1 : 1;
    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try { return await runOne(roleName, prompt, opts); }
      catch (e) {
        if (e instanceof AbortTaskError) throw e; // budget/cap → stop the whole task
        lastErr = e;
        failures.push({ role: opts.label ?? roleName, attempt, error: String(e?.message ?? e) });
        onEvent({ type: 'agent:error', role: opts.label ?? roleName, attempt, error: String(e?.message ?? e) });
      }
    }
    if (task.onFailure === 'abort') throw new AbortTaskError(`agent '${opts.label ?? roleName}' failed: ${String(lastErr?.message ?? lastErr)}`);
    return null; // 'continue' / exhausted retries
  };
  const limitedRun = limit(withPolicy);

  // agent(): assign journal key synchronously, check resume cache, then run.
  const agent = (roleName, prompt, opts = {}) => {
    if (typeof prompt !== 'string') return Promise.reject(new TypeError('agent(role, prompt): prompt must be a string'));
    const key = journal.nextKey(roleName, prompt, opts);
    const cached = journal.get(key);
    if (cached !== undefined) { onEvent({ type: 'agent:cached', role: opts.label ?? roleName }); return Promise.resolve(cached); }
    journal.diverged = true;
    return limitedRun(roleName, prompt, opts).then((r) => { journal.record(key, r); return r; });
  };

  const reraiseAbort = (e) => { if (e instanceof AbortTaskError) throw e; failures.push({ error: String(e?.message ?? e) }); return null; };
  const parallel = (thunks) => Promise.all(thunks.map((t) => Promise.resolve().then(t).catch(reraiseAbort)));
  const pipeline = (items, ...stages) => Promise.all(items.map(async (item, i) => {
    let v = item;
    try { for (const s of stages) v = await s(v, item, i); } catch (e) { return reraiseAbort(e); }
    return v;
  }));

  const phase = (t) => { currentPhase = String(t); onEvent({ type: 'phase', title: currentPhase }); };
  const log = (m) => { logs.push(String(m)); onEvent({ type: 'log', msg: String(m) }); };
  const budget = Object.freeze({ total: tokenBudget, spent: () => spent, remaining: () => (tokenBudget == null ? Infinity : Math.max(0, tokenBudget - spent)) });

  const ctx = {
    agent, parallel, pipeline, phase, log, budget, args, cwd, worktrees,
    mergeBranch: (branch) => mergeBranch(cwd, branch),
  };

  let result;
  try {
    result = await task.run(ctx);
  } catch (e) {
    if (e instanceof AbortTaskError) return { aborted: true, reason: e.message, result: null, agentCount: count, tokensSpent: spent, logs, failures, worktrees };
    throw e;
  }
  return { result, agentCount: count, tokensSpent: spent, logs, failures, worktrees };
}
