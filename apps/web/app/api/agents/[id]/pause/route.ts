/**
 * POST /api/agents/[id]/pause — pause sync on a deployed Worker.
 *
 * Calls `ntn workers sync pause <workerName>` via @forge/ntn-wrapper, then
 * flips the DB status to `paused`. The NTN call is the source of truth; if
 * it fails we DO NOT mutate the DB (so the dashboard reflects reality).
 *
 * Audit + analytics best-effort.
 */

import { markAgentStatus, recordAuditEvent } from '@forge/db';
import { pauseSync } from '@forge/ntn-wrapper';
import * as Sentry from '@sentry/nextjs';
import { NextResponse } from 'next/server';

import { requireAgentOwnership } from '@/lib/auth';
import { apiError } from '@/lib/errors';
import { capture } from '@/lib/posthog';
import { checkRateLimit, limiters } from '@/lib/ratelimit';
import { withSentry } from '@/lib/sentry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withSentry<{ id: string }>(
  async (_req, ctx) => {
    const { id } = await ctx.params;
    const auth = await requireAgentOwnership(id);
    if (!auth.ok) return auth.response;
    const { ctx: claims, agent } = auth;

    const rl = await checkRateLimit(limiters.agentMutation(), claims.user.id);
    if (!rl.success) {
      return apiError('rate_limited', 'Too many mutations.');
    }

    try {
      await pauseSync(agent.ntnWorkerName);
    } catch (err) {
      Sentry.captureException(err, {
        tags: { phase: 'ntn.pauseSync', ntnWorkerName: agent.ntnWorkerName },
      });
      return apiError('upstream_failure', 'ntn pauseSync failed.');
    }

    const updated = await markAgentStatus(id, 'paused');

    try {
      await recordAuditEvent({
        workspaceId: claims.workspace.id,
        userId: claims.clerkId,
        action: 'agent.paused',
        resourceType: 'agent',
        resourceId: id,
        metadata: { workerName: agent.ntnWorkerName },
      });
    } catch (err) {
      Sentry.captureException(err, { tags: { phase: 'audit.agent.paused' } });
    }

    await capture({
      distinctId: claims.user.id,
      event: 'forge.agent.paused',
      workspaceId: claims.workspace.id,
      properties: { agentId: id, ntnWorkerName: agent.ntnWorkerName },
    });

    return NextResponse.json({ id: updated.id, status: updated.status });
  },
  { routeName: 'agents.pause' },
);
