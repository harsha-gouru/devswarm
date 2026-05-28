// JSON-Schema validation (ajv) for structured agent output.

import Ajv from 'ajv';

const ajv = new Ajv({ allErrors: true, strict: false });

export function makeValidate() {
  const cache = new Map();
  return (schema, value) => {
    let v = cache.get(schema);
    if (!v) {
      try { v = ajv.compile(schema); }
      catch (e) { return { ok: false, errors: `invalid schema: ${e?.message ?? e}` }; }
      cache.set(schema, v);
    }
    const ok = v(value);
    return { ok, errors: ok ? null : ajv.errorsText(v.errors) };
  };
}
