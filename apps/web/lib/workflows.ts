/**
 * Workflow trigger shim.
 *
 * Declares the typed contract that `apps/web/app/api/forge/*` expects from
 * `@forge/workflows/triggers`. Until the Workflow Engineer ships that module
 * we import it dynamically and validate the surface at runtime; this isolates
 * the API agent from the workflow-package build cycle without weakening
 * type-safety in route handlers.
 *
 * Contract (mirrors PLAN §VI + §VIII):
 *
 *   publishGenerationRequested({
 *     generationId,
 *     workspaceId,
 *     userId,
 *     description,
 *     descriptionHash,
 *   })  → Promise<{ workflowRunId: string }>
 *
 *   cancelInflight(generationId) → Promise<{ cancelled: boolean }>
 *
 * Once `@forge/workflows/triggers` is published these wrappers become a thin
 * re-export. They exist today so route handlers compile + tests can mock the
 * `apps/web/lib/workflows.ts` module rather than the workspace package.
 */

export interface GenerationRequestedEvent {
  generationId: string;
  workspaceId: string;
  /** Internal `User.id` (not Clerk userId). */
  userId: string;
  description: string;
  descriptionHash: string;
}

export interface GenerationRequestedResult {
  /** Vercel Workflow run id (or Inngest run id under the backup variant). */
  workflowRunId: string;
}

export interface CancelInflightResult {
  cancelled: boolean;
}

interface WorkflowsTriggersModule {
  publishGenerationRequested: (
    e: GenerationRequestedEvent,
  ) => Promise<GenerationRequestedResult>;
  cancelInflight: (generationId: string) => Promise<CancelInflightResult>;
}

let cachedModule: WorkflowsTriggersModule | null = null;

/**
 * Resolve `@forge/workflows/triggers` once per cold-start. We use a dynamic
 * import (not a static `import`) so a build can succeed even if the workspace
 * package has not yet been compiled — typical during a fresh clone before
 * `pnpm -r build`. Resolution failures surface as a 502 from the route
 * (signaled via thrown Error) and Sentry will alert.
 */
async function getTriggers(): Promise<WorkflowsTriggersModule> {
  if (cachedModule) return cachedModule;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod: any = await import('@forge/workflows/triggers');
  if (
    typeof mod.publishGenerationRequested !== 'function' ||
    typeof mod.cancelInflight !== 'function'
  ) {
    throw new Error(
      '@forge/workflows/triggers does not export the required functions. ' +
        'Expected: publishGenerationRequested, cancelInflight.',
    );
  }
  cachedModule = {
    publishGenerationRequested: mod.publishGenerationRequested,
    cancelInflight: mod.cancelInflight,
  };
  return cachedModule;
}

export async function publishGenerationRequested(
  e: GenerationRequestedEvent,
): Promise<GenerationRequestedResult> {
  const m = await getTriggers();
  return m.publishGenerationRequested(e);
}

export async function cancelInflight(
  generationId: string,
): Promise<CancelInflightResult> {
  const m = await getTriggers();
  return m.cancelInflight(generationId);
}

/** Test-only — clear the dynamic-import cache so vitest can stub it. */
export function __resetForTests(): void {
  cachedModule = null;
}
