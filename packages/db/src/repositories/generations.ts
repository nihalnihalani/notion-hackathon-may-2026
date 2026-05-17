/**
 * Generation repository — typed query helpers for the `Generation` model.
 *
 * Spec: PLAN.md Part V (Generation), Part VI (idempotency window = 1h).
 */

import { prisma } from "../client.js";
import type {
  AgentPattern,
  Generation,
  GenerationStatus,
  GenerationStep,
  Prisma,
} from "../types.js";

/**
 * Insert a new Generation in `queued` status.
 *
 * The orchestrator immediately follows this with a workflow dispatch; the
 * status moves to `running` when the first step starts.
 */
export async function createGeneration(input: {
  workspaceId: string;
  userId: string;
  notionRowId: string;
  description: string;
  descriptionHash: string;
}): Promise<Generation> {
  return prisma.generation.create({
    data: {
      workspaceId: input.workspaceId,
      userId: input.userId,
      notionRowId: input.notionRowId,
      description: input.description,
      descriptionHash: input.descriptionHash,
      status: "queued",
    },
  });
}

/**
 * Transition a Generation's status and (optionally) attach a deployed agent
 * id + finalize timing/cost columns.
 *
 * Pass `completedAt: new Date()` (or omit and we'll default it) on terminal
 * transitions (`succeeded`, `failed`, `cancelled`).
 */
export async function updateGenerationStatus(
  id: string,
  patch: {
    status: GenerationStatus;
    pattern?: AgentPattern | null;
    agentId?: string | null;
    completedAt?: Date | null;
    totalLatencyMs?: number | null;
    totalCostUsd?: Prisma.Decimal | number | null;
  },
): Promise<Generation> {
  const isTerminal =
    patch.status === "succeeded" ||
    patch.status === "failed" ||
    patch.status === "cancelled";

  return prisma.generation.update({
    where: { id },
    data: {
      status: patch.status,
      ...(patch.pattern !== undefined && { pattern: patch.pattern }),
      ...(patch.agentId !== undefined && { agentId: patch.agentId }),
      ...(patch.totalLatencyMs !== undefined && {
        totalLatencyMs: patch.totalLatencyMs,
      }),
      ...(patch.totalCostUsd !== undefined && {
        totalCostUsd: patch.totalCostUsd,
      }),
      // Default completedAt on terminal states if caller didn't specify.
      ...(patch.completedAt !== undefined
        ? { completedAt: patch.completedAt }
        : isTerminal
          ? { completedAt: new Date() }
          : {}),
    },
  });
}

/**
 * Find the most recent successful Generation for the given
 * `(workspaceId, descriptionHash)` within the idempotency window.
 *
 * Used by `/api/forge/trigger` to short-circuit re-deploys: if the same user
 * asks for the same agent within `windowMs` (default 1h per PLAN.md Part VI),
 * we return the cached GeneratedAgent instead of running the pipeline again.
 *
 * Returns `null` when there is no eligible row.
 */
export async function findRecentByHash(
  workspaceId: string,
  descriptionHash: string,
  windowMs: number = 60 * 60 * 1000,
): Promise<Generation | null> {
  const since = new Date(Date.now() - windowMs);
  return prisma.generation.findFirst({
    where: {
      workspaceId,
      descriptionHash,
      status: "succeeded",
      completedAt: { gte: since },
    },
    orderBy: { completedAt: "desc" },
  });
}

/**
 * Generation with its ordered step trail. Used by the dashboard
 * `/generations/:id` page and by the orchestrator when resuming after a
 * crash.
 */
export async function getGenerationWithSteps(id: string): Promise<
  | (Generation & {
      steps: GenerationStep[];
    })
  | null
> {
  return prisma.generation.findUnique({
    where: { id },
    include: {
      steps: { orderBy: { startedAt: "asc" } },
    },
  });
}
