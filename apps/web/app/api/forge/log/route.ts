/**
 * POST /api/forge/log — internal Build Log append endpoint.
 *
 * Called by Vercel Workflow steps via the orchestrator's `logToNotion()`
 * helper. PUBLIC route (middleware excludes it), but protected by a constant-
 * time-compared `FORGE_INTERNAL_TOKEN` bearer.
 *
 * Behavior:
 *   1. Validate bearer (constant-time).
 *   2. Validate body.
 *   3. Per-generation rate limit (600/min) — protects Notion's 3 req/sec.
 *   4. Look up generation → workspace → Notion token + Build Log block id.
 *   5. `appendBuildLogEntry()` (pacer in-process throttle).
 *   6. 204 No Content.
 *
 * Failure modes:
 *   - Bad token → 401
 *   - Bad body  → 400
 *   - Unknown generation → 404
 *   - No Notion token / unmapped Build Log block → 502
 *   - Notion API error → 502
 */

import { prisma } from '@forge/db';
import {
  appendBuildLogEntry,
  asBlockId,
  type BuildLogStatus,
} from '@forge/notion-client';
import * as Sentry from '@sentry/nextjs';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { apiError } from '@/lib/errors';
import { validateForgeInternalToken } from '@/lib/forge-internal';
import { buildNotionConfig, getNotionTokenForClerkUser } from '@/lib/notion';
import { checkRateLimit, limiters } from '@/lib/ratelimit';
import { withSentry } from '@/lib/sentry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const logBodySchema = z.object({
  generationId: z.string().min(1),
  step: z.string().min(1).max(64),
  status: z.enum(['running', 'succeeded', 'failed', 'info']),
  message: z.string().min(1).max(2_000),
  /** ISO 8601 timestamp. Defaults to "now" if absent. */
  timestamp: z.string().datetime().optional(),
});

export const POST = withSentry(
  async (req) => {
    if (!validateForgeInternalToken(req)) {
      return apiError('unauthenticated', 'Invalid internal token.');
    }

    let json: unknown;
    try {
      json = await req.json();
    } catch {
      return apiError('validation', 'Body must be valid JSON.');
    }
    const parsed = logBodySchema.safeParse(json);
    if (!parsed.success) {
      return apiError('validation', 'Invalid log entry.', {
        issues: parsed.error.issues,
      });
    }

    const { generationId, step, status, message } = parsed.data;
    const timestamp = parsed.data.timestamp
      ? new Date(parsed.data.timestamp)
      : new Date();

    // Per-generation throttle (Notion 3 req/sec is global per integration, but
    // the per-generation limit prevents one runaway workflow from monopolizing).
    const rl = await checkRateLimit(limiters.forgeLog(), generationId);
    if (!rl.success) {
      const resp = apiError('rate_limited', 'Build Log append throttled.');
      resp.headers.set(
        'Retry-After',
        String(Math.max(0, Math.ceil((rl.reset - Date.now()) / 1000))),
      );
      return resp;
    }

    const gen = await prisma.generation.findUnique({
      where: { id: generationId },
      select: {
        id: true,
        workspace: {
          select: {
            id: true,
            ownerUserId: true,
            forgeBuildLogBlockId: true,
          },
        },
      },
    });
    if (!gen) {
      return apiError('not_found', `Generation ${generationId} not found.`);
    }

    const ws = gen.workspace;
    if (!ws.forgeBuildLogBlockId) {
      return apiError(
        'upstream_failure',
        'Workspace has no installed Build Log block — installer must run first.',
      );
    }

    // We use the workspace owner's Notion OAuth token. For multi-user
    // workspaces a service account would be cleaner; tracked in the v2
    // backlog. ownerUserId is the Clerk userId.
    const token = await getNotionTokenForClerkUser(ws.ownerUserId);
    if (!token) {
      Sentry.captureMessage('forge/log: no notion token for workspace owner', {
        level: 'error',
        tags: { workspaceId: ws.id, generationId },
      });
      return apiError(
        'upstream_failure',
        'Workspace owner has no live Notion token.',
      );
    }

    // The Build Log container block id is persisted on the workspace by the
    // installer (`@forge/installer` step `create-build-log-block`). We use
    // that dedicated block — NOT the parent page id — so each append lands
    // inside the synced-block / toggle container, not directly on the page.
    const buildLogBlockId = asBlockId(ws.forgeBuildLogBlockId);

    const config = buildNotionConfig(token);
    try {
      await appendBuildLogEntry(config, buildLogBlockId, {
        step,
        status: status as BuildLogStatus,
        message,
        timestamp,
      });
    } catch (err) {
      Sentry.captureException(err, {
        tags: { phase: 'notion.appendBuildLogEntry', generationId },
      });
      return apiError('upstream_failure', 'Notion append failed.');
    }

    return new NextResponse(null, { status: 204 });
  },
  { routeName: 'forge.log' },
);
