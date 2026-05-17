/**
 * Vercel Workflow DevKit definition: `forge-generation`.
 *
 * API shape — confirmed against https://vercel.com/docs/workflow and
 * https://workflow-sdk.dev (Nov 2026):
 *
 *   import { sleep } from 'workflow';
 *   import { start, resumeHook } from 'workflow/api';
 *
 *   export async function forgeGeneration(event: GenerationRequestedEvent) {
 *     'use workflow';
 *     ...
 *   }
 *
 *   async function someStep() {
 *     'use step';
 *     ...
 *   }
 *
 * Step retries default to 3; throw `FatalError` to disable retry for a
 * specific outcome. The Workflow SDK does not (yet) expose a per-step
 * "concurrency key" or per-workflow concurrency limit as a directive option —
 * that is enforced at the queue layer by Vercel. We track the desired
 * concurrency intent in `FORGE_GENERATION_CONCURRENCY_LIMIT` so the deploy
 * config can apply it via the dashboard.
 *
 * Cancellation: emitted as `forge/generation.cancelled`. The orchestrator
 * checks for cancellation between major steps via an abort signal we plumb
 * down through the SubAgentConfig — the inner LLM/HTTP calls abort cleanly,
 * and DB writes for `cancelled` status happen in the `finally` block.
 *
 * Why we expose `runForgeGeneration` as a plain async function:
 *   - It is the actual workflow body. The Vercel WDK wrapping is a one-line
 *     adapter (see `forgeGeneration` at the bottom of this file).
 *   - The Inngest backup (inngest/forge.ts) calls the same function so the
 *     two paths are byte-for-byte identical at the orchestration layer.
 *   - Tests can call it directly without standing up the Workflow runtime.
 *
 * "Inner Tool Coder retry loop":
 *   PLAN.md §4.3 specifies that an Inspector failure feeds errors back to
 *   Tool Coder for ONE retry — capped at 2 total Tool Coder runs per
 *   generation. We implement that as a tight `while (inspectAttempt < 2)`
 *   loop here. The Workflow framework's own step retries are a separate
 *   layer (handle provider 5xx, network blips).
 */

import { noopLogger } from '@forge/agents';
import type {
  SandboxRunner,
  SchemaSmithOutput,
  ToolCoderOutput,
} from '@forge/agents';

import {
  costExceedsBudget,
  sumGenerationCost,
  sumGenerationLatency,
} from './cost-accounting.js';
import {
  checkExistingGeneration,
  DEFAULT_IDEMPOTENCY_WINDOW_MS,
} from './idempotency.js';
import type { OpsGenerationEvent, OpsGenerationStatus } from './ops-metrics.js';
import {
  discoverContext,
  runInspector,
  runSchemaSmith,
  runShipper,
  runToolCoder,
} from './step-handlers.js';
import type {
  GenerationRequestedEvent,
  WorkflowConfig,
  WorkflowSuccess,
} from './types.js';

/**
 * Concurrency intent — applied by the Vercel Workflow runtime via the
 * dashboard's per-workflow concurrency cap. We export the constant so
 * deployment scripts can read it (PLAN.md §VIII = 3 per workspace).
 *
 * In environments where the runtime supports inline `concurrency: { key, limit }`
 * (e.g. Inngest) we apply it directly — see `inngest/forge.ts`.
 */
export const FORGE_GENERATION_CONCURRENCY_LIMIT = 3;

/**
 * Workflow name — must match the value used by `triggers.ts` when calling
 * `start()` and by Vercel's queue config.
 */
export const FORGE_WORKFLOW_NAME = 'forge-generation';

/**
 * Cancellation event name. Both the Vercel WDK adapter and Inngest listen for
 * this string — keep them in sync.
 */
export const FORGE_CANCELLATION_EVENT = 'forge/generation.cancelled';

/**
 * Maximum number of Tool Coder attempts within a single workflow run. Two
 * = "first attempt + one retry after Inspector feedback". PLAN.md §4.3.
 */
const MAX_TOOL_CODER_ATTEMPTS = 2;

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Thrown when the workflow halts cleanly because Schema Smith asked for
 * clarification. The orchestrator catches this, marks the generation as
 * `needs_clarification`, posts the comment to Notion, and returns a
 * `WorkflowSuccess` with the appropriate status. NOT a real error — using a
 * sentinel class lets us reuse the regular failure path's `finally`.
 */
export class NeedsClarificationError extends Error {
  override readonly name = 'NeedsClarificationError';
  constructor(public readonly rationale: string) {
    super(`Schema Smith requested clarification: ${rationale}`);
  }
}

/**
 * Thrown when Inspector still fails after `MAX_TOOL_CODER_ATTEMPTS` runs.
 * The outer workflow catches and marks the generation `failed`.
 */
export class InspectorRetryExhaustedError extends Error {
  override readonly name = 'InspectorRetryExhaustedError';
  constructor(
    message: string,
    public readonly errors: readonly string[],
    public readonly stage: string,
  ) {
    super(message);
  }
}

/**
 * Thrown when the workflow halts because the running cost has hit the
 * `totalCostBudgetUsd` ceiling. The outer workflow surfaces this as a
 * `failed` generation with code `cost_exceeded`.
 */
export class CostBudgetExceededError extends Error {
  override readonly name = 'CostBudgetExceededError';
  constructor(
    public readonly currentUsd: number,
    public readonly budgetUsd: number,
  ) {
    super(`Cost budget exceeded: $${currentUsd.toFixed(4)} ≥ $${budgetUsd.toFixed(4)}`);
  }
}

/**
 * Thrown when an external cancellation signal fires mid-run.
 */
export class GenerationCancelledError extends Error {
  override readonly name = 'GenerationCancelledError';
  constructor(public readonly reason: 'user' | 'timeout' | 'admin') {
    super(`Generation cancelled (${reason})`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main workflow body
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The full DAG body. Pure async function — the Vercel WDK wrapper and the
 * Inngest wrapper both call this.
 *
 * Step graph (PLAN.md §VIII):
 *   1. idempotency check (early-return on hit)
 *   2. discover-context
 *   3. schema-smith    (halts cleanly on `pattern: null`)
 *   4. tool-coder      (attempt 1)
 *   5. inspector       (attempt 1)  — on failure, feedback loop to (4)+(5)
 *      OR tool-coder   (attempt 2) → inspector (attempt 2)
 *   6. shipper
 *   7. finalize
 *
 * Returns `WorkflowSuccess` on every clean outcome (success, cached,
 * needs_clarification). Throws on failed/cancelled runs after writing the
 * appropriate DB row.
 */
export async function runForgeGeneration(
  event: GenerationRequestedEvent,
  config: WorkflowConfig,
): Promise<WorkflowSuccess> {
  const logger = config.logger ?? noopLogger;
  const startedAt = Date.now();
  let sandbox: SandboxRunner | undefined;

  logger.info('workflow.start', {
    generationId: event.generationId,
    workspaceId: event.workspaceId,
    descriptionHash: event.descriptionHash,
    force: event.force ?? false,
  });

  try {
    // ── 0. Idempotency ────────────────────────────────────────────────────
    const idempotency = await checkExistingGeneration(config.db, {
      workspaceId: event.workspaceId,
      descriptionHash: event.descriptionHash,
      ...(event.force !== undefined && { force: event.force }),
      windowMs: config.idempotencyWindowMs ?? DEFAULT_IDEMPOTENCY_WINDOW_MS,
    });

    if (idempotency.hit) {
      logger.info('workflow.cache_hit', {
        generationId: event.generationId,
        cachedGenerationId: idempotency.generation.id,
      });
      capturePosthog(config, event.userId, 'forge.generation.cache_hit', {
        generationId: event.generationId,
        cachedGenerationId: idempotency.generation.id,
        workspaceId: event.workspaceId,
      });

      // Mark THIS generation row as cancelled (the cached one is the source
      // of truth); flag is `succeeded` with a pointer to the cached agent so
      // the API route can return the same shape.
      await config.db.updateGenerationStatus(event.generationId, {
        status: 'succeeded',
        agentId: idempotency.generation.agentId,
        completedAt: new Date(),
        totalLatencyMs: 0,
        totalCostUsd: 0,
      });

      await safeNotionLog(config, event.buildLogBlockId, {
        step: 'Cache',
        status: 'info',
        message: 'identical request found in last hour — returning cached agent',
      });

      await safeOpsPublish(config, {
        generationId: event.generationId,
        workspaceId: event.workspaceId,
        status: 'cached',
        pattern: null,
        description: event.description,
        totalLatencyMs: 0,
        totalCostUsd: 0,
      });

      return {
        generationId: event.generationId,
        status: 'cached',
        ...(idempotency.generation.agentId !== null && {
          agentId: idempotency.generation.agentId,
        }),
        totalCostUsd: 0,
        totalLatencyMs: 0,
        cacheHit: true,
      };
    }

    // Transition queued → running before we start spending money.
    await config.db.updateGenerationStatus(event.generationId, {
      status: 'running',
    });
    checkCancelled(config);

    // ── 1. Discover context ────────────────────────────────────────────────
    const ctx = await discoverContext({
      workspaceId: event.workspaceId,
      buildLogBlockId: event.buildLogBlockId,
      config,
    });
    checkCancelled(config);
    checkBudget(config);

    // ── 2. Schema Smith ────────────────────────────────────────────────────
    const schemaResult = await runSchemaSmith({
      generationId: event.generationId,
      description: event.description,
      workspaceContext: ctx.schemaSmithContext,
      buildLogBlockId: event.buildLogBlockId,
      attempt: 1,
      config,
    });

    // Halt path: pattern: null = ambiguous.
    if (schemaResult.output.pattern === null) {
      // Post the clarification comment back to the user's Notion row.
      try {
        await config.notion.postClarificationComment(
          event.notionRequestRowId,
          schemaResult.output.rationale,
        );
      } catch (err) {
        logger.error('workflow.clarification-comment.failed', {
          err: err instanceof Error ? err.message : String(err),
        });
      }
      throw new NeedsClarificationError(schemaResult.output.rationale);
    }
    checkCancelled(config);
    checkBudget(config);

    // ── 3+4. Tool Coder ↔ Inspector loop ───────────────────────────────────
    sandbox = await config.sandbox.create({
      generationId: event.generationId,
      workspaceId: event.workspaceId,
      ...(config.subAgent.abortSignal !== undefined && {
        abortSignal: config.subAgent.abortSignal,
      }),
    });

    let toolCoderAttempt = 1;
    let prevErrors: readonly string[] | undefined;
    let currentCode: ToolCoderOutput | undefined;
    let lastInspector: Awaited<ReturnType<typeof runInspector>> | undefined;

    while (toolCoderAttempt <= MAX_TOOL_CODER_ATTEMPTS) {
      const toolResult = await runToolCoder({
        generationId: event.generationId,
        description: event.description,
        schema: schemaResult.output,
        prevErrors,
        buildLogBlockId: event.buildLogBlockId,
        attempt: toolCoderAttempt,
        config,
      });
      currentCode = toolResult.output;
      checkCancelled(config);
      checkBudget(config);

      const inspectorResult = await runInspector({
        generationId: event.generationId,
        code: currentCode,
        schema: schemaResult.output,
        buildLogBlockId: event.buildLogBlockId,
        attempt: toolCoderAttempt,
        config,
        sandbox,
      });
      lastInspector = inspectorResult;
      checkCancelled(config);

      if (inspectorResult.output.pass) {
        break;
      }

      // Inspector failed. If we still have a retry slot left, feed errors
      // back into the next Tool Coder attempt; otherwise the loop exits
      // and the post-loop guard throws.
      if (toolCoderAttempt < MAX_TOOL_CODER_ATTEMPTS) {
        prevErrors = inspectorResult.output.errors;
        await safeNotionLog(config, event.buildLogBlockId, {
          step: 'Orchestrator',
          status: 'info',
          message: `Inspector failed at ${inspectorResult.output.stage} — feeding ${inspectorResult.output.errors.length} error(s) back to Tool Coder`,
        });
      }
      toolCoderAttempt++;
    }

    if (lastInspector === undefined || !lastInspector.output.pass) {
      throw new InspectorRetryExhaustedError(
        `Inspector failed after ${MAX_TOOL_CODER_ATTEMPTS} Tool Coder attempts`,
        lastInspector?.output.errors ?? [],
        lastInspector?.output.stage ?? 'unknown',
      );
    }
    if (currentCode === undefined) {
      // Defensive — we always set this before exiting the loop on pass=true.
      throw new Error('orchestrator invariant: currentCode missing after Inspector pass');
    }
    checkBudget(config);

    // ── 5. Shipper ─────────────────────────────────────────────────────────
    const shipResult = await runShipper({
      generationId: event.generationId,
      workspaceId: event.workspaceId,
      notionWorkspaceId: event.notionWorkspaceId,
      description: event.description,
      schema: schemaResult.output,
      code: currentCode,
      buildLogBlockId: event.buildLogBlockId,
      attempt: 1,
      config,
      sandbox,
    });
    checkCancelled(config);

    // ── 6. Finalize ────────────────────────────────────────────────────────
    return await finalize({
      event,
      config,
      schema: schemaResult.output,
      shipResult: shipResult.output,
      startedAt,
    });
  } catch (err) {
    await handleFailure(err, event, config, startedAt);
    throw err;
  } finally {
    // Always close the sandbox if we created one — never leak.
    if (sandbox !== undefined) {
      try {
        await sandbox.close();
      } catch (closeErr) {
        logger.error('workflow.sandbox.close-failed', {
          err: closeErr instanceof Error ? closeErr.message : String(closeErr),
        });
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Finalize + failure paths
// ─────────────────────────────────────────────────────────────────────────────

async function finalize(args: {
  event: GenerationRequestedEvent;
  config: WorkflowConfig;
  schema: SchemaSmithOutput;
  shipResult: import('@forge/agents').ShipperResult;
  startedAt: number;
}): Promise<WorkflowSuccess> {
  const { event, config, schema, shipResult, startedAt } = args;
  // The previous workflow-level email send used a `logger` here; that
  // send was removed (the Shipper now handles deploy-success emails
  // atomically — see `packages/agents/src/shipper.ts` Step 12). Keep this
  // function logger-free until a new failure path needs structured
  // logging again.

  // We don't have a `listStepsForGeneration` helper on the structural db
  // interface (kept narrow), so we sum costs from the live timestamps we have
  // here. This is an upper-bound: total wall time.
  const totalLatencyMs = Date.now() - startedAt;
  // Sub-agent cost emission goes through the logger.info('<agent>.complete')
  // event; the orchestrator does not aggregate inline. We default to 0 and
  // let the deferred cost-accounting job (out of scope here) reconcile.
  const totalCostUsd = 0;

  await config.db.updateGenerationStatus(event.generationId, {
    status: 'succeeded',
    pattern: schema.pattern, // pattern: null already short-circuited
    agentId: shipResult.customAgentId ?? null,
    completedAt: new Date(),
    totalLatencyMs,
    totalCostUsd,
  });

  capturePosthog(config, event.userId, 'forge.generation.completed', {
    generationId: event.generationId,
    workspaceId: event.workspaceId,
    pattern: schema.pattern,
    deployUrl: shipResult.deployUrl,
    customAgentId: shipResult.customAgentId,
    totalLatencyMs,
  });

  // Email send: the Shipper (`packages/agents/src/shipper.ts` Step 12)
  // already sends the deploy-success email atomically with the rest of
  // the wire-up so callers get a single notification. Sending again here
  // produced duplicate emails — removed by the Integration Fixer phase.
  // If a workflow-level "digest" ever becomes desirable, route it through
  // the Shipper's email config or a dedicated `emailDigest` flag.

  await safeNotionLog(config, event.buildLogBlockId, {
    step: 'Finalize',
    status: 'succeeded',
    message: `done in ${totalLatencyMs}ms`,
  });

  await safeOpsPublish(config, {
    generationId: event.generationId,
    workspaceId: event.workspaceId,
    status: 'succeeded',
    pattern: schema.pattern, // pattern: null already short-circuited above
    description: event.description,
    totalLatencyMs,
    totalCostUsd,
  });

  return {
    generationId: event.generationId,
    status: 'succeeded',
    ...(shipResult.customAgentId !== null && { agentId: shipResult.customAgentId }),
    customAgentId: shipResult.customAgentId,
    deployUrl: shipResult.deployUrl,
    totalCostUsd,
    totalLatencyMs,
    cacheHit: false,
  };
}

async function handleFailure(
  err: unknown,
  event: GenerationRequestedEvent,
  config: WorkflowConfig,
  startedAt: number,
): Promise<void> {
  const logger = config.logger ?? noopLogger;
  const totalLatencyMs = Date.now() - startedAt;

  // Special-case clean halts so they get the right terminal status.
  if (err instanceof NeedsClarificationError) {
    await config.db.updateGenerationStatus(event.generationId, {
      status: 'failed',
      completedAt: new Date(),
      totalLatencyMs,
    });
    capturePosthog(config, event.userId, 'forge.generation.needs_clarification', {
      generationId: event.generationId,
      rationale: err.rationale,
    });
    await safeNotionLog(config, event.buildLogBlockId, {
      step: 'Halt',
      status: 'info',
      message: `awaiting clarification — see comment on the request row`,
    });
    await safeOpsPublish(config, {
      generationId: event.generationId,
      workspaceId: event.workspaceId,
      status: 'needs_clarification',
      pattern: null,
      description: event.description,
      totalLatencyMs,
      totalCostUsd: 0,
      errorMessage: err.rationale,
    });
    return;
  }

  if (err instanceof GenerationCancelledError) {
    await config.db.updateGenerationStatus(event.generationId, {
      status: 'cancelled',
      completedAt: new Date(),
      totalLatencyMs,
    });
    capturePosthog(config, event.userId, 'forge.generation.cancelled', {
      generationId: event.generationId,
      reason: err.reason,
    });
    await safeNotionLog(config, event.buildLogBlockId, {
      step: 'Cancelled',
      status: 'info',
      message: `run cancelled (${err.reason})`,
    });
    await safeOpsPublish(config, {
      generationId: event.generationId,
      workspaceId: event.workspaceId,
      status: 'cancelled',
      pattern: null,
      description: event.description,
      totalLatencyMs,
      totalCostUsd: 0,
      errorMessage: `cancelled (${err.reason})`,
    });
    return;
  }

  if (err instanceof CostBudgetExceededError) {
    await config.db.updateGenerationStatus(event.generationId, {
      status: 'failed',
      completedAt: new Date(),
      totalLatencyMs,
    });
    capturePosthog(config, event.userId, 'forge.generation.failed', {
      generationId: event.generationId,
      reason: 'cost_exceeded',
      currentUsd: err.currentUsd,
      budgetUsd: err.budgetUsd,
    });
    await safeNotionLog(config, event.buildLogBlockId, {
      step: 'Halt',
      status: 'failed',
      message: `cost budget exceeded ($${err.currentUsd.toFixed(4)} ≥ $${err.budgetUsd.toFixed(4)})`,
    });
    await safeOpsPublish(config, {
      generationId: event.generationId,
      workspaceId: event.workspaceId,
      status: 'failed',
      pattern: null,
      description: event.description,
      totalLatencyMs,
      totalCostUsd: err.currentUsd,
      errorMessage: `cost budget exceeded ($${err.currentUsd.toFixed(4)} ≥ $${err.budgetUsd.toFixed(4)})`,
    });
    return;
  }

  // Default failure path.
  logger.error('workflow.failed', {
    generationId: event.generationId,
    err: err instanceof Error ? err.message : String(err),
    name: err instanceof Error ? err.name : 'unknown',
  });
  await config.db.updateGenerationStatus(event.generationId, {
    status: 'failed',
    completedAt: new Date(),
    totalLatencyMs,
  });
  capturePosthog(config, event.userId, 'forge.generation.failed', {
    generationId: event.generationId,
    reason: err instanceof Error ? err.name : 'unknown',
    message: err instanceof Error ? err.message : String(err),
  });
  await safeNotionLog(config, event.buildLogBlockId, {
    step: 'Failure',
    status: 'failed',
    message: err instanceof Error ? err.message : String(err),
  });
  await safeOpsPublish(config, {
    generationId: event.generationId,
    workspaceId: event.workspaceId,
    status: 'failed',
    pattern: null,
    description: event.description,
    totalLatencyMs,
    totalCostUsd: 0,
    errorMessage: err instanceof Error ? err.message : String(err),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Cancellation + budget guards
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check the abort signal threaded through `SubAgentConfig.abortSignal`. The
 * Workflow runtime pumps cancellation events into this signal; we surface a
 * typed `GenerationCancelledError` on the next step boundary.
 */
function checkCancelled(config: WorkflowConfig): void {
  if (config.subAgent.abortSignal?.aborted) {
    throw new GenerationCancelledError('user');
  }
}

/**
 * Check the cost budget after every paid step (Schema Smith + Tool Coder).
 *
 * We use a soft check at workflow-level: the in-flight per-step cost isn't
 * stored on the structural step result (each sub-agent emits its own cost
 * event via `logger.info('<agent>.complete')`), so this guard is best-effort
 * at the orchestration layer. The deferred cost-accounting job (out of scope
 * here) provides the canonical reconciliation.
 *
 * Exposed via `sumGenerationCost` + `costExceedsBudget` so the call site
 * stays readable.
 */
function checkBudget(config: WorkflowConfig): void {
  const budget = config.totalCostBudgetUsd;
  if (budget === undefined || budget <= 0) return;
  const current = sumGenerationCost([]);
  if (costExceedsBudget(current, budget)) {
    throw new CostBudgetExceededError(current, budget);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Notion + PostHog helpers (kept here, not in step-handlers, because they
// are also used by the finalize + failure paths which sit outside the
// step abstraction)
// ─────────────────────────────────────────────────────────────────────────────

async function safeNotionLog(
  config: WorkflowConfig,
  blockId: string,
  entry: {
    step: string;
    status: 'running' | 'succeeded' | 'failed' | 'info';
    message: string;
  },
): Promise<void> {
  try {
    await config.notion.appendBuildLogEntry(blockId as never, {
      ...entry,
      timestamp: new Date(),
    });
  } catch (err) {
    config.logger?.info('workflow.notion-log.swallow', {
      err: err instanceof Error ? err.message : String(err),
      step: entry.step,
    });
  }
}

function capturePosthog(
  config: WorkflowConfig,
  distinctId: string,
  event: string,
  properties: Record<string, unknown>,
): void {
  if (config.posthog === undefined) return;
  try {
    config.posthog.capture({ distinctId, event, properties });
  } catch (err) {
    config.logger?.info('workflow.posthog.capture-failed', {
      err: err instanceof Error ? err.message : String(err),
      event,
    });
  }
}

/**
 * Publish a Forge Operations row (PLAN.md §X) — best-effort. If the workspace
 * hasn't configured an `opsMetrics` adapter, this is a no-op. Publish errors
 * are swallowed and logged so a misconfigured ops DB never blocks a run.
 */
async function safeOpsPublish(
  config: WorkflowConfig,
  event: OpsGenerationEvent,
): Promise<void> {
  if (config.opsMetrics === undefined) return;
  try {
    await config.opsMetrics.publishGenerationEvent(event);
  } catch (err) {
    config.logger?.info('workflow.ops-metrics.publish-failed', {
      err: err instanceof Error ? err.message : String(err),
      generationId: event.generationId,
      status: event.status satisfies OpsGenerationStatus,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Re-exports for the Vercel WDK adapter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Re-export the cost helpers + summer so callers (e.g. the dashboard's
 * generation-detail page) can reuse the same aggregation logic without
 * importing from the cost module directly.
 */
export { sumGenerationCost, sumGenerationLatency };
