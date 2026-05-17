/**
 * GET /api/agents/[id]/runs — list recent NTN-worker runs for an agent.
 *
 * Source of truth is the NTN CLI (`ntn workers runs list <name> --json`),
 * wrapped by @forge/ntn-wrapper's `listRuns`. We do NOT cache the response
 * — frontends poll this when the user opens the "Runs" tab and we want
 * fresh data.
 *
 * Auth + ownership flow mirrors /api/agents/[id]/{pause,resume,DELETE}.
 *
 * Response envelope:
 *   {
 *     runs: WorkerRun[]      // raw NTN shape, see @forge/ntn-wrapper/types
 *   }
 *
 * Failure modes:
 *   - Unauth / not-ours → 401 / 403 / 404 from `requireAgentOwnership`.
 *   - NTN call fails    → 502 (Sentry-captured).
 *   - Worker gone       → 200 with `{ runs: [] }` (the deleted agent UI
 *                         should redirect anyway).
 */

import { listRuns, NtnNotInstalledError } from '@forge/ntn-wrapper';
import * as Sentry from '@sentry/nextjs';
import { NextResponse } from 'next/server';

import { requireAgentOwnership } from '@/lib/auth';
import { apiError } from '@/lib/errors';
import { withSentry } from '@/lib/sentry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withSentry<{ id: string }>(
  async (req, ctx) => {
    const { id } = await ctx.params;
    const auth = await requireAgentOwnership(id);
    if (!auth.ok) return auth.response;
    const { agent } = auth;

    // Optional `?limit=N` query — clamp to a sensible upper bound so a
    // misbehaving frontend can't ask NTN for 10k rows.
    const url = new URL(req.url);
    const limitParam = url.searchParams.get('limit');
    let limit: number | undefined;
    if (limitParam !== null) {
      const parsed = Number(limitParam);
      if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 200) {
        return apiError(
          'validation',
          '`limit` must be a positive integer ≤ 200.',
        );
      }
      limit = parsed;
    }

    try {
      const runs = await listRuns(
        agent.ntnWorkerName,
        limit !== undefined ? { limit } : {},
      );
      return NextResponse.json({ runs });
    } catch (err) {
      if (err instanceof NtnNotInstalledError) {
        // ntn CLI missing on the server — surface as 502 so ops notices.
        Sentry.captureException(err, {
          tags: { phase: 'ntn.listRuns', ntnWorkerName: agent.ntnWorkerName },
        });
        return apiError('upstream_failure', 'ntn CLI not available.');
      }
      const message = err instanceof Error ? err.message.toLowerCase() : '';
      // Treat "no such worker" as an empty list — the underlying agent
      // record might be retracted and the user is just seeing a stale tab.
      if (message.includes('not found') || message.includes('404')) {
        return NextResponse.json({ runs: [] });
      }
      Sentry.captureException(err, {
        tags: { phase: 'ntn.listRuns', ntnWorkerName: agent.ntnWorkerName },
      });
      return apiError('upstream_failure', 'ntn listRuns failed.');
    }
  },
  { routeName: 'agents.runs' },
);
