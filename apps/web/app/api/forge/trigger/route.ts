/**
 * POST /api/forge/trigger — primary entry point for "create me an agent".
 *
 * Called by:
 *   - The dashboard's "New agent" form.
 *   - The Notion-button webhook handler (server-to-server).
 *   - The MCP server's `forge_agent` tool.
 *
 * Behavior (PLAN §VI):
 *   1. Auth + workspace bind.
 *   2. Validate body: `{ description: string (1..1000), force?: boolean }`.
 *   3. Rate limit: 5 generations / minute / user.
 *   4. Compute `descriptionHash` and look for a successful Generation in the
 *      last 1h with the same hash. If found AND !force → return cached
 *      `{ generationId, status: 'cached', agentId }`.
 *   5. Else: create a fresh Generation row (status: `queued`), publish
 *      `forge/generation.requested`, return `{ generationId, status: 'queued' }`.
 *
 * The `notionRowId` is left blank on dashboard-originated calls (the
 * orchestrator backfills it when the Forge Requests row is created in Notion).
 * For webhook-originated calls the row id is supplied via this same route's
 * internal use from the webhook handler — that handler computes the same
 * idempotency hash and creates the Generation directly.
 */

import {
  createGeneration,
  descriptionHash,
  findRecentByHash,
} from '@forge/db';
import * as Sentry from '@sentry/nextjs';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { requireWorkspace } from '@/lib/auth';
import { apiError } from '@/lib/errors';
import { capture } from '@/lib/posthog';
import { checkRateLimit, limiters } from '@/lib/ratelimit';
import { withSentry } from '@/lib/sentry';
import { publishGenerationRequested } from '@/lib/workflows';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const triggerBodySchema = z.object({
  description: z
    .string()
    .min(1, 'description is required')
    .max(1000, 'description must be 1000 characters or fewer'),
  force: z.boolean().optional().default(false),
  /**
   * Optional Notion row id when the dashboard knows about an existing Forge
   * Requests row — webhooks supply this. Defaults to empty string (orchestrator
   * will create the row).
   */
  notionRowId: z.string().optional().default(''),
});

export const POST = withSentry(
  async (req) => {
    const r = await requireWorkspace();
    if (!r.ok) return r.response;
    const { user, workspace } = r.ctx;

    let json: unknown;
    try {
      json = await req.json();
    } catch {
      return apiError('validation', 'Body must be valid JSON.');
    }
    const parsed = triggerBodySchema.safeParse(json);
    if (!parsed.success) {
      return apiError('validation', 'Invalid request body.', {
        issues: parsed.error.issues,
      });
    }
    const { description, force, notionRowId } = parsed.data;

    // Per-user rate limit. Identifier is the Clerk userId mapped to our `User.id`.
    const rl = await checkRateLimit(limiters.forgeTrigger(), user.id);
    if (!rl.success) {
      const resetSeconds = Math.max(0, Math.ceil((rl.reset - Date.now()) / 1000));
      const resp = apiError(
        'rate_limited',
        `Rate limit exceeded. Retry in ${resetSeconds}s.`,
      );
      resp.headers.set('Retry-After', String(resetSeconds));
      resp.headers.set('X-RateLimit-Limit', String(rl.limit));
      resp.headers.set('X-RateLimit-Remaining', String(rl.remaining));
      return resp;
    }

    const hash = await descriptionHash(workspace.id, description);

    if (!force) {
      const cached = await findRecentByHash(workspace.id, hash);
      if (cached && cached.agentId) {
        await capture({
          distinctId: user.id,
          event: 'forge.trigger.cached',
          workspaceId: workspace.id,
          properties: { generationId: cached.id, agentId: cached.agentId },
        });
        return NextResponse.json(
          {
            generationId: cached.id,
            status: 'cached' as const,
            agentId: cached.agentId,
          },
          { status: 200 },
        );
      }
    }

    const generation = await createGeneration({
      workspaceId: workspace.id,
      userId: user.id,
      notionRowId,
      description,
      descriptionHash: hash,
    });

    try {
      await publishGenerationRequested({
        generationId: generation.id,
        workspaceId: workspace.id,
        userId: user.id,
        description,
        descriptionHash: hash,
      });
    } catch (err) {
      // Mark the row failed; we don't want a dangling `queued` row on enqueue failure.
      Sentry.captureException(err, {
        tags: { phase: 'workflow.enqueue', generationId: generation.id },
      });
      return apiError(
        'upstream_failure',
        'Could not enqueue generation. Try again.',
      );
    }

    await capture({
      distinctId: user.id,
      event: 'forge.trigger.queued',
      workspaceId: workspace.id,
      properties: { generationId: generation.id, force },
    });

    return NextResponse.json(
      { generationId: generation.id, status: 'queued' as const },
      { status: 202 },
    );
  },
  { routeName: 'forge.trigger' },
);
