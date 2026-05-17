/**
 * Cost accounting helpers — pure functions.
 *
 * The workflow records a `costUsd` column on every `GenerationStep` row. At
 * `finalize` time we sum the per-step values into `Generation.totalCostUsd`
 * (Decimal in the DB; a plain `number` for our in-flight math is fine because
 * the per-call costs are bounded by Schema Smith + Tool Coder ≤ ~$0.50 with
 * Opus pricing, well below the 53-bit precision ceiling).
 *
 * `costExceedsBudget` is the gate the orchestrator uses BEFORE each LLM step
 * to short-circuit when the user has set a per-workspace budget. Returning a
 * boolean (not throwing) lets the caller emit a structured Build Log entry
 * before deciding whether to fail the run.
 */

import type { GenerationStep } from '@forge/db';

/**
 * Sum `costUsd` across a list of `GenerationStep` rows. Coerces
 * `Prisma.Decimal | number | null` into `number` safely; nulls and undefined
 * are treated as 0.
 *
 * Returns 0 for an empty array.
 */
export function sumGenerationCost(
  steps: readonly Pick<GenerationStep, 'costUsd'>[],
): number {
  let total = 0;
  for (const step of steps) {
    const n = toNumberSafe(step.costUsd);
    // toNumberSafe already returns 0 for NaN, but Number coercion of objects
    // can still surface a non-finite via `valueOf`; treat all non-finite as 0.
    if (Number.isFinite(n)) total += n;
  }
  return round4(total);
}

/**
 * Sum `latencyMs` across a list of `GenerationStep` rows. Used by `finalize`
 * to populate `Generation.totalLatencyMs`.
 *
 * Nulls are treated as 0. Returns 0 for an empty array.
 */
export function sumGenerationLatency(
  steps: readonly Pick<GenerationStep, 'latencyMs'>[],
): number {
  let total = 0;
  for (const step of steps) {
    total += step.latencyMs ?? 0;
  }
  return total;
}

/**
 * Cheap inline gate: does running another step risk pushing the workspace
 * past its budget?
 *
 * Returns `true` when `currentUsd >= budgetUsd`. We compare with `>=` (not
 * `>`) because once the budget is hit we shouldn't run another step. Callers
 * that want strict "going over" semantics should pass `budgetUsd - epsilon`.
 *
 * A `budgetUsd <= 0` is treated as "no budget" and always returns `false`.
 */
export function costExceedsBudget(
  currentUsd: number,
  budgetUsd: number,
): boolean {
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) return false;
  if (!Number.isFinite(currentUsd) || currentUsd < 0) return false;
  return currentUsd >= budgetUsd;
}

/**
 * Coerce the `Prisma.Decimal | number | null` shape into `number` safely.
 * The Decimal class exposes `.toNumber()` — we sniff for that without
 * importing the type so this helper stays Edge-bundle safe.
 */
function toNumberSafe(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  if (
    typeof value === 'object' &&
    'toNumber' in value &&
    typeof (value as { toNumber: () => number }).toNumber === 'function'
  ) {
    try {
      const n = (value as { toNumber: () => number }).toNumber();
      return Number.isFinite(n) ? n : 0;
    } catch {
      return 0;
    }
  }
  return 0;
}

/**
 * Round to 4 decimal places — matches the precision PLAN.md §V uses for cost
 * columns and avoids `0.1 + 0.2 = 0.30000000000000004` artifacts in the
 * Build Log.
 */
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
