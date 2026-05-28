// Resume journal — content-addressed caching of agent() results so a long dev task can be
// re-run cheaply. Each agent() call is keyed by a hash chained off the previous call, so
// editing/inserting a step invalidates that step and everything after it, while the unchanged
// prefix is served from cache. Best-effort for heavily parallel sections (keys are assigned in
// synchronous call order).

import { createHash } from 'node:crypto';
import { readFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

function stable(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj) ?? 'null';
  if (Array.isArray(obj)) return `[${obj.map(stable).join(',')}]`;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stable(obj[k])}`).join(',')}}`;
}

export class Journal {
  constructor(path = null) {
    this.path = path;
    this.cache = new Map();
    this.prevKey = '';
    this.diverged = false;
    if (path && existsSync(path)) {
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try { const e = JSON.parse(line); this.cache.set(e.key, e.result); } catch { /* skip */ }
      }
    }
  }

  nextKey(role, prompt, opts) {
    const optKey = stable({ role: typeof role === 'string' ? role : 'inline', schema: opts.schema ?? null, model: opts.model ?? null, isolation: opts.isolation ?? null });
    const key = createHash('sha256').update(this.prevKey).update('\0').update(prompt).update('\0').update(optKey).digest('hex');
    this.prevKey = key;
    return key;
  }

  get(key) { return this.diverged ? undefined : this.cache.get(key); }

  record(key, result) {
    this.cache.set(key, result);
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify({ key, result })}\n`);
  }
}
