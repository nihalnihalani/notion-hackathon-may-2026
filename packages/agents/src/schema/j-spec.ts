/**
 * Pure helpers for the {@link JSchemaSpec} restricted subset.
 *
 *  - {@link validateJSchema} — round-trip / shape validator. No IO.
 *  - {@link renderJSchemaAsTS} — emits the `j.<kind>().describe(...)` chain
 *    that Tool Coder splats into the generated Worker's `worker.tool({...})`
 *    call.
 *
 * SECURITY: Both functions are side-effect-free. {@link renderJSchemaAsTS}
 * escapes every string field that lands in the emitted code — Schema Smith
 * output is LLM-controlled and must be treated as untrusted text.
 */

import { jSchemaSpecSchema, type JSchemaSpec } from '../types.js';

// ─────────────────────────────────────────────────────────────────────────────
// validateJSchema
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Result of {@link validateJSchema}.
 */
export type ValidateJSchemaResult = { ok: true; spec: JSchemaSpec } | { ok: false; error: string };

/**
 * Validate `spec` against the {@link JSchemaSpec} discriminated union.
 *
 * Returns a tagged result rather than throwing — callers (notably Schema Smith
 * during the self-eval retry) need to feed the error back into the next
 * prompt, not propagate it as a stack trace.
 */
export function validateJSchema(spec: unknown): ValidateJSchemaResult {
  const parsed = jSchemaSpecSchema.safeParse(spec);
  if (parsed.success) {
    return { ok: true, spec: parsed.data };
  }
  return { ok: false, error: formatZodError(parsed.error.issues) };
}

interface ZodIssueLite {
  path: readonly (string | number)[];
  message: string;
  code: string;
}

function formatZodError(issues: readonly ZodIssueLite[]): string {
  return issues
    .map((i) => {
      const path = i.path.length > 0 ? i.path.join('.') : '<root>';
      return `${path}: ${i.message}`;
    })
    .join('; ');
}

// ─────────────────────────────────────────────────────────────────────────────
// renderJSchemaAsTS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Render `spec` as a TS expression that builds the equivalent `j` schema.
 *
 * Output examples:
 *
 *   { kind: 'string', describe: 'User name' }
 *     → `j.string().describe("User name")`
 *
 *   { kind: 'string', describe: 'Status', enum: ['open','closed'] }
 *     → `j.string().enum(["open","closed"]).describe("Status")`
 *
 *   { kind: 'object', describe: 'Issue', properties: { id: {...} }, required: ['id'] }
 *     → `j.object({ id: j.string().describe("id") }).required(["id"]).describe("Issue")`
 *
 * Pure: no IO; deterministic; safe to call from any runtime.
 */
export function renderJSchemaAsTS(spec: JSchemaSpec): string {
  return renderNode(spec);
}

function renderNode(spec: JSchemaSpec): string {
  switch (spec.kind) {
    case 'object': {
      return renderObject(spec);
    }
    case 'array': {
      return renderArray(spec);
    }
    case 'string':
    case 'number':
    case 'integer':
    case 'boolean':
    case 'email':
    case 'uuid':
    case 'datetime': {
      return renderScalar(spec);
    }
  }
}

function renderScalar(
  spec: Extract<
    JSchemaSpec,
    {
      kind: 'string' | 'number' | 'integer' | 'boolean' | 'email' | 'uuid' | 'datetime';
    }
  >,
): string {
  // The `j` builder names map 1:1 to our `kind` values.
  let out = `j.${spec.kind}()`;
  if (spec.enum && spec.enum.length > 0) {
    const items = spec.enum.map((v) => jsString(v)).join(', ');
    out += `.enum([${items}])`;
  }
  if (spec.nullable) {
    out += `.nullable()`;
  }
  out += `.describe(${jsString(spec.describe)})`;
  return out;
}

function renderObject(spec: Extract<JSchemaSpec, { kind: 'object' }>): string {
  const entries = Object.entries(spec.properties)
    .map(([key, child]) => `${jsKey(key)}: ${renderNode(child)}`)
    .join(', ');
  let out = `j.object({${entries ? ` ${entries} ` : ''}})`;
  if (spec.required && spec.required.length > 0) {
    const items = spec.required.map((v) => jsString(v)).join(', ');
    out += `.required([${items}])`;
  }
  if (spec.nullable) {
    out += `.nullable()`;
  }
  out += `.describe(${jsString(spec.describe)})`;
  return out;
}

function renderArray(spec: Extract<JSchemaSpec, { kind: 'array' }>): string {
  let out = `j.array(${renderNode(spec.items)})`;
  if (spec.nullable) {
    out += `.nullable()`;
  }
  out += `.describe(${jsString(spec.describe)})`;
  return out;
}

/**
 * Conservative JS string literal — JSON-encodes then strips the outer quotes
 * so we round-trip through a tested encoder. Avoids template-literal edge
 * cases and is XSS / injection-proof for our use case (we never eval this).
 */
function jsString(s: string): string {
  return JSON.stringify(s);
}

/**
 * Render an object-literal key. If the key is a valid identifier we emit it
 * bare; otherwise quote it. The validity check is intentionally narrow.
 */
function jsKey(key: string): string {
  const isIdent = /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(key);
  return isIdent ? key : jsString(key);
}
