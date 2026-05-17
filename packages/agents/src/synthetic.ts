/**
 * Pure helpers used by the Inspector to (a) synthesize valid-shape input for
 * `ntn workers exec` and (b) validate the Worker's output against the
 * Schema-Smith-emitted output schema.
 *
 * Both functions are *pure*: no IO, no globals, no time-dependent randomness.
 * Determinism is a hard requirement — the Inspector replays the same input on
 * retry, and the orchestrator hashes the input into the generation manifest.
 *
 * The exhaustive `switch` on {@link JSchemaSpec.kind} is the single place that
 * must change when the type is extended. The compile-time `assertNever` guard
 * keeps Tool-Coder hallucinations honest: a new kind that this file doesn't
 * know how to render will break the build.
 */

import { z, type ZodTypeAny } from 'zod';
import type { JSchemaSpec } from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// generateSynthetic
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Deterministic value for each scalar kind. Constants (not `Date.now()` etc.)
 * so the generated input hashes identically across runs.
 */
const SYNTHETIC_SCALAR = Object.freeze({
  string: 'synthetic-test-input',
  number: 0,
  integer: 0,
  boolean: false,
  email: 'test@forge.example',
  uuid: '00000000-0000-0000-0000-000000000000',
  datetime: '2026-01-01T00:00:00.000Z',
});

/**
 * Build a single deterministic value matching the shape of `spec`.
 *
 * Rules:
 *  - A scalar with `enum` returns the *first* listed value (deterministic).
 *  - `nullable: true` always wins — we emit `null` so the Worker exercises
 *    its null-handling path on the synthetic run. This is intentional: a
 *    happy-path-only synthetic would leave the null branch un-exercised.
 *  - Objects include ONLY their `required` properties. Optional properties
 *    are omitted (the Worker should handle missing optional fields).
 *  - Arrays return a single-element array of the recursed inner type.
 */
export function generateSynthetic(spec: JSchemaSpec): unknown {
  if (spec.nullable === true) {
    return null;
  }
  return generateNonNull(spec);
}

function generateNonNull(spec: JSchemaSpec): unknown {
  switch (spec.kind) {
    case 'string':
    case 'email':
    case 'uuid':
    case 'datetime': {
      const enumValues = spec.enum;
      if (enumValues !== undefined && enumValues.length > 0) {
        // `noUncheckedIndexedAccess` — explicit fallback when enum is empty
        // (defensive; the validator already rejects zero-length enums).
        return enumValues[0] ?? SYNTHETIC_SCALAR[spec.kind];
      }
      return SYNTHETIC_SCALAR[spec.kind];
    }
    case 'number':
    case 'integer':
      return SYNTHETIC_SCALAR[spec.kind];
    case 'boolean':
      return SYNTHETIC_SCALAR.boolean;
    case 'object': {
      const out: Record<string, unknown> = {};
      const required = spec.required ?? [];
      // Walk the *declared* property order; only emit the required subset so
      // optional fields stay unset.
      for (const [key, child] of Object.entries(spec.properties)) {
        if (required.includes(key)) {
          out[key] = generateSynthetic(child);
        }
      }
      return out;
    }
    case 'array':
      return [generateSynthetic(spec.items)];
    default:
      return assertNever(spec);
  }
}

/** Compile-time exhaustiveness guard — Tool Coder must not introduce a new kind silently. */
function assertNever(value: never): never {
  throw new Error(`generateSynthetic: unhandled JSchemaSpec kind: ${JSON.stringify(value)}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// validateAgainstOutputSchema
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tagged result of {@link validateAgainstOutputSchema}.
 */
export type ValidateOutputResult = { ok: true } | { ok: false; error: string };

/**
 * Validate `value` against the JSchemaSpec `spec` using a zod schema built
 * fresh per call. Pure — does not memoize, does not mutate `spec`.
 *
 * Why zod (not a hand-rolled validator):
 *  - We already depend on zod for {@link jSchemaSpecSchema}.
 *  - Tagged-union errors include `path`, which gives the Build Log a precise
 *    "outputSchema.results[0].id: expected uuid" message.
 *  - The Worker output is untrusted (LLM-generated code in the sandbox);
 *    zod's safe-parse is the right safety surface.
 */
export function validateAgainstOutputSchema(
  value: unknown,
  spec: JSchemaSpec,
): ValidateOutputResult {
  const schema = jSchemaToZod(spec);
  const parsed = schema.safeParse(value);
  if (parsed.success) {
    return { ok: true };
  }
  const issues = parsed.error.issues
    .map((issue) => {
      const path = issue.path.length === 0 ? '<root>' : issue.path.join('.');
      return `${path}: ${issue.message}`;
    })
    .join('; ');
  return { ok: false, error: issues };
}

/**
 * Convert a {@link JSchemaSpec} into a runtime zod schema.
 *
 * Each variant maps to the closest semantic zod type:
 *  - email → `z.string().email()`
 *  - uuid → `z.string().uuid()`
 *  - datetime → `z.string().datetime()` (ISO-8601 with offset)
 *  - integer → `z.number().int()`
 *  - enum (on a string-flavoured kind) → `z.enum([...])`
 *
 * Object schemas use `.strict()` — generated Workers shouldn't return
 * fields they didn't declare. Loosening this would let LLM hallucinations
 * smuggle extra keys past Inspector.
 */
function jSchemaToZod(spec: JSchemaSpec): ZodTypeAny {
  const base = jSchemaToZodNonNull(spec);
  return spec.nullable === true ? base.nullable() : base;
}

function jSchemaToZodNonNull(spec: JSchemaSpec): ZodTypeAny {
  switch (spec.kind) {
    case 'string': {
      if (spec.enum !== undefined && spec.enum.length > 0) {
        // z.enum requires a non-empty tuple; the runtime guard above
        // satisfies the type, but TS needs the cast.
        const values = spec.enum as readonly [string, ...string[]];
        return z.enum(values);
      }
      return z.string();
    }
    case 'email':
      return z.string().email();
    case 'uuid':
      return z.string().uuid();
    case 'datetime':
      return z.string().datetime({ offset: true });
    case 'number':
      return z.number();
    case 'integer':
      return z.number().int();
    case 'boolean':
      return z.boolean();
    case 'object': {
      const shape: Record<string, ZodTypeAny> = {};
      const required = new Set(spec.required ?? []);
      for (const [key, child] of Object.entries(spec.properties)) {
        const childSchema = jSchemaToZod(child);
        shape[key] = required.has(key) ? childSchema : childSchema.optional();
      }
      return z.object(shape).strict();
    }
    case 'array':
      return z.array(jSchemaToZod(spec.items));
    default:
      return assertNever(spec);
  }
}
