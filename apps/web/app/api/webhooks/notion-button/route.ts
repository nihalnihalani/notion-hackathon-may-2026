/**
 * POST /api/webhooks/notion-button — fired when a user clicks the "⚡ Forge
 * this Agent" button in their Notion workspace.
 *
 * PUBLIC route (middleware excludes it). Authentication is HMAC over the raw
 * body using the workspace's webhook secret.
 *
 * Wire shape (PLAN §VI):
 *
 *   POST /api/webhooks/notion-button
 *   X-Notion-Signature: sha256=<hex>
 *   Content-Type: application/json
 *
 *   {
 *     "pageId": "...",        // Forge Requests row
 *     "blockId": "...",       // the button block (echo)
 *     "userId": "...",        // Notion user who clicked
 *     "workspaceId": "..."    // Notion workspace id
 *   }
 *
 * Behavior:
 *   1. Read raw body (`req.text()`) — signature is over raw bytes.
 *   2. Resolve workspace by Notion id (or via `pageId` lookup if header absent).
 *   3. Verify signature against the per-workspace secret. Today this falls
 *      back to the global `NOTION_WEBHOOK_SECRET` env (the schema has no
 *      per-workspace secret column yet — tracked in the backlog).
 *   4. Parse JSON, fetch the Forge Requests row description via Notion API.
 *   5. Compute descriptionHash, idempotency check.
 *   6. If hit → post Notion comment "Already generated, here's the link",
 *      return 200.
 *   7. Else → create Generation, enqueue workflow, return 200.
 *
 * Always returns 200 on a successful HMAC verify (even if downstream fails),
 * because Notion will retry on non-2xx and we don't want infinite retries on
 * a genuine app bug. Failures are captured in Sentry.
 */

import {
  createGeneration,
  descriptionHash,
  findRecentByHash,
  findWorkspaceByNotionId,
  prisma,
} from '@forge/db';
import {
  addComment,
  asPageId,
  getPage,
  verifyNotionWebhookSignature,
} from '@forge/notion-client';
import * as Sentry from '@sentry/nextjs';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { apiError } from '@/lib/errors';
import { buildNotionConfig, getNotionTokenForClerkUser } from '@/lib/notion';
import { capture } from '@/lib/posthog';
import { withSentry } from '@/lib/sentry';
import { publishGenerationRequested } from '@/lib/workflows';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const buttonPayloadSchema = z.object({
  pageId: z.string().min(1),
  blockId: z.string().min(1),
  userId: z.string().min(1),
  workspaceId: z.string().min(1),
});

/**
 * Resolve the workspace's HMAC verification secret. v1: a single env-wide
 * secret. The schema needs a per-workspace column (`notionWebhookSecret`) for
 * proper isolation; tracked for v1.1.
 */
function getWorkspaceWebhookSecret(_notionWorkspaceId: string): string {
  return process.env['NOTION_WEBHOOK_SECRET'] ?? '';
}

/**
 * Best-effort extraction of the "description" property from a Forge Requests
 * row. The column is titled "Description" (PLAN §VII), which is the `title`
 * property of the database row. We fall back to the page's title.
 */
function extractDescriptionFromPage(page: unknown): string {
  // Defensive parse — the Notion typings carry an `any` for property
  // values; we accept that here and validate at the call site.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = page as any;
  const props = p?.properties ?? {};
  // Try named "Description" first; fall back to any title property.
  const candidates = [props.Description, props.description, props.Name, props.name];
  for (const cand of candidates) {
    const richText = cand?.title ?? cand?.rich_text;
    if (Array.isArray(richText)) {
      const text = richText
        .map((r: { plain_text?: string }) => r.plain_text ?? '')
        .join('')
        .trim();
      if (text) return text;
    }
  }
  // Final fallback — scan all properties for a title-type with content.
  for (const v of Object.values(props)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vv = v as any;
    if (vv?.type === 'title' && Array.isArray(vv.title)) {
      const text = vv.title
        .map((r: { plain_text?: string }) => r.plain_text ?? '')
        .join('')
        .trim();
      if (text) return text;
    }
  }
  return '';
}

export const POST = withSentry(
  async (req) => {
    const raw = await req.text();

    // Try header-supplied workspace id first; some integrations may not set it.
    let notionWorkspaceId = req.headers.get('x-notion-workspace-id') ?? null;

    let parsedPayload:
      | z.infer<typeof buttonPayloadSchema>
      | null = null;

    // Parse the JSON early ONLY for the workspace-id fallback. The signature
    // verification still happens over `raw`.
    try {
      const tentative = JSON.parse(raw);
      const ok = buttonPayloadSchema.safeParse(tentative);
      if (ok.success) {
        parsedPayload = ok.data;
        notionWorkspaceId ??= ok.data.workspaceId;
      }
    } catch {
      // Will be caught by signature verify (still 401) or validation below.
    }

    if (!notionWorkspaceId) {
      Sentry.captureMessage('notion-button: missing workspace id', {
        level: 'warning',
      });
      return apiError('validation', 'No workspace id in header or body.');
    }

    const secret = getWorkspaceWebhookSecret(notionWorkspaceId);
    const verify = await verifyNotionWebhookSignature({
      rawBody: raw,
      headers: req.headers,
      secret,
    });
    if (!verify.valid) {
      Sentry.captureMessage('notion-button: signature verify failed', {
        level: 'warning',
        tags: { reason: verify.reason ?? 'unknown', notionWorkspaceId },
      });
      return apiError('unauthenticated', 'Invalid Notion signature.');
    }

    if (!parsedPayload) {
      return apiError('validation', 'Body is not a valid button payload.');
    }
    const { pageId, userId: notionUserId } = parsedPayload;

    const workspace = await findWorkspaceByNotionId(notionWorkspaceId);
    if (!workspace) {
      // Signature verified but the workspace isn't in our DB — install never
      // completed. Return 200 to suppress retries.
      Sentry.captureMessage('notion-button: workspace not installed', {
        level: 'warning',
        tags: { notionWorkspaceId },
      });
      return NextResponse.json({ ok: true, ignored: 'not_installed' });
    }

    // Look up the local User row for the Notion clicker. We can't always
    // resolve Notion userIds to Clerk userIds — for now, attribute to the
    // workspace owner. (Once Clerk's Notion adapter surfaces external ids per
    // user we'd map here.)
    const localUser = await prisma.user.findFirst({
      where: { workspaceId: workspace.id, clerkId: workspace.ownerUserId },
      select: { id: true, clerkId: true },
    });
    if (!localUser) {
      Sentry.captureMessage('notion-button: workspace has no owner user', {
        level: 'error',
        tags: { workspaceId: workspace.id, notionUserId },
      });
      return NextResponse.json({ ok: true, ignored: 'no_user' });
    }

    // Fetch the description from the Forge Requests row.
    const token = await getNotionTokenForClerkUser(workspace.ownerUserId);
    if (!token) {
      Sentry.captureMessage('notion-button: no notion token', {
        level: 'error',
        tags: { workspaceId: workspace.id },
      });
      return NextResponse.json({ ok: true, ignored: 'no_token' });
    }
    const config = buildNotionConfig(token);
    let description = '';
    try {
      const page = await getPage(config, asPageId(pageId));
      description = extractDescriptionFromPage(page);
    } catch (err) {
      Sentry.captureException(err, {
        tags: { phase: 'notion.getPage', pageId },
      });
      return NextResponse.json({ ok: true, ignored: 'page_fetch_failed' });
    }
    if (!description) {
      Sentry.captureMessage('notion-button: empty description', {
        level: 'warning',
        tags: { workspaceId: workspace.id, pageId },
      });
      return NextResponse.json({ ok: true, ignored: 'empty_description' });
    }

    const hash = await descriptionHash(workspace.id, description);
    const cached = await findRecentByHash(workspace.id, hash);
    if (cached && cached.agentId) {
      // Post a Notion comment so the user gets a visible "already done" hint.
      try {
        const appUrl =
          process.env['NEXT_PUBLIC_APP_URL'] ?? 'http://localhost:3000';
        await addComment(config, {
          parent: { page_id: pageId },
          rich_text: [
            {
              type: 'text',
              text: {
                content: `Already generated. Open: ${appUrl}/agents/${cached.agentId}`,
                link: null,
              },
            },
          ],
        });
      } catch (err) {
        Sentry.captureException(err, {
          tags: { phase: 'notion.addComment', pageId },
        });
      }
      await capture({
        distinctId: localUser.clerkId,
        event: 'forge.button.cached',
        workspaceId: workspace.id,
        properties: { generationId: cached.id, agentId: cached.agentId },
      });
      return NextResponse.json({ ok: true, status: 'cached', generationId: cached.id });
    }

    const generation = await createGeneration({
      workspaceId: workspace.id,
      userId: localUser.id,
      notionRowId: pageId,
      description,
      descriptionHash: hash,
    });

    try {
      await publishGenerationRequested({
        generationId: generation.id,
        workspaceId: workspace.id,
        userId: localUser.id,
        description,
        descriptionHash: hash,
      });
    } catch (err) {
      Sentry.captureException(err, {
        tags: { phase: 'workflow.enqueue', generationId: generation.id },
      });
      // Still return 200 — the row exists and a retry job can pick it up.
    }

    await capture({
      distinctId: localUser.clerkId,
      event: 'forge.button.queued',
      workspaceId: workspace.id,
      properties: { generationId: generation.id },
    });

    return NextResponse.json({
      ok: true,
      status: 'queued',
      generationId: generation.id,
    });
  },
  { routeName: 'webhooks.notion-button' },
);
