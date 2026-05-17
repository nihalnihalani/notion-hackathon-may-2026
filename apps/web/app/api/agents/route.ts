/**
 * GET /api/agents — list the caller workspace's generated agents.
 *
 * Query params:
 *   - `status=active|paused|retracted`  filter (default: active + paused)
 *   - `limit`                            page size (max 100, default 50)
 *   - `cursor`                           opaque cursor (we use `createdAt`
 *                                        ISO string of the last row from the
 *                                        previous page)
 *
 * Response:
 *   {
 *     agents: GeneratedAgent[],
 *     nextCursor: string | null,
 *   }
 *
 * Pagination is keyset-by-createdAt (DESC). `findActiveAgentsByWorkspace`
 * doesn't take pagination params today; we apply the cursor + limit at this
 * layer using `prisma` directly to keep the repository surface stable.
 */

import { prisma } from '@forge/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { requireWorkspace } from '@/lib/auth';
import { apiError } from '@/lib/errors';
import { withSentry } from '@/lib/sentry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const querySchema = z.object({
  status: z.enum(['active', 'paused', 'retracted']).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  cursor: z.string().datetime().optional(),
});

export const GET = withSentry(
  async (req) => {
    const r = await requireWorkspace();
    if (!r.ok) return r.response;
    const { workspace } = r.ctx;

    const url = new URL(req.url);
    const parsed = querySchema.safeParse(
      Object.fromEntries(url.searchParams.entries()),
    );
    if (!parsed.success) {
      return apiError('validation', 'Invalid query.', {
        issues: parsed.error.issues,
      });
    }
    const { status, limit, cursor } = parsed.data;

    const where = {
      workspaceId: workspace.id,
      ...(status
        ? { status }
        : { status: { in: ['active' as const, 'paused' as const] } }),
      ...(cursor ? { createdAt: { lt: new Date(cursor) } } : {}),
    };

    const agents = await prisma.generatedAgent.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit + 1, // fetch one extra to compute nextCursor
    });

    let nextCursor: string | null = null;
    if (agents.length > limit) {
      const last = agents[limit - 1];
      // last is defined because agents.length > limit ≥ 1.
      nextCursor = last!.createdAt.toISOString();
      agents.pop();
    }

    return NextResponse.json({
      agents: agents.map((a) => ({
        id: a.id,
        workspaceId: a.workspaceId,
        generationId: a.generationId,
        ntnWorkerName: a.ntnWorkerName,
        ntnDeployUrl: a.ntnDeployUrl,
        notionCustomAgentId: a.notionCustomAgentId,
        pattern: a.pattern,
        description: a.description,
        sourceBlobUrl: a.sourceBlobUrl,
        avatarUrl: a.avatarUrl,
        capabilities: a.capabilities,
        oauthProviders: a.oauthProviders,
        webhookUrl: a.webhookUrl,
        status: a.status,
        createdAt: a.createdAt.toISOString(),
        lastInvokedAt: a.lastInvokedAt?.toISOString() ?? null,
        totalInvocations: a.totalInvocations,
      })),
      nextCursor,
    });
  },
  { routeName: 'agents.list' },
);
