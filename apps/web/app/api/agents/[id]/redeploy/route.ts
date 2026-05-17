/**
 * POST /api/agents/[id]/redeploy — re-run the same generation pipeline.
 *
 * The user clicks "Redeploy" on the agent detail page. We:
 *   1. Auth + ownership.
 *   2. Read the agent's description from PlanetScale.
 *   3. Create a new Generation row + publish the workflow event with
 *      `force: true` so the 1h idempotency cache is bypassed.
 *
 * We do NOT bump the existing GeneratedAgent row in this handler — the
 * Shipper's idempotent persistence (`generationId @unique`) means the new
 * run creates a NEW row. The frontend redirects to the new generation's
 * detail page.
 *
 * The same per-user rate limit as `/api/forge/trigger` applies because the
 * redeploy reaches the same workflow runtime.
 */

import { createGeneration, descriptionHash, prisma, recordAuditEvent } from '@forge/db';
import { asBlockId } from '@forge/notion-client';
import { publishGenerationRequested } from '@forge/workflows';
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
    const { ctx: claims } = auth;
    const { user, workspace, clerkId } = claims;

    const rl = await checkRateLimit(limiters.forgeTrigger(), user.id);
    if (!rl.success) {
      const resetSeconds = Math.max(0, Math.ceil((rl.reset - Date.now()) / 1000));
      const resp = apiError('rate_limited', `Rate limit exceeded. Retry in ${resetSeconds}s.`);
      resp.headers.set('Retry-After', String(resetSeconds));
      return resp;
    }

    if (!workspace.forgeBuildLogBlockId || !workspace.notionWorkspaceId) {
      return apiError('forbidden', 'Workspace install incomplete — finish Notion install first.');
    }

    // Re-pull the description from the existing agent row so a redeploy is
    // semantically "the same prompt, fresh model run".
    const existing = await prisma.generatedAgent.findUnique({
      where: { id },
      select: { description: true, ntnWorkerName: true },
    });
    if (!existing) {
      return apiError('not_found', `Agent ${id} not found.`);
    }

    const description = existing.description;
    const hash = await descriptionHash(workspace.id, description);

    const generation = await createGeneration({
      workspaceId: workspace.id,
      userId: user.id,
      // notionRowId null — orchestrator backfills if needed.
      notionRowId: null,
      description,
      descriptionHash: hash,
    });

    try {
      await publishGenerationRequested({
        generationId: generation.id,
        workspaceId: workspace.id,
        notionWorkspaceId: workspace.notionWorkspaceId,
        userId: user.id,
        userEmail: user.email,
        description,
        descriptionHash: hash,
        // The whole point of redeploy — bypass the 1h idempotency cache.
        force: true,
        defaultModel: workspace.defaultModel ?? 'auto',
        buildLogBlockId: asBlockId(workspace.forgeBuildLogBlockId),
        notionRequestRowId: '',
      });
    } catch (error) {
      Sentry.captureException(error, {
        tags: { phase: 'workflow.enqueue', generationId: generation.id },
      });
      return apiError('upstream_failure', 'Could not enqueue redeploy. Try again.');
    }

    try {
      await recordAuditEvent({
        workspaceId: workspace.id,
        userId: clerkId,
        action: 'agent.redeployed',
        resourceType: 'agent',
        resourceId: id,
        metadata: {
          agentId: id,
          workerName: existing.ntnWorkerName,
          newGenerationId: generation.id,
        },
      });
    } catch (error) {
      Sentry.captureException(error, {
        tags: { phase: 'audit.agent.redeployed' },
      });
    }

    await capture({
      distinctId: user.id,
      event: 'forge.agent.redeployed',
      workspaceId: workspace.id,
      properties: {
        agentId: id,
        generationId: generation.id,
        ntnWorkerName: existing.ntnWorkerName,
      },
    });

    return NextResponse.json(
      { generationId: generation.id, status: 'queued' as const },
      { status: 202 },
    );
  },
  { routeName: 'agents.redeploy' },
);
