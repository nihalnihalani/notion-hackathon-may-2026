/**
 * DELETE /api/agents/[id] — retract a deployed agent.
 *
 * Sequence:
 *   1. Auth + ownership.
 *   2. `ntn workers delete <workerName>` — the source of truth in NTN.
 *   3. `softDeleteAgent(id)` — flips `status` to `retracted` (audit-preserved).
 *   4. `recordAuditEvent('agent.deleted')` — reason: `user_request`.
 *   5. 204 No Content.
 *
 * If the NTN delete fails (404 because the Worker is already gone) we still
 * proceed with the soft-delete: the user's intent is clear and the DB row
 * shouldn't be marooned. Other errors → 502.
 */

import { recordAuditEvent, softDeleteAgent } from '@forge/db';
import { deleteWorker, NtnNotInstalledError } from '@forge/ntn-wrapper';
import * as Sentry from '@sentry/nextjs';
import { NextResponse } from 'next/server';

import { requireAgentOwnership } from '@/lib/auth';
import { apiError } from '@/lib/errors';
import { capture } from '@/lib/posthog';
import { checkRateLimit, limiters } from '@/lib/ratelimit';
import { withSentry } from '@/lib/sentry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const DELETE = withSentry<{ id: string }>(
  async (_req, ctx) => {
    const { id } = await ctx.params;
    const auth = await requireAgentOwnership(id);
    if (!auth.ok) return auth.response;
    const { ctx: claims, agent } = auth;

    const rl = await checkRateLimit(limiters.agentMutation(), claims.user.id);
    if (!rl.success) {
      return apiError('rate_limited', 'Too many mutations.');
    }

    let ntnAlreadyGone = false;
    try {
      await deleteWorker(agent.ntnWorkerName);
    } catch (err) {
      // Treat "no such worker" as success — the desired terminal state.
      if (err instanceof NtnNotInstalledError) {
        ntnAlreadyGone = true;
      } else {
        const message =
          err instanceof Error ? err.message.toLowerCase() : '';
        if (message.includes('not found') || message.includes('404')) {
          ntnAlreadyGone = true;
        } else {
          Sentry.captureException(err, {
            tags: {
              phase: 'ntn.deleteWorker',
              ntnWorkerName: agent.ntnWorkerName,
            },
          });
          return apiError('upstream_failure', 'ntn deleteWorker failed.');
        }
      }
    }

    await softDeleteAgent(id);

    try {
      await recordAuditEvent({
        workspaceId: claims.workspace.id,
        userId: claims.clerkId,
        action: 'agent.deleted',
        resourceType: 'agent',
        resourceId: id,
        metadata: {
          ntnWorkerName: agent.ntnWorkerName,
          reason: 'user_request',
        },
      });
    } catch (err) {
      Sentry.captureException(err, { tags: { phase: 'audit.agent.deleted' } });
    }

    await capture({
      distinctId: claims.user.id,
      event: 'forge.agent.deleted',
      workspaceId: claims.workspace.id,
      properties: {
        agentId: id,
        ntnWorkerName: agent.ntnWorkerName,
        ntnAlreadyGone,
      },
    });

    return new NextResponse(null, { status: 204 });
  },
  { routeName: 'agents.delete' },
);
