/**
 * POST /api/agents/[id]/resume — counterpart to /pause.
 *
 * See pause/route.ts for the architecture comments.
 */

import { markAgentStatus, recordAuditEvent } from '@forge/db';
import { resumeSync } from '@forge/ntn-wrapper';
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
      await resumeSync(agent.ntnWorkerName);
    } catch (err) {
      Sentry.captureException(err, {
        tags: { phase: 'ntn.resumeSync', ntnWorkerName: agent.ntnWorkerName },
      });
      return apiError('upstream_failure', 'ntn resumeSync failed.');
    }

    const updated = await markAgentStatus(id, 'active');

    try {
      await recordAuditEvent({
        workspaceId: claims.workspace.id,
        userId: claims.clerkId,
        action: 'agent.resumed',
        resourceType: 'agent',
        resourceId: id,
        metadata: { workerName: agent.ntnWorkerName },
      });
    } catch (err) {
      Sentry.captureException(err, { tags: { phase: 'audit.agent.resumed' } });
    }

    await capture({
      distinctId: claims.user.id,
      event: 'forge.agent.resumed',
      workspaceId: claims.workspace.id,
      properties: { agentId: id, ntnWorkerName: agent.ntnWorkerName },
    });

    return NextResponse.json({ id: updated.id, status: updated.status });
  },
  { routeName: 'agents.resume' },
);
