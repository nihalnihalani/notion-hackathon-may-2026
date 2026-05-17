/**
 * POST /api/forge/cancel/[id] — best-effort cancel of an in-flight generation.
 *
 * "Best-effort" means:
 *   - We ask the workflow engine to abort the run (`cancelInflight`). It may
 *     not be able to (the run may have already completed).
 *   - We mark the DB row `cancelled` IFF current status is `queued` or
 *     `running`. We never overwrite a terminal state.
 *   - The Notion Build Log appends a "cancelled" line via the workflow itself
 *     on the next step boundary — we don't proactively call /api/forge/log
 *     here.
 *
 * Always returns `{ ok: true }` on a successful cancel attempt, regardless of
 * whether the workflow actually had something to cancel. Clients can poll
 * `/api/forge/generations/:id` to see the final state.
 */

import { updateGenerationStatus, prisma } from '@forge/db';
import * as Sentry from '@sentry/nextjs';
import { NextResponse } from 'next/server';

import { requireGenerationOwnership } from '@/lib/auth';
import { apiError } from '@/lib/errors';
import { capture } from '@/lib/posthog';
import { checkRateLimit, limiters } from '@/lib/ratelimit';
import { withSentry } from '@/lib/sentry';
import { cancelInflight } from '@/lib/workflows';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withSentry<{ id: string }>(
  async (_req, ctx) => {
    const { id } = await ctx.params;
    const auth = await requireGenerationOwnership(id);
    if (!auth.ok) return auth.response;
    const { user, workspace } = auth.ctx;

    const rl = await checkRateLimit(limiters.forgeCancel(), user.id);
    if (!rl.success) {
      return apiError('rate_limited', 'Too many cancel requests.');
    }

    // Workflow cancel — log failures but don't fail the request.
    try {
      await cancelInflight(id);
    } catch (err) {
      Sentry.captureException(err, {
        tags: { phase: 'workflow.cancel', generationId: id },
      });
    }

    // Only flip non-terminal rows. Read first to avoid a useless write.
    const current = await prisma.generation.findUnique({
      where: { id },
      select: { status: true },
    });
    if (current && (current.status === 'queued' || current.status === 'running')) {
      await updateGenerationStatus(id, {
        status: 'cancelled',
        completedAt: new Date(),
      });
    }

    await capture({
      distinctId: user.id,
      event: 'forge.cancel',
      workspaceId: workspace.id,
      properties: { generationId: id, priorStatus: current?.status ?? 'unknown' },
    });

    // We do NOT write an AuditLog row for cancel — the AuditEventInput union
    // doesn't include `generation.cancelled` and we must not widen it from a
    // peripheral PR. Tracked in the backlog.

    return NextResponse.json({ ok: true });
  },
  { routeName: 'forge.cancel.id' },
);
