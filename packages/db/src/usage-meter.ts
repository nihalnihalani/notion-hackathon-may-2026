/**
 * Daily usage meter helpers.
 *
 * Bucketing strategy: one row per `(workspaceId, date)`. The `date` column is
 * a SQL `DATE` (no time component) — we normalize incoming `Date` values to
 * UTC midnight before upserting. Using UTC avoids the well-known pitfall
 * where local-timezone bucketing creates duplicate rows for the same calendar
 * day depending on the server's region.
 *
 * Concurrency: we use Prisma `$transaction` with the `upsert + increment`
 * pattern, which serializes through the unique constraint on
 * `(workspaceId, date)`. Under concurrent writes Postgres will pick a winner
 * for the insert and the loser falls into the `update` branch, where
 * `increment` is applied atomically.
 */

import { z } from "zod";

import { prisma } from "./client.js";
import type { UsageMeterAggregate, UsageMeterFields } from "./types.js";

const fieldsSchema = z
  .object({
    generationsCount: z.number().int().nonnegative().optional(),
    deploysCount: z.number().int().nonnegative().optional(),
    invocationsCount: z.number().int().nonnegative().optional(),
    totalLlmCostUsd: z.number().nonnegative().optional(),
    totalSandboxSeconds: z.number().int().nonnegative().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: "recordUsage called with no fields to increment",
  });

/**
 * Truncate a Date to UTC midnight of the same calendar day. Returns a fresh
 * Date — does not mutate the input.
 */
function toUtcMidnight(d: Date): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
}

/**
 * Increment today's usage counters for `workspaceId`. Creates today's row if
 * it does not exist.
 *
 * "Today" is computed against the *server's* current UTC time at call time.
 * If you need to backfill (e.g. a delayed worker), pass `at` to override.
 */
export async function recordUsage(
  workspaceId: string,
  fields: UsageMeterFields,
  at: Date = new Date(),
): Promise<void> {
  const parsed = fieldsSchema.parse(fields);
  const date = toUtcMidnight(at);

  // The `upsert` itself is one round-trip; wrapping it in `$transaction`
  // doesn't add a round-trip but does ensure that if we later add additional
  // writes (e.g. a "today's cap exceeded" event) they all commit atomically.
  await prisma.$transaction([
    prisma.usageMeter.upsert({
      where: { workspaceId_date: { workspaceId, date } },
      create: {
        workspaceId,
        date,
        generationsCount: parsed.generationsCount ?? 0,
        deploysCount: parsed.deploysCount ?? 0,
        invocationsCount: parsed.invocationsCount ?? 0,
        totalLlmCostUsd: parsed.totalLlmCostUsd ?? 0,
        totalSandboxSeconds: parsed.totalSandboxSeconds ?? 0,
      },
      update: {
        ...(parsed.generationsCount !== undefined && {
          generationsCount: { increment: parsed.generationsCount },
        }),
        ...(parsed.deploysCount !== undefined && {
          deploysCount: { increment: parsed.deploysCount },
        }),
        ...(parsed.invocationsCount !== undefined && {
          invocationsCount: { increment: parsed.invocationsCount },
        }),
        ...(parsed.totalLlmCostUsd !== undefined && {
          totalLlmCostUsd: { increment: parsed.totalLlmCostUsd },
        }),
        ...(parsed.totalSandboxSeconds !== undefined && {
          totalSandboxSeconds: { increment: parsed.totalSandboxSeconds },
        }),
      },
    }),
  ]);
}

/**
 * Sum every counter for `workspaceId` over rows with `date >= since` (UTC
 * day-bucket; the `since` value is truncated to UTC midnight before
 * filtering).
 *
 * Returns an `UsageMeterAggregate` with all counters explicitly zero when
 * there are no rows — callers don't need to null-check.
 */
export async function getUsageSince(
  workspaceId: string,
  since: Date,
): Promise<UsageMeterAggregate> {
  const sinceDay = toUtcMidnight(since);

  const result = await prisma.usageMeter.aggregate({
    where: {
      workspaceId,
      date: { gte: sinceDay },
    },
    _sum: {
      generationsCount: true,
      deploysCount: true,
      invocationsCount: true,
      totalLlmCostUsd: true,
      totalSandboxSeconds: true,
    },
  });

  return {
    workspaceId,
    since: sinceDay,
    generationsCount: result._sum.generationsCount ?? 0,
    deploysCount: result._sum.deploysCount ?? 0,
    invocationsCount: result._sum.invocationsCount ?? 0,
    totalLlmCostUsd: Number(result._sum.totalLlmCostUsd ?? 0),
    totalSandboxSeconds: result._sum.totalSandboxSeconds ?? 0,
  };
}
