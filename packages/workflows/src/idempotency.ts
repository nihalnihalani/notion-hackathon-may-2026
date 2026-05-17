/**
 * Workflow-level idempotency check.
 *
 * Spec (PLAN.md §VI):
 *
 *   Idempotency key = `descriptionHash(workspaceId, description)` — computed
 *   by `@forge/db/idempotency` and passed in via the trigger event so the
 *   workflow doesn't recompute (canonical hash; recomputing risks drift).
 *
 *   Window = 1h. Within the window, if a previously-succeeded Generation
 *   matches the hash AND the user did not pass `force: true`, the workflow
 *   short-circuits and returns the cached agent.
 *
 * This module is pure of side effects beyond the DB lookup it delegates to.
 * Returning a discriminated union (instead of `Generation | null`) makes the
 * call site at the top of `forge.ts` easier to read.
 */

import type { WorkflowDbHelpers } from './types.js';

/**
 * Result of an idempotency check. The discriminant lets callers `if (res.hit)`
 * to narrow without re-checking for null.
 */
export type IdempotencyCheckResult =
  | {
      hit: true;
      generation: {
        id: string;
        workspaceId: string;
        agentId: string | null;
        completedAt: Date | null;
      };
    }
  | { hit: false };

/**
 * Default idempotency window: 1 hour. Mirrors PLAN.md §VI; tests can override.
 */
export const DEFAULT_IDEMPOTENCY_WINDOW_MS = 60 * 60 * 1000;

/**
 * Look up a successful Generation in the idempotency window.
 *
 * Returns `{ hit: true, generation }` when the cache hits, `{ hit: false }`
 * otherwise. The DB lookup is delegated to `db.findRecentByHash` (the only IO
 * this function does).
 *
 * `windowMs <= 0` disables the lookup entirely and always returns
 * `{ hit: false }` — useful as a kill switch.
 *
 * `force === true` short-circuits the lookup and returns `{ hit: false }`
 * without hitting the DB.
 */
export async function checkExistingGeneration(
  db: WorkflowDbHelpers,
  args: {
    workspaceId: string;
    descriptionHash: string;
    force?: boolean | undefined;
    windowMs?: number | undefined;
  },
): Promise<IdempotencyCheckResult> {
  if (args.force === true) return { hit: false };

  const window = args.windowMs ?? DEFAULT_IDEMPOTENCY_WINDOW_MS;
  if (!Number.isFinite(window) || window <= 0) return { hit: false };

  const row = await db.findRecentByHash(args.workspaceId, args.descriptionHash, window);
  if (row === null) return { hit: false };
  // Sanity: only `status === 'succeeded'` rows should be returned, but we
  // double-check because the DB helper signature is structural.
  if (row.status !== 'succeeded') return { hit: false };

  return {
    hit: true,
    generation: {
      id: row.id,
      workspaceId: row.workspaceId,
      agentId: row.agentId,
      completedAt: row.completedAt,
    },
  };
}
