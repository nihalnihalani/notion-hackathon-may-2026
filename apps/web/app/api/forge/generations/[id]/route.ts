/**
 * GET /api/forge/generations/[id] — generation status + step trail.
 *
 * Used by the dashboard's `/generations/:id` page (and by the orchestrator
 * itself for resume). Always returns 200 with the typed envelope on success,
 * 404 when the id doesn't exist, 403 when it's another workspace's.
 *
 * Steps are sorted by `startedAt asc` (already done by the repository helper)
 * so the frontend can render the build log in order without re-sorting.
 */

import { getGenerationWithSteps } from '@forge/db';
import { NextResponse } from 'next/server';

import { requireGenerationOwnership } from '@/lib/auth';
import { apiError } from '@/lib/errors';
import { withSentry } from '@/lib/sentry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withSentry<{ id: string }>(
  async (_req, ctx) => {
    const { id } = await ctx.params;
    const auth = await requireGenerationOwnership(id);
    if (!auth.ok) return auth.response;

    const gen = await getGenerationWithSteps(id);
    if (!gen) {
      // Race: existed at auth-time but was deleted before fetch. Treat as 404.
      return apiError('not_found', `Generation ${id} not found.`);
    }

    return NextResponse.json({
      id: gen.id,
      status: gen.status,
      pattern: gen.pattern,
      agentId: gen.agentId,
      startedAt: gen.startedAt.toISOString(),
      completedAt: gen.completedAt?.toISOString() ?? null,
      totalLatencyMs: gen.totalLatencyMs,
      totalCostUsd: gen.totalCostUsd ? Number(gen.totalCostUsd) : null,
      steps: gen.steps.map((s) => ({
        id: s.id,
        agent: s.agent,
        attempt: s.attempt,
        status: s.status,
        modelUsed: s.modelUsed,
        startedAt: s.startedAt.toISOString(),
        completedAt: s.completedAt?.toISOString() ?? null,
        latencyMs: s.latencyMs,
        costUsd: s.costUsd ? Number(s.costUsd) : null,
        promptTokens: s.promptTokens,
        completionTokens: s.completionTokens,
        cacheReadTokens: s.cacheReadTokens,
        cacheWriteTokens: s.cacheWriteTokens,
      })),
    });
  },
  { routeName: 'forge.generations.id' },
);
