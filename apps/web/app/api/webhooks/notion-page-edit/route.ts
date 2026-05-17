/**
 * POST /api/webhooks/notion-page-edit — debounced description re-trigger.
 *
 * Notion fires this when the user edits the description property on a row
 * in the Forge Requests DB. We want to:
 *   - Recognize that an in-flight Generation should be aborted + restarted
 *     against the new text.
 *   - Avoid restarting on every keystroke — Notion's page-update events fire
 *     aggressively. We debounce by 30s of silence.
 *
 * Debounce strategy (v1):
 *   - Write the latest event to Upstash at `forge:edit-debounce:{pageId}`
 *     with a 30s TTL. The value is the JSON payload.
 *   - On every incoming event we update that key (extending the TTL).
 *   - A separate Cron job (`cron-process-debounced-edits`, see backlog) runs
 *     every 30s, scans for keys whose TTL is below a threshold, and triggers
 *     the workflow. Keeping this in a Cron job (not `waitUntil` inside the
 *     route) survives Vercel function recycles.
 *
 * Why not waitUntil + setTimeout? It works for short windows but on Vercel
 * preview deployments the function instance may be recycled before the
 * timeout fires; the Cron-based approach is robust.
 *
 * This route's only job here is: verify signature, record latest event in
 * Upstash, return 200. The Cron job (not this PR) does the real work.
 */

import { findWorkspaceByNotionId } from '@forge/db';
import { verifyNotionWebhookSignature } from '@forge/notion-client';
import { Redis } from '@upstash/redis';
import * as Sentry from '@sentry/nextjs';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { apiError } from '@/lib/errors';
import { withSentry } from '@/lib/sentry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEBOUNCE_TTL_SECONDS = 30;

const pageEditPayloadSchema = z.object({
  pageId: z.string().min(1),
  workspaceId: z.string().min(1),
  /** Optional — Notion sends this when available. */
  userId: z.string().optional(),
});

function getWorkspaceWebhookSecret(_notionWorkspaceId: string): string {
  return process.env['NOTION_WEBHOOK_SECRET'] ?? '';
}

let redisSingleton: Redis | null = null;
function getRedis(): Redis | null {
  if (redisSingleton) return redisSingleton;
  const url = process.env['UPSTASH_REDIS_REST_URL'];
  const token = process.env['UPSTASH_REDIS_REST_TOKEN'];
  if (!url || !token) return null;
  redisSingleton = new Redis({ url, token });
  return redisSingleton;
}

export const POST = withSentry(
  async (req) => {
    const raw = await req.text();

    let notionWorkspaceId =
      req.headers.get('x-notion-workspace-id') ?? null;
    let parsed: z.infer<typeof pageEditPayloadSchema> | null = null;
    try {
      const tentative = JSON.parse(raw);
      const ok = pageEditPayloadSchema.safeParse(tentative);
      if (ok.success) {
        parsed = ok.data;
        notionWorkspaceId ??= ok.data.workspaceId;
      }
    } catch {
      // ignored — signature verification will reject malformed bodies anyway
    }

    if (!notionWorkspaceId) {
      return apiError('validation', 'No workspace id in header or body.');
    }

    const secret = getWorkspaceWebhookSecret(notionWorkspaceId);
    const verify = await verifyNotionWebhookSignature({
      rawBody: raw,
      headers: req.headers,
      secret,
    });
    if (!verify.valid) {
      Sentry.captureMessage('notion-page-edit: signature verify failed', {
        level: 'warning',
        tags: { reason: verify.reason ?? 'unknown', notionWorkspaceId },
      });
      return apiError('unauthenticated', 'Invalid Notion signature.');
    }

    if (!parsed) {
      return apiError('validation', 'Body is not a valid page-edit payload.');
    }

    const workspace = await findWorkspaceByNotionId(notionWorkspaceId);
    if (!workspace) {
      // Suppress retries — workspace not installed.
      return NextResponse.json({ ok: true, ignored: 'not_installed' });
    }

    const redis = getRedis();
    if (!redis) {
      Sentry.captureMessage('notion-page-edit: redis unavailable', {
        level: 'error',
        tags: { workspaceId: workspace.id },
      });
      // No debounce backing store — drop the event and 200 to avoid retries.
      return NextResponse.json({ ok: true, ignored: 'no_debouncer' });
    }

    const key = `forge:edit-debounce:${workspace.id}:${parsed.pageId}`;
    await redis.set(
      key,
      JSON.stringify({
        workspaceId: workspace.id,
        pageId: parsed.pageId,
        receivedAt: Date.now(),
        notionUserId: parsed.userId ?? null,
      }),
      { ex: DEBOUNCE_TTL_SECONDS },
    );

    return NextResponse.json({ ok: true, debouncedSeconds: DEBOUNCE_TTL_SECONDS });
  },
  { routeName: 'webhooks.notion-page-edit' },
);
