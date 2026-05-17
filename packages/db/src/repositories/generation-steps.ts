/**
 * GenerationStep repository — append-style writer for the per-agent step
 * trail that powers the Build Log and post-mortem debugging.
 *
 * Each `(generationId, agent, attempt)` triple is a row. Retries get a new
 * row with `attempt = attempt + 1`; we never mutate prior attempts so the
 * Build Log is fully replayable.
 */

import { prisma } from "../client.js";
import type {
  AgentName,
  GenerationStep,
  Prisma,
  StepStatus,
} from "../types.js";

/**
 * Insert a new step or finalize an existing one.
 *
 * If `id` is omitted we create a new step (the typical "step started" call).
 * If `id` is provided we update that row in place — used by the orchestrator
 * to write final tokens/cost/output when a step completes.
 */
export async function recordStep(
  step:
    | {
        kind: "start";
        generationId: string;
        agent: AgentName;
        attempt: number;
        modelUsed?: string | null;
        inputJson: Prisma.InputJsonValue;
      }
    | {
        kind: "finish";
        id: string;
        status: StepStatus;
        promptTokens?: number | null;
        completionTokens?: number | null;
        cacheReadTokens?: number | null;
        cacheWriteTokens?: number | null;
        costUsd?: Prisma.Decimal | number | null;
        outputJson?: Prisma.InputJsonValue | null;
        errorJson?: Prisma.InputJsonValue | null;
        latencyMs?: number | null;
        completedAt?: Date | null;
      },
): Promise<GenerationStep> {
  if (step.kind === "start") {
    return prisma.generationStep.create({
      data: {
        generationId: step.generationId,
        agent: step.agent,
        attempt: step.attempt,
        status: "running",
        modelUsed: step.modelUsed ?? null,
        inputJson: step.inputJson,
      },
    });
  }

  return prisma.generationStep.update({
    where: { id: step.id },
    data: {
      status: step.status,
      ...(step.promptTokens !== undefined && {
        promptTokens: step.promptTokens,
      }),
      ...(step.completionTokens !== undefined && {
        completionTokens: step.completionTokens,
      }),
      ...(step.cacheReadTokens !== undefined && {
        cacheReadTokens: step.cacheReadTokens,
      }),
      ...(step.cacheWriteTokens !== undefined && {
        cacheWriteTokens: step.cacheWriteTokens,
      }),
      ...(step.costUsd !== undefined && { costUsd: step.costUsd }),
      ...(step.outputJson !== undefined &&
        step.outputJson !== null && { outputJson: step.outputJson }),
      ...(step.errorJson !== undefined &&
        step.errorJson !== null && { errorJson: step.errorJson }),
      ...(step.latencyMs !== undefined && { latencyMs: step.latencyMs }),
      completedAt: step.completedAt ?? new Date(),
    },
  });
}

/**
 * List every step for a generation in insertion order.
 * Used by the Build Log SSR and by the orchestrator's resume logic.
 */
export async function listStepsForGeneration(
  generationId: string,
): Promise<GenerationStep[]> {
  return prisma.generationStep.findMany({
    where: { generationId },
    orderBy: [{ startedAt: "asc" }, { attempt: "asc" }],
  });
}
