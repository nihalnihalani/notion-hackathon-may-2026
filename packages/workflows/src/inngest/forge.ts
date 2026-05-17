/**
 * Inngest backup variant of the Forge generation workflow.
 *
 * Same step graph, same DB writes, same Notion log entries as `forge.ts`.
 * Built but NOT registered unless `process.env.FORGE_USE_INNGEST === 'true'`
 * (PLAN.md §II — "battle-tested pivot if WDK has rough edges").
 *
 * Architecture notes:
 *
 *  - We dynamic-import `inngest` so this module compiles without the package
 *    installed. `inngest` is a peer dependency.
 *
 *  - The Inngest `step.run()` primitive is the analogue of Vercel WDK's
 *    `'use step'` — each call is checkpointed and idempotent on the
 *    framework side. We reuse the same step-handler functions from
 *    `step-handlers.ts` so both runtimes execute byte-identical code paths.
 *
 *  - Concurrency: Inngest supports `concurrency: { key, limit }` natively
 *    on the function config — we apply the 3-per-workspace cap inline.
 *
 *  - Cancellation: Inngest's `cancelOn: [{ event, match }]` clause registers
 *    a cancellation listener; when the matching event arrives the function
 *    is killed mid-step. Inngest does NOT call `finally` in the user's
 *    handler on cancellation, so our DB cleanup happens in a paired
 *    `forge-generation-on-cancel` function (defined below) that listens
 *    for the cancellation event and writes the `cancelled` row.
 *
 *  - The factory accepts the Inngest client and our `WorkflowConfig` once
 *    and returns the function definitions. The host's Inngest server
 *    consumes both via `serve({ functions: [...] })`.
 */

import { noopLogger } from '@forge/agents';
import type { SandboxRunner, ToolCoderOutput } from '@forge/agents';

import {
  CostBudgetExceededError,
  FORGE_CANCELLATION_EVENT,
  FORGE_GENERATION_CONCURRENCY_LIMIT,
  FORGE_WORKFLOW_NAME,
  GenerationCancelledError,
  InspectorRetryExhaustedError,
  NeedsClarificationError,
} from '../forge.js';
import { costExceedsBudget, sumGenerationCost } from '../cost-accounting.js';
import { checkExistingGeneration, DEFAULT_IDEMPOTENCY_WINDOW_MS } from '../idempotency.js';
import { applyQueuedDefaultModel } from '../model-selection.js';
import {
  discoverContext,
  runInspector,
  runSchemaSmith,
  runShipper,
  runToolCoder,
} from '../step-handlers.js';
import type { GenerationRequestedEvent, WorkflowConfig, WorkflowSuccess } from '../types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Inngest client interface (structural; the real client comes from `inngest`)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Structural slice of the Inngest client we depend on. Lets us avoid pulling
 * `inngest` into the type system when the feature flag is off.
 */
export interface InngestClientLike {
  createFunction(
    options: InngestFunctionOptions,
    trigger: InngestTrigger | InngestTrigger[],
    handler: (ctx: InngestHandlerContext) => Promise<unknown>,
    ...rest: unknown[]
  ): unknown;
  send(event: { name: string; data: unknown }): Promise<unknown>;
}

export interface InngestFunctionOptions {
  id: string;
  name?: string;
  concurrency?: { key: string; limit: number } | number;
  retries?: number;
  cancelOn?: { event: string; match: string; timeout?: string }[];
}

export interface InngestTrigger {
  event?: string;
  cron?: string;
}

export interface InngestHandlerContext {
  event: { name: string; data: unknown };
  step: {
    run<T>(id: string, fn: () => Promise<T>): Promise<T>;
    sleep(id: string, duration: string): Promise<void>;
    waitForEvent(
      id: string,
      opts: { event: string; match: string; timeout: string },
    ): Promise<unknown>;
  };
  logger?: {
    info: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  attempt?: number;
  runId?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the Inngest function definitions for Forge. Call from the host's
 * Inngest setup like:
 *
 *   const fns = createForgeInngestFunctions({ inngest, config });
 *   if (process.env.FORGE_USE_INNGEST === 'true') {
 *     await serve({ client: inngest, functions: Object.values(fns) });
 *   }
 *
 * Returns `null` (instead of throwing) when the flag is off — that keeps the
 * call site clean: `const fns = createForgeInngestFunctions(...); if (fns) ...`.
 */
export function createForgeInngestFunctions(args: {
  inngest: InngestClientLike;
  config: WorkflowConfig;
  /** Optional override — defaults to `process.env.FORGE_USE_INNGEST === 'true'`. */
  enabled?: boolean;
}): {
  generation: unknown;
  onCancel: unknown;
} | null {
  const enabled = args.enabled ?? process.env['FORGE_USE_INNGEST'] === 'true';
  if (!enabled) return null;

  const { inngest, config } = args;

  // Main generation function.
  const generation = inngest.createFunction(
    {
      id: FORGE_WORKFLOW_NAME,
      name: 'Forge Generation (Inngest backup)',
      concurrency: {
        key: 'event.data.workspaceId',
        limit: FORGE_GENERATION_CONCURRENCY_LIMIT,
      },
      // Inngest-level retries — keep small; our sub-agents have their own
      // retries and we don't want to amplify duplicate spend.
      retries: 0,
      cancelOn: [
        {
          event: FORGE_CANCELLATION_EVENT,
          match: 'data.generationId',
          timeout: '15m',
        },
      ],
    },
    { event: `forge/generation.requested` },
    async (ctx) => {
      const event = ctx.event.data as GenerationRequestedEvent;
      return runForgeOnInngest({ event, ctx, config });
    },
  );

  // Cancellation cleanup function — Inngest doesn't run the main handler's
  // `finally` block when it cancels, so we listen for the cancellation event
  // separately and update the DB row.
  const onCancel = inngest.createFunction(
    {
      id: `${FORGE_WORKFLOW_NAME}-on-cancel`,
      name: 'Forge Generation Cancellation Cleanup',
    },
    { event: FORGE_CANCELLATION_EVENT },
    async (ctx) => {
      const { generationId, reason } = ctx.event.data as {
        generationId: string;
        reason: 'user' | 'timeout' | 'admin';
      };
      await ctx.step.run('mark-cancelled', async () => {
        await config.db.updateGenerationStatus(generationId, {
          status: 'cancelled',
          completedAt: new Date(),
        });
      });
      config.posthog?.capture({
        distinctId: generationId,
        event: 'forge.generation.cancelled',
        properties: { generationId, reason, source: 'inngest-cancel-listener' },
      });
      return { generationId, reason };
    },
  );

  return { generation, onCancel };
}

// ─────────────────────────────────────────────────────────────────────────────
// Inngest-flavored workflow body
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Same logic as `runForgeGeneration` in `forge.ts`, but every step body is
 * wrapped in `ctx.step.run(id, fn)` so Inngest can checkpoint between
 * boundaries. Step IDs MUST be deterministic per-attempt so Inngest's replay
 * machinery finds the right checkpoint after a crash — we encode attempt
 * counts into the IDs (e.g. `tool-coder-1`, `tool-coder-2`).
 */
async function runForgeOnInngest(args: {
  event: GenerationRequestedEvent;
  ctx: InngestHandlerContext;
  config: WorkflowConfig;
}): Promise<WorkflowSuccess> {
  const { event, ctx } = args;
  const config = applyQueuedDefaultModel(args.config, event);
  const logger = config.logger ?? noopLogger;
  const startedAt = Date.now();
  let sandbox: SandboxRunner | undefined;

  try {
    let totalCostUsd = 0;

    // ── 0. Idempotency ────────────────────────────────────────────────────
    const idempotency = await ctx.step.run('idempotency-check', async () =>
      checkExistingGeneration(config.db, {
        workspaceId: event.workspaceId,
        descriptionHash: event.descriptionHash,
        ...(event.force !== undefined && { force: event.force }),
        windowMs: config.idempotencyWindowMs ?? DEFAULT_IDEMPOTENCY_WINDOW_MS,
      }),
    );

    if (idempotency.hit) {
      await ctx.step.run('cache-hit-finalize', async () => {
        await config.db.updateGenerationStatus(event.generationId, {
          status: 'succeeded',
          agentId: idempotency.generation.agentId,
          completedAt: new Date(),
          totalLatencyMs: 0,
          totalCostUsd: 0,
        });
      });
      config.posthog?.capture({
        distinctId: event.userId,
        event: 'forge.generation.cache_hit',
        properties: {
          generationId: event.generationId,
          cachedGenerationId: idempotency.generation.id,
        },
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

    await ctx.step.run('mark-running', async () => {
      await config.db.updateGenerationStatus(event.generationId, {
        status: 'running',
      });
    });

    // ── 1. Discover context ────────────────────────────────────────────────
    const discovered = await ctx.step.run('discover-context', async () =>
      discoverContext({
        workspaceId: event.workspaceId,
        buildLogBlockId: event.buildLogBlockId,
        config,
      }),
    );

    // ── 2. Schema Smith ────────────────────────────────────────────────────
    const schemaResult = await ctx.step.run('schema-smith', async () =>
      runSchemaSmith({
        generationId: event.generationId,
        description: event.description,
        workspaceContext: discovered.schemaSmithContext,
        buildLogBlockId: event.buildLogBlockId,
        attempt: 1,
        config,
      }),
    );

    if (schemaResult.output.pattern === null) {
      await ctx.step.run('post-clarification', async () => {
        try {
          await config.notion.postClarificationComment(
            event.notionRequestRowId,
            schemaResult.output.rationale,
          );
        } catch (error) {
          logger.error('inngest.clarification.failed', {
            err: error instanceof Error ? error.message : String(error),
          });
        }
      });
      throw new NeedsClarificationError(schemaResult.output.rationale);
    }

    totalCostUsd = roundCost(totalCostUsd + schemaResult.costUsd);
    checkBudget(config, totalCostUsd);

    // ── 3+4. Sandbox + Tool Coder ↔ Inspector ──────────────────────────────
    sandbox = await ctx.step.run('sandbox-create', async () =>
      config.sandbox.create({
        generationId: event.generationId,
        workspaceId: event.workspaceId,
      }),
    );

    let toolCoderAttempt = 1;
    let prevErrors: readonly string[] | undefined;
    let currentCode: ToolCoderOutput | undefined;
    let lastInspector: Awaited<ReturnType<typeof runInspector>> | undefined;

    while (toolCoderAttempt <= 2) {
      const toolResult = await ctx.step.run(`tool-coder-${toolCoderAttempt}`, async () =>
        runToolCoder({
          generationId: event.generationId,
          description: event.description,
          schema: schemaResult.output,
          prevErrors,
          buildLogBlockId: event.buildLogBlockId,
          attempt: toolCoderAttempt,
          config,
        }),
      );
      currentCode = toolResult.output;
      totalCostUsd = roundCost(totalCostUsd + toolResult.costUsd);
      checkBudget(config, totalCostUsd);

      const inspectorResult = await ctx.step.run(`inspector-${toolCoderAttempt}`, async () => {
        if (sandbox === undefined) {
          throw new Error('inngest invariant: sandbox missing before Inspector');
        }
        const code = currentCode;
        if (code === undefined) {
          throw new Error('inngest invariant: code missing before Inspector');
        }
        return runInspector({
          generationId: event.generationId,
          code,
          schema: schemaResult.output,
          buildLogBlockId: event.buildLogBlockId,
          attempt: toolCoderAttempt,
          config,
          sandbox,
        });
      });
      lastInspector = inspectorResult;

      if (inspectorResult.output.pass) break;
      if (toolCoderAttempt < 2) {
        prevErrors = inspectorResult.output.errors;
      }
      toolCoderAttempt++;
    }

    if (!lastInspector?.output.pass) {
      throw new InspectorRetryExhaustedError(
        `Inspector failed after 2 Tool Coder attempts`,
        lastInspector?.output.errors ?? [],
        lastInspector?.output.stage ?? 'unknown',
      );
    }
    if (currentCode === undefined) {
      throw new Error('inngest invariant: currentCode missing after Inspector pass');
    }

    // ── 5. Shipper ─────────────────────────────────────────────────────────
    const shipResult = await ctx.step.run('shipper', async () => {
      if (sandbox === undefined) {
        throw new Error('inngest invariant: sandbox missing before Shipper');
      }
      return runShipper({
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
    });

    // ── 6. Finalize ────────────────────────────────────────────────────────
    return await ctx.step.run('finalize', async () => {
      const totalLatencyMs = Date.now() - startedAt;
      await config.db.updateGenerationStatus(event.generationId, {
        status: 'succeeded',
        pattern: schemaResult.output.pattern,
        agentId: shipResult.output.generatedAgentId,
        completedAt: new Date(),
        totalLatencyMs,
        totalCostUsd,
      });
      config.posthog?.capture({
        distinctId: event.userId,
        event: 'forge.generation.completed',
        properties: {
          generationId: event.generationId,
          workspaceId: event.workspaceId,
          pattern: schemaResult.output.pattern,
          deployUrl: shipResult.output.deployUrl,
          customAgentId: shipResult.output.customAgentId,
          generatedAgentId: shipResult.output.generatedAgentId,
          totalLatencyMs,
        },
      });
      // Email send removed — the Shipper sub-agent (see
      // packages/agents/src/shipper.ts Step 12) already sends the
      // deploy-success email atomically with the wire-up. Sending again
      // here caused duplicate notifications. If a workflow-level digest
      // ever becomes desirable, route it through the Shipper's email
      // config or add a dedicated `emailDigest` flag.
      return {
        generationId: event.generationId,
        status: 'succeeded' as const,
        agentId: shipResult.output.generatedAgentId,
        generatedAgentId: shipResult.output.generatedAgentId,
        customAgentId: shipResult.output.customAgentId,
        deployUrl: shipResult.output.deployUrl,
        totalCostUsd,
        totalLatencyMs,
        cacheHit: false,
      };
    });
  } catch (error) {
    // Mark terminal status. The on-cancel function handles the cancellation
    // case independently — if we got here with GenerationCancelledError we
    // still mark cancelled for consistency.
    const totalLatencyMs = Date.now() - startedAt;
    try {
      await (error instanceof GenerationCancelledError
        ? config.db.updateGenerationStatus(event.generationId, {
            status: 'cancelled',
            completedAt: new Date(),
            totalLatencyMs,
          })
        : config.db.updateGenerationStatus(event.generationId, {
            status: 'failed',
            completedAt: new Date(),
            totalLatencyMs,
          }));
    } catch (error_) {
      logger.error('inngest.finalize-failure.write-failed', {
        err: error_ instanceof Error ? error_.message : String(error_),
        originalErr: error instanceof Error ? error.message : String(error),
      });
    }
    // PostHog
    const posthogEvent =
      error instanceof NeedsClarificationError
        ? 'forge.generation.needs_clarification'
        : 'forge.generation.failed';
    config.posthog?.capture({
      distinctId: event.userId,
      event: posthogEvent,
      properties: {
        generationId: event.generationId,
        reason: error instanceof Error ? error.name : 'unknown',
        message: error instanceof Error ? error.message : String(error),
      },
    });
    throw error;
  } finally {
    if (sandbox !== undefined) {
      try {
        await sandbox.close();
      } catch (error) {
        logger.error('inngest.sandbox.close-failed', {
          err: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers (mirror forge.ts)
// ─────────────────────────────────────────────────────────────────────────────

function checkBudget(config: WorkflowConfig, current: number): void {
  const budget = config.totalCostBudgetUsd;
  if (budget === undefined || budget <= 0) return;
  if (costExceedsBudget(current, budget)) {
    throw new CostBudgetExceededError(current, budget);
  }
}

function roundCost(n: number): number {
  return sumGenerationCost([{ costUsd: n } as never]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Test seam: expose the runner directly so test code can drive it without
// standing up a real Inngest client.
// ─────────────────────────────────────────────────────────────────────────────

export { runForgeOnInngest };
