/**
 * GET /api/agents/[id]/runs — list recent NTN-worker runs for an agent.
 *
 * Source of truth is the NTN CLI (`ntn workers runs list <name> --json`),
 * wrapped by @forge/ntn-wrapper's `listRuns`. We cache for 60s at the
 * Vercel edge so a polling client tab doesn't hammer the CLI on each
 * keystroke — fresh enough for the "Runs" pane in the agent detail UI.
 *
 * Auth + ownership flow mirrors /api/agents/[id]/{pause,resume,DELETE}.
 *
 * Query params:
 *   ?limit=N      — clamp size (1..200, default 50)
 *   ?cursor=ID    — opaque cursor: the `runId` of the last item the
 *                   client already has. We return only runs that started
 *                   *strictly before* the cursor (lexicographic by
 *                   `startedAt`, fallback id). `nextCursor` is the id of
 *                   the oldest run in the response, or null at the tail.
 *
 * Response envelope:
 *   {
 *     runs: [{
 *       id, runId, status, startedAt, durationMs, exitCode, trigger,
 *     }],
 *     nextCursor: string | null,
 *   }
 *
 * Failure modes:
 *   - Unauth / not-ours → 401 / 403 / 404 from `requireAgentOwnership`.
 *   - NTN call fails    → 502 (Sentry-captured).
 *   - Worker gone       → 200 with `{ runs: [], nextCursor: null }` (the
 *                         deleted agent UI should redirect anyway).
 */

import { listRuns, NtnNotInstalledError } from '@forge/ntn-wrapper';
import type { WorkerRun } from '@forge/ntn-wrapper';
import * as Sentry from '@sentry/nextjs';
import { NextResponse } from 'next/server';

import { requireAgentOwnership } from '@/lib/auth';
import { apiError } from '@/lib/errors';
import { withSentry } from '@/lib/sentry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

interface RunResponseItem {
  /** Stable id (alias of `runId` — keeps the FE table key working). */
  id: string;
  runId: string;
  status: string | null;
  startedAt: string | null;
  durationMs: number | null;
  exitCode: number | null;
  trigger: string;
}

/** Coerce the loose `WorkerRun` shape into our stable response envelope. */
function toResponseItem(run: WorkerRun): RunResponseItem {
  // NTN sometimes emits `exitCode` on the freeform record; expose it as
  // typed `number | null` so the FE doesn't have to defensive-type it.
  const rawExit = (run as { exitCode?: unknown }).exitCode;
  const exitCode = typeof rawExit === 'number' ? rawExit : null;
  return {
    id: run.id,
    runId: run.id,
    status: run.status ?? null,
    startedAt: run.startedAt ?? null,
    durationMs: typeof run.durationMs === 'number' ? run.durationMs : null,
    exitCode,
    trigger: typeof run.trigger === 'string' ? run.trigger : 'manual',
  };
}

export const GET = withSentry<{ id: string }>(
  async (req, ctx) => {
    const { id } = await ctx.params;
    const auth = await requireAgentOwnership(id);
    if (!auth.ok) return auth.response;
    const { agent } = auth;

    const url = new URL(req.url);

    // Optional `?limit=N`.
    let limit = DEFAULT_LIMIT;
    const limitParam = url.searchParams.get('limit');
    if (limitParam !== null) {
      const parsed = Number(limitParam);
      if (!Number.isInteger(parsed) || parsed <= 0 || parsed > MAX_LIMIT) {
        return apiError(
          'validation',
          `\`limit\` must be a positive integer ≤ ${MAX_LIMIT}.`,
        );
      }
      limit = parsed;
    }

    // Optional `?cursor=<runId>`. We over-fetch by one so we can detect
    // whether more pages exist, then drop the sentinel before responding.
    const cursor = url.searchParams.get('cursor');

    let runs: WorkerRun[];
    try {
      // Ask NTN for limit+1; if cursor is supplied we drop anything up to
      // and including the cursor id below. We don't pass cursor through to
      // the CLI because the CLI doesn't support it — we paginate in-memory
      // off the latest page. This is good enough for the FE's "show me 50
      // more" affordance and avoids an extra abstraction in the wrapper.
      runs = await listRuns(agent.ntnWorkerName, { limit: limit + 1 });
    } catch (err) {
      if (err instanceof NtnNotInstalledError) {
        Sentry.captureException(err, {
          tags: { phase: 'ntn.listRuns', ntnWorkerName: agent.ntnWorkerName },
        });
        return apiError('upstream_failure', 'ntn CLI not available.');
      }
      const message = err instanceof Error ? err.message.toLowerCase() : '';
      // Treat "no such worker" as an empty list — the underlying agent
      // record might be retracted and the user is just seeing a stale tab.
      if (message.includes('not found') || message.includes('404')) {
        return NextResponse.json({ runs: [], nextCursor: null });
      }
      Sentry.captureException(err, {
        tags: { phase: 'ntn.listRuns', ntnWorkerName: agent.ntnWorkerName },
      });
      return apiError('upstream_failure', 'ntn listRuns failed.');
    }

    // Apply cursor in-memory: keep only runs that appear *after* the
    // cursor entry. If the cursor isn't in the page (older than the
    // latest `limit+1`), the page is returned untouched — the caller
    // already passed it.
    let windowed = runs;
    if (cursor) {
      const idx = runs.findIndex((r) => r.id === cursor);
      if (idx >= 0) windowed = runs.slice(idx + 1);
    }

    const hasMore = windowed.length > limit;
    const page = (hasMore ? windowed.slice(0, limit) : windowed).map(
      toResponseItem,
    );
    const last = page.length > 0 ? (page[page.length - 1] as RunResponseItem) : null;
    const nextCursor = hasMore && last ? last.runId : null;

    const body = { runs: page, nextCursor };
    const resp = NextResponse.json(body);
    // Cache on Vercel edge for 60s; stale-while-revalidate keeps the tab
    // snappy if the user re-opens it inside the cache window.
    resp.headers.set(
      'Cache-Control',
      'private, max-age=60, stale-while-revalidate=30',
    );
    return resp;
  },
  { routeName: 'agents.runs' },
);
