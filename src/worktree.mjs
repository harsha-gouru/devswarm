// git-worktree isolation — the safe-autonomy primitive.
//
// Every implementer agent gets its OWN checkout of the target repo on its OWN branch. The
// agent edits files freely inside it (bypassPermissions) but can never touch another agent's
// work or the user's working tree. After the agent runs we measure what changed; an unchanged
// worktree is auto-removed, a changed one is kept on its branch for review/merge.

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

export function isGitRepo(cwd) {
  try { git(['rev-parse', '--is-inside-work-tree'], cwd); return true; } catch { return false; }
}

export function createWorktree(repoCwd, slug) {
  const base = git(['rev-parse', 'HEAD'], repoCwd).trim();
  const path = join(repoCwd, '.devswarm-worktrees', slug);
  const branch = `devswarm/${slug}`;
  git(['worktree', 'add', '--no-track', '-B', branch, path, base], repoCwd);
  return { path, branch, base };
}

// What did the agent change in its worktree?
export function inspectWorktree(wt) {
  let changedFiles = [];
  let commitsAhead = 0;
  let diffStat = '';
  try {
    const status = git(['status', '--porcelain'], wt.path).trim();
    changedFiles = status ? status.split('\n').map((l) => l.slice(3)) : [];
    commitsAhead = parseInt(git(['rev-list', '--count', `${wt.base}..HEAD`], wt.path).trim() || '0', 10);
    diffStat = git(['diff', '--stat', wt.base], wt.path).trim();
  } catch { /* leave defaults */ }
  return { changed: changedFiles.length > 0 || commitsAhead > 0, changedFiles, commitsAhead, diffStat };
}

export function removeWorktree(repoCwd, wt) {
  try { git(['worktree', 'remove', '--force', wt.path], repoCwd); return true; } catch { return false; }
}

// Optional: fast-forward / merge a clean agent branch back into the base branch.
export function mergeBranch(repoCwd, branch) {
  try {
    git(['merge', '--no-ff', '--no-edit', branch], repoCwd);
    return { merged: true };
  } catch (e) {
    return { merged: false, error: String(e?.message ?? e) };
  }
}
