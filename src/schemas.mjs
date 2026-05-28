// JSON schemas used to force structured output from agents at the key handoff points.
// Structured output is what makes one agent's result safely consumable by the next stage.

export const PLAN = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'subtasks'],
  properties: {
    summary: { type: 'string', description: 'one-paragraph plan overview' },
    subtasks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'title', 'description', 'files'],
        properties: {
          id: { type: 'string', description: 'short slug, e.g. "add-auth-route"' },
          title: { type: 'string' },
          description: { type: 'string', description: 'what to implement, with acceptance criteria' },
          files: { type: 'array', items: { type: 'string' }, description: 'files this subtask will own/touch' },
          dependsOn: { type: 'array', items: { type: 'string' }, description: 'ids of subtasks that must finish first (optional)' },
        },
      },
    },
  },
};

export const IMPL_RESULT = {
  type: 'object',
  additionalProperties: false,
  required: ['done', 'summary', 'filesChanged'],
  properties: {
    done: { type: 'boolean', description: 'true if the subtask was fully implemented' },
    summary: { type: 'string', description: 'what you changed and why' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string', description: 'anything the integrator/reviewer should know (optional)' },
  },
};

export const TEST_RESULT = {
  type: 'object',
  additionalProperties: false,
  required: ['passed', 'command'],
  properties: {
    passed: { type: 'boolean' },
    command: { type: 'string', description: 'the test/build command you ran' },
    failingOutput: { type: 'string', description: 'the relevant failing output (empty if passed)' },
  },
};

export const REVIEW = {
  type: 'object',
  additionalProperties: false,
  required: ['approve', 'issues'],
  properties: {
    approve: { type: 'boolean', description: 'true if the change is safe to integrate' },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'detail'],
        properties: {
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
          detail: { type: 'string' },
          file: { type: 'string' },
        },
      },
    },
  },
};
