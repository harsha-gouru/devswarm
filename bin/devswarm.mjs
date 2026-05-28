#!/usr/bin/env node
// devswarm CLI — run a task definition against a target repo.
//
//   devswarm <workflow.mjs> --target <repo> --args '<json>' [options]
//
// Options:
//   --target <dir>      the repo the agents operate on (default: current dir)
//   --args <json|@file> input exposed to the task as `args` (inline JSON or @path.json)
//   --budget <amount>   override tokenBudget: "+3m", "500k", or a plain number
//   --concurrency <n>   override max concurrent agents
//   --on-failure <mode> continue | retry | abort
//   --resume <runId>    resume from a previous run's journal
//   --no-resume         disable the resume journal
//   --json              print only the final result as JSON

import { readFileSync, existsSync } from 'node:fs';
import { resolve, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { runTask } from '../src/orchestrate.mjs';

function loadEnv(dir) {
  const p = join(dir, '.env');
  if (!existsSync(p)) return;
  for (const raw of readFileSync(p, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i === -1) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(k in process.env)) process.env[k] = v;
  }
}

function parseBudget(s) {
  if (!s) return undefined;
  const m = String(s).trim().match(/^\+?([\d.]+)\s*([kKmM]?)$/);
  if (!m) return undefined;
  const mult = m[2].toLowerCase() === 'm' ? 1e6 : m[2].toLowerCase() === 'k' ? 1e3 : 1;
  return Math.round(parseFloat(m[1]) * mult);
}

function parseArgv(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (k === 'no-resume' || k === 'json') out.flags[k] = true;
      else out.flags[k] = argv[++i];
    } else out._.push(a);
  }
  return out;
}

function render(quiet) {
  return (e) => {
    const w = (s) => process.stderr.write(s + '\n');
    if (e.type === 'phase') w(`\n\x1b[1m▸ ${e.title}\x1b[0m`);
    else if (e.type === 'log') w(`  \x1b[2m≡ ${e.msg}\x1b[0m`);
    else if (e.type === 'agent:start' && !quiet) w(`  • [${e.phase}] ${e.role}`);
    else if (e.type === 'agent:cached') w(`  \x1b[2m⤷ cached: ${e.role}\x1b[0m`);
    else if (e.type === 'worktree') w(`  \x1b[2m⌂ ${e.branch} ${e.removed ? 'removed (no changes)' : `kept (${e.files} file(s))`}\x1b[0m`);
    else if (e.type === 'warn') w(`  \x1b[33m! ${e.msg}\x1b[0m`);
    else if (e.type === 'agent:error') w(`  \x1b[31m✗ ${e.role} (attempt ${e.attempt}): ${e.error}\x1b[0m`);
  };
}

async function main() {
  const { _, flags } = parseArgv(process.argv.slice(2));
  const workflowPath = _[0];
  if (!workflowPath) {
    process.stderr.write('usage: devswarm <workflow.mjs> --target <repo> --args \'<json>\' [--budget +3m] [--concurrency 4] [--on-failure continue|retry|abort] [--resume <id>] [--no-resume] [--json]\n');
    process.exit(2);
  }

  const target = flags.target ? (isAbsolute(flags.target) ? flags.target : resolve(flags.target)) : process.cwd();
  loadEnv(process.cwd());
  loadEnv(target);

  if (!process.env.ANTHROPIC_API_KEY) {
    process.stderr.write('\x1b[31mANTHROPIC_API_KEY is not set. Add it to .env or export it.\x1b[0m\n');
    process.exit(1);
  }

  const mod = await import(pathToFileURL(resolve(workflowPath)).href);
  const task = mod.default;
  if (!task || typeof task.run !== 'function') {
    process.stderr.write('workflow file must `export default defineTask({...})`\n');
    process.exit(2);
  }

  // CLI overrides of declared knobs
  const budget = parseBudget(flags.budget);
  if (budget !== undefined) task.tokenBudget = budget;
  if (flags.concurrency) task.concurrency = parseInt(flags.concurrency, 10);
  if (flags['on-failure']) task.onFailure = flags['on-failure'];
  if (flags['no-resume']) task.resume = false;

  const args = flags.args ? (flags.args.startsWith('@') ? JSON.parse(readFileSync(resolve(flags.args.slice(1)), 'utf8')) : JSON.parse(flags.args)) : undefined;
  const runId = flags.resume || `run_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const journalPath = task.resume ? join(homedir(), '.devswarm', 'runs', runId, 'journal.jsonl') : null;

  if (!flags.json) {
    process.stderr.write(`\x1b[2mdevswarm ${task.name}  run=${runId}  target=${target}\x1b[0m\n`);
    process.stderr.write(`\x1b[2mconcurrency=${task.concurrency}  budget=${task.tokenBudget ?? '∞'}  cap=${task.agentCap}  onFailure=${task.onFailure}  resume=${task.resume}\x1b[0m\n`);
    if (flags.resume) process.stderr.write('\x1b[2mresuming — unchanged agent() prefix served from journal\x1b[0m\n');
  }

  const onEvent = flags.json ? () => {} : render(false);
  const res = await runTask(task, { args, cwd: target, runId, journalPath, onEvent });

  if (flags.json) {
    process.stdout.write(JSON.stringify(res.aborted ? res : res.result, null, 2) + '\n');
  } else {
    process.stderr.write(`\n\x1b[1m─── result ───\x1b[0m\n`);
    process.stdout.write(JSON.stringify(res.aborted ? { aborted: true, reason: res.reason } : res.result, null, 2) + '\n');
    process.stderr.write(`\n\x1b[2m${res.agentCount} agents · ${res.tokensSpent} output tokens · ${res.failures.length} failures · ${res.worktrees.length} worktrees · journal: ${journalPath ?? 'off'}\x1b[0m\n`);
    if (res.aborted) process.stderr.write(`\x1b[31maborted: ${res.reason}\x1b[0m\n`);
  }
}

main().catch((e) => { process.stderr.write(`\n\x1b[31mfailed: ${e?.stack ?? e}\x1b[0m\n`); process.exit(1); });
