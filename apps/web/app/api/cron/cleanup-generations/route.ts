/**
 * GET /api/cron/cleanup-generations — stale-generation reaper.
 *
 * Public route (the proxy excludes `/api/cron/*` from Clerk auth), protected
 * by Vercel's `CRON_SECRET` bearer. Invoked on the schedule declared in
 * `vercel.json` (`*\/15 * * * *`). See:
 *   https://vercel.com/docs/cron-jobs/manage-cron-jobs#how-to-secure-cron-jobs
 *
 * Why this exists
 * ────────────────
 * A `Generation` row stuck in `queued` or `running` past the wall-clock
 * budget is a leak — the workflow either crashed mid-flight or its sandbox
 * died. The user sees a forever-spinner on the dashboard and ops has no
 * signal. This cron sweeps every {@link STALE_AGE_MS} for those rows,
 * marks them `failed` with a synthetic step trail, and emits PostHog +
 * ops-metrics events so on-call sees the leak rate.
 *
 * Budget
 * ──────
 * PLAN.md §VIII pins each step timeout at 90s and the full DAG at ≤10 min
 * realistically. 30 min is a generous safety margin — anything older than
 * that is unambiguously a crash, not a slow run.
 *
 * Concurrency
 * ───────────
 * The cron may overlap with itself if a previous tick is still running. The
 * per-row reap is wrapped in a transactional `updateMany` constrained to
 * still-stale rows so a double-fire never double-fails the same row (the
 * second update matches zero rows and is a no-op).
 *
 * Responses
 * ─────────
 *   - 200 → { ok: true, reaped: N, scanned: M, durationMs: number }
 *   - 401 → missing / wrong `Authorization: Bearer <secret>`
 *   - 503 → `CRON_SECRET` env var is unset (deploy isn't fully configured;
 *           we refuse to run rather than pretend the auth gate works).
 */

import type { AgentPattern as KebabAgentPattern } from '@forge/agents';
import { prisma, findStaleGenerations } from '@forge/db';
import type { AgentPattern as PrismaAgentPattern } from '@forge/db';
import { createOpsMetricsAdapterFromEnv } from '@forge/workflows';
import * as Sentry from '@sentry/nextjs';
import { NextResponse } from 'next/server';

import { apiError } from '@/lib/errors';
import { captureEvent, flushEvents } from '@/lib/posthog-server';
import { withSentry } from '@/lib/sentry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Age threshold (ms) after which a `queued`/`running` row is considered a
 * leak. 30 minutes — see "Budget" note in the module header.
 */
const STALE_AGE_MS = 30 * 60 * 1000;

/** Human-readable form used in the error message attached to reaped rows. */
const STALE_AGE_MINUTES = Math.round(STALE_AGE_MS / 60_000);

/**
 * Convert the Prisma `AgentPattern` enum (snake_case, persisted in the DB) to
 * the kebab-case form used at the agents-layer API surface (PLAN.md §IV.1 —
 * `OpsGenerationEvent.pattern` expects kebab-case).
 *
 * Inverse of `patternToPrismaEnum` in `@forge/agents` shipper.ts. We keep a
 * narrow copy here so the cron has no dependency on agent internals.
 */
function prismaPatternToKebab(pattern: PrismaAgentPattern): KebabAgentPattern {
  const map: Record<PrismaAgentPattern, KebabAgentPattern> = {
    database_query: 'database-query',
    webhook_trigger: 'webhook-trigger',
    sync_source: 'sync-source',
    external_api_call: 'external-api-call',
    multi_step: 'multi-step',
  };
  return map[pattern];
}

/**
 * Constant-time string equality. Both sides must already be the same length;
 * the length-check itself is a non-secret short-circuit. Edge runtimes lack
 * `crypto.timingSafeEqual`, so we do a byte-XOR by hand. Node-only here, but
 * we keep the same convention as `lib/forge-internal.ts` for consistency.
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Validate the `Authorization: Bearer <cron-secret>` header against the
 * `CRON_SECRET` env var Vercel injects on cron invocations. Returns:
 *   - `'unset'`   → env var missing (caller should 503)
 *   - `'bad'`     → header missing or doesn't match (caller should 401)
 *   - `'ok'`      → matches
 */
function validateCronSecret(req: Request): 'unset' | 'bad' | 'ok' {
  const expected = process.env['CRON_SECRET'];
  if (expected === undefined || expected.length === 0) return 'unset';

  const header = req.headers.get('authorization');
  if (!header) return 'bad';
  if (!header.toLowerCase().startsWith('bearer ')) return 'bad';
  const provided = header.slice('bearer '.length).trim();
  if (!provided) return 'bad';
  return constantTimeEqual(provided, expected) ? 'ok' : 'bad';
}

interface CronResponseBody {
  ok: true;
  reaped: number;
  scanned: number;
  durationMs: number;
}

export const GET = withSentry(
  async (req) => {
    const t0 = Date.now();

    const authState = validateCronSecret(req);
    if (authState === 'unset') {
      // Deploy isn't fully configured — refuse to run. Returning 200 with
      // reaped: 0 would silently mask a missing env var on production.
      return apiError('upstream_failure', 'CRON_SECRET is not configured on this deploy.', {
        status: 503,
      });
    }
    if (authState === 'bad') {
      return apiError('unauthenticated', 'Invalid cron secret.');
    }

    // Snapshot `now` once so the deadline math is consistent across the
    // (a) find-stale query, (b) totalLatencyMs computation, and (c) the
    // `completedAt` timestamp written to each row.
    const now = Date.now();
    const cutoff = new Date(now - STALE_AGE_MS);

    let stale;
    try {
      stale = await findStaleGenerations(STALE_AGE_MS, now);
    } catch (error) {
      // findStaleGenerations is a single SELECT — a failure here is a DB
      // outage and we should NOT silently return reaped:0. Bubble to Sentry
      // via the wrapper but still respond 200 so cron infra doesn't retry
      // hot — Sentry alerting catches the regression.
      Sentry.captureException(error, {
        tags: { phase: 'cron.cleanup_generations.find' },
      });
      const body: CronResponseBody = {
        ok: true,
        reaped: 0,
        scanned: 0,
        durationMs: Date.now() - t0,
      };
      return NextResponse.json(body);
    }

    const opsAdapter = createOpsMetricsAdapterFromEnv();
    const errorMessage = `reaped by stale-generation cron after ${STALE_AGE_MINUTES}m`;

    let reaped = 0;
    for (const row of stale) {
      // Concurrent runs: scope the UPDATE to "row id AND status still in
      // (queued|running) AND startedAt < cutoff" so a second simultaneous
      // tick that races us matches zero rows on its UPDATE and silently
      // no-ops instead of double-failing.
      let result;
      try {
        result = await prisma.generation.updateMany({
          where: {
            id: row.id,
            status: { in: ['queued', 'running'] },
            startedAt: { lt: cutoff },
          },
          data: {
            status: 'failed',
            completedAt: new Date(now),
            totalLatencyMs: now - row.startedAt.getTime(),
          },
        });
      } catch (error) {
        Sentry.captureException(error, {
          tags: {
            phase: 'cron.cleanup_generations.update',
            generationId: row.id,
          },
        });
        continue;
      }

      // `updateMany` returns `{ count }`. Zero means another worker raced
      // us; that's fine — they own the reap, we move on.
      if (result.count === 0) continue;

      reaped += 1;
      const ageMs = now - row.startedAt.getTime();

      // Append a synthetic GenerationStep so the Build Log + dashboard show
      // *why* the row is failed instead of an unexplained transition. We use
      // the `inspector` slot because reaping is the post-mortem equivalent
      // of an inspector-detected failure; the message disambiguates.
      try {
        await prisma.generationStep.create({
          data: {
            generationId: row.id,
            agent: 'inspector',
            attempt: 1,
            status: 'failed',
            inputJson: {},
            errorJson: {
              kind: 'stale_generation_reaped',
              message: errorMessage,
              previousStatus: row.status,
              ageMs,
              staleAgeMs: STALE_AGE_MS,
              reapedAt: new Date(now).toISOString(),
            },
            completedAt: new Date(now),
          },
        });
      } catch (error) {
        // Best-effort: the Generation row is already marked failed — losing
        // the step trail row is unfortunate but not a leak.
        Sentry.captureException(error, {
          tags: {
            phase: 'cron.cleanup_generations.step_trail',
            generationId: row.id,
          },
        });
      }

      // PostHog: one event per reaping so on-call can alert on the count.
      // System-initiated event → distinctId is the workspaceId.
      captureEvent({
        userId: row.workspaceId,
        workspaceId: row.workspaceId,
        event: 'forge.cron.stale_generation_reaped',
        properties: {
          generationId: row.id,
          ageMs,
          previousStatus: row.status,
        },
      });

      // Forge Operations self-monitoring (PLAN.md §X). Best-effort: a Notion
      // outage MUST NOT fail the cron. The workflow uses the same swallowing
      // pattern in `safeOpsPublish`.
      if (opsAdapter) {
        try {
          await opsAdapter.publishGenerationEvent({
            generationId: row.id,
            workspaceId: row.workspaceId,
            status: 'failed',
            pattern: row.pattern === null ? null : prismaPatternToKebab(row.pattern),
            description: row.description,
            totalLatencyMs: ageMs,
            totalCostUsd: 0,
            errorMessage,
          });
        } catch (error) {
          Sentry.captureException(error, {
            tags: {
              phase: 'cron.cleanup_generations.ops_metrics',
              generationId: row.id,
            },
          });
        }
      }
    }

    // Serverless: drain the PostHog queue before the response so events
    // aren't lost when Vercel kills the function on return.
    await flushEvents();

    const body: CronResponseBody = {
      ok: true,
      reaped,
      scanned: stale.length,
      durationMs: Date.now() - t0,
    };
    return NextResponse.json(body);
  },
  { routeName: 'cron.cleanup_generations' },
);
