/**
 * Typed event publishers for the Forge workflow.
 *
 * The Vercel Workflow SDK exposes:
 *
 *   import { start, resumeHook } from 'workflow/api';
 *
 *   await start(forgeGeneration, [event]);
 *   await resumeHook(cancelToken, { reason });
 *
 * We dynamic-import `workflow/api` because it's a peer dependency — the SDK
 * is only present in the production deploy environment, and the package
 * builds + types fine without it. Tests inject a `runner` to bypass the
 * dynamic import entirely.
 *
 * Pattern: every publisher takes an explicit payload + optional `runner`
 * override (for tests). In production the runner is loaded from
 * `workflow/api` lazily on first use and cached.
 */

import { FORGE_WORKFLOW_NAME } from './forge.js';
import type {
  GenerationCancelledEvent,
  GenerationRequestedEvent,
} from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Runtime adapter — pluggable, so tests don't need `workflow/api` installed
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Structural slice of `workflow/api` we depend on. Defining it as an
 * interface (instead of importing the type) keeps this module compileable
 * without the peer dep.
 */
export interface WorkflowRunner {
  /**
   * Enqueue a fresh workflow run. The first argument is normally a workflow
   * function reference; we accept either a function or a workflow name so the
   * publisher works whether the caller has the workflow body in scope or
   * just the registered name.
   */
  start(
    workflowOrName: unknown,
    args: readonly unknown[],
  ): Promise<{ runId: string }>;
  /**
   * Send a resume payload to a waiting hook. Used for cancellation when the
   * workflow uses `createHook()` to wait for a cancellation signal.
   */
  resumeHook?(token: string, payload: unknown): Promise<{ runId: string }>;
}

/**
 * Lazily-loaded singleton. The first call to a publisher resolves the
 * runner; subsequent calls reuse it.
 */
let cachedRunner: WorkflowRunner | undefined;

/**
 * Reset the cached runner — exposed for tests that swap implementations
 * between runs. Not part of the public surface.
 */
export function __resetCachedRunner(): void {
  cachedRunner = undefined;
}

/**
 * Resolve the runner: explicit override > cached > dynamic-import.
 */
async function resolveRunner(
  override: WorkflowRunner | undefined,
): Promise<WorkflowRunner> {
  if (override !== undefined) return override;
  if (cachedRunner !== undefined) return cachedRunner;

  // Dynamic-import keeps the package buildable without `workflow` installed.
  // The string is split to avoid TypeScript's static module resolution.
  const moduleName = ['workflow', 'api'].join('/');
  try {
    const mod = (await import(/* @vite-ignore */ moduleName)) as {
      start: WorkflowRunner['start'];
      resumeHook?: WorkflowRunner['resumeHook'];
    };
    cachedRunner = { start: mod.start, ...(mod.resumeHook !== undefined && { resumeHook: mod.resumeHook }) };
    return cachedRunner;
  } catch (error) {
    throw new Error(
      `Vercel Workflow SDK not available: could not import '${moduleName}'. ` +
        `Install the 'workflow' package or pass an explicit runner. ` +
        `Original error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Publishers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Publish a `forge/generation.requested` event by starting a workflow run.
 *
 * Returns the `runId` assigned by the workflow runtime. Callers store this in
 * the `Generation` row so the API + dashboard can correlate.
 *
 * `options.runner` is for tests; production callers omit it.
 *
 * `options.workflowRef` lets the caller pass the workflow function directly
 * (preferred — the SDK uses the reference's identity to route). If omitted
 * we fall back to the registered name (`FORGE_WORKFLOW_NAME`).
 */
export async function publishGenerationRequested(
  payload: GenerationRequestedEvent,
  options: {
    runner?: WorkflowRunner;
    workflowRef?: unknown;
  } = {},
): Promise<{ runId: string }> {
  validateRequestedPayload(payload);
  const runner = await resolveRunner(options.runner);
  const target = options.workflowRef ?? FORGE_WORKFLOW_NAME;
  return runner.start(target, [payload]);
}

/**
 * Publish a `forge/generation.cancelled` event.
 *
 * The Vercel WDK doesn't (yet) expose a top-level `cancel(runId)` — it does
 * cancellation via hooks. So:
 *  1. The workflow registers a `createHook<GenerationCancelledEvent>()` at
 *     entry, stashing the token on the `Generation` row.
 *  2. Cancellation calls `resumeHook(token, payload)` which wakes the
 *     workflow up and lets it throw `GenerationCancelledError` cleanly.
 *
 * Implementations that route cancellation via a different mechanism (e.g.
 * Inngest's `cancelOn` config) supply their own runner.
 */
export async function publishGenerationCancelled(
  generationId: string,
  reason: GenerationCancelledEvent['reason'],
  options: {
    runner?: WorkflowRunner;
    /** Hook token recorded on the Generation row at workflow entry. */
    hookToken: string;
  },
): Promise<{ runId: string } | { skipped: true }> {
  const runner = await resolveRunner(options.runner);
  if (runner.resumeHook === undefined) {
    return { skipped: true };
  }
  const payload: GenerationCancelledEvent = { generationId, reason };
  return runner.resumeHook(options.hookToken, payload);
}

/**
 * Best-effort cancel of an in-flight workflow run by `runId`.
 *
 * Today the Vercel WDK does not expose a `cancel(runId)` API directly; this
 * function is the canonical seam where that would land. For now it delegates
 * to `publishGenerationCancelled` when a hook token is supplied, and
 * otherwise returns `{ skipped: true }` so callers can fall back to marking
 * the DB row as cancelled (the workflow will discover this on the next step
 * boundary via the abort-signal guard in `forge.ts`).
 *
 * Inngest deployments override this with `inngest.send({ name:
 * 'forge/generation.cancelled', data: { generationId, reason } })` which
 * triggers the `cancelOn` clause in the Inngest function definition.
 */
export async function cancelInflight(
  generationId: string,
  reason: GenerationCancelledEvent['reason'] = 'user',
  options: {
    runner?: WorkflowRunner;
    hookToken?: string;
  } = {},
): Promise<{ runId: string } | { skipped: true }> {
  if (options.hookToken === undefined) {
    return { skipped: true };
  }
  return publishGenerationCancelled(generationId, reason, {
    ...(options.runner !== undefined && { runner: options.runner }),
    hookToken: options.hookToken,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Validators (cheap, runtime-safe)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate the requested payload shape inline. We could pull in zod here, but
 * the publisher is invoked from the trigger API route which already does its
 * own zod validation upstream — this is a belt-and-suspenders check that the
 * shape didn't drift between layers.
 */
function validateRequestedPayload(p: GenerationRequestedEvent): void {
  // `notionRequestRowId` is intentionally NOT required — dashboard-originated
  // triggers pass an empty string because no Notion row exists yet (the
  // orchestrator creates one in the Shipper step). Webhook-originated calls
  // do populate it. Keep the type as `string` (not optional) so callers must
  // make a conscious decision about whether to pass empty or not.
  const required = [
    'generationId',
    'workspaceId',
    'notionWorkspaceId',
    'userId',
    'userEmail',
    'description',
    'descriptionHash',
    'buildLogBlockId',
  ] as const;
  for (const key of required) {
    const value = (p as unknown as Record<string, unknown>)[key];
    if (value === undefined || value === null || value === '') {
      throw new Error(
        `publishGenerationRequested: payload missing required field '${key}'`,
      );
    }
  }
  if (p.descriptionHash.length !== 64) {
    throw new Error(
      `publishGenerationRequested: descriptionHash must be 64 hex chars (got ${p.descriptionHash.length})`,
    );
  }
}
