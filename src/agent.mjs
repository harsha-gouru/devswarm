// The agent primitive: one subagent = one Claude Agent SDK query() call.
//
// We hand the SDK a role (system prompt + allowed tools + permission mode + model) and a cwd,
// let it run its own tool loop to completion, and capture the final text + token usage. If a
// JSON schema is requested, we ask for JSON-only output and validate it ourselves (the Agent
// SDK has no built-in structured-output mode).
//
// query({ prompt, options }) returns an async iterable of messages; the final result is the
// message with type === 'result' (its `.result` is the final text, `.usage` the token counts).

import { resolveRole } from './roles.mjs';

let _query;
async function getQuery() {
  if (_query) return _query;
  try {
    ({ query: _query } = await import('@anthropic-ai/claude-agent-sdk'));
  } catch (e) {
    throw new Error(
      'devswarm needs @anthropic-ai/claude-agent-sdk. Install it: npm install\n' +
      `(import error: ${e?.message ?? e})`,
    );
  }
  return _query;
}

function stripFences(s) {
  const m = String(s).match(/```(?:json)?\s*([\s\S]*?)```/);
  return (m ? m[1] : String(s)).trim();
}

/**
 * Run one agent to completion.
 * @param {string|object} role   role name (see roles.mjs) or an inline role object
 * @param {string} prompt        the task for this agent
 * @param {object} opts
 * @param {string} opts.cwd            working directory for this agent
 * @param {object} opts.schema         JSON Schema — if set, returns a validated object (or null)
 * @param {number} opts.maxTurns       max tool-loop turns (default 60)
 * @param {string} opts.model          override the role's model
 * @param {(n:number)=>void} opts.recordUsage  called with output-token counts
 * @param {(schema,value)=>{ok,errors}} opts.validate  schema validator
 * @returns {Promise<string|object|null>}
 */
export async function runAgent(role, prompt, opts = {}) {
  const query = await getQuery();
  const r = resolveRole(role);

  let prompt2 = prompt;
  let system = r.system;
  if (opts.schema) {
    system += '\n\nWhen finished, output ONLY a single JSON object matching the required schema as your final message — no prose, no code fences.';
    prompt2 = `${prompt}\n\nReturn ONLY JSON matching this schema:\n${JSON.stringify(opts.schema)}`;
  }

  const options = {
    cwd: opts.cwd || process.cwd(),
    systemPrompt: system,
    model: opts.model || r.model,
    maxTurns: opts.maxTurns ?? 60,
    permissionMode: r.permissionMode,
    allowedTools: r.allowedTools,
  };

  let finalText = '';
  for await (const message of query({ prompt: prompt2, options })) {
    if (message && typeof message === 'object' && message.type === 'result' && 'result' in message) {
      finalText = message.result ?? '';
      const used = message.usage?.output_tokens ?? message.usage?.outputTokens ?? 0;
      opts.recordUsage?.(used);
    }
  }

  if (opts.schema) {
    let parsed;
    try { parsed = JSON.parse(stripFences(finalText)); } catch { return null; }
    if (opts.validate) {
      const { ok } = opts.validate(opts.schema, parsed);
      return ok ? parsed : null;
    }
    return parsed;
  }
  return finalText.trim();
}
