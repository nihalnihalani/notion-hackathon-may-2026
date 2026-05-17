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

import {
  prisma,
  recordAuditEvent,
  updateGenerationStatus,
} from '@forge/db';
import { cancelInflight } from '@forge/workflows';
import * as Sentry from '@sentry/nextjs';
import { NextResponse } from 'next/server';

import { requireGenerationOwnership } from '@/lib/auth';
import { apiError } from '@/lib/errors';
import { capture } from '@/lib/posthog';
import { checkRateLimit, limiters } from '@/lib/ratelimit';
import { withSentry } from '@/lib/sentry';

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

    // Workflow cancel — log failures but don't fail the request. The real
    // cancellation requires a stored hook token (see @forge/workflows
    // README). v1 does not yet persist that token; the call returns
    // { skipped: true } and we still mark the row cancelled below, which the
    // workflow notices on the next step boundary via its abort-signal guard.
    try {
      await cancelInflight(id, 'user');
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
      event: 'forge.generation.cancelled',
      workspaceId: workspace.id,
      properties: { generationId: id, priorStatus: current?.status ?? 'unknown' },
    });

    try {
      await recordAuditEvent({
        workspaceId: workspace.id,
        userId: auth.ctx.clerkId,
        action: 'generation.cancelled',
        resourceType: 'generation',
        resourceId: id,
        metadata: { reason: 'user' },
      });
    } catch (err) {
      Sentry.captureException(err, {
        tags: { phase: 'audit.generation.cancelled' },
      });
    }

    return NextResponse.json({ ok: true });
  },
  { routeName: 'forge.cancel.id' },
);
