/**
 * POST /api/onboarding/install — finish-install endpoint for the picker.
 *
 * The OAuth callback (`/api/auth/notion/callback`) creates the Workspace row
 * but cannot create the Forge page until the user picks a parent — Notion's
 * REST `POST /v1/pages` requires `parent.page_id` and rejects
 * `parent.workspace`. The callback redirects unfinished installs to
 * `/onboarding/pick-parent`; the picker POSTs the chosen page id here.
 *
 * Body: `{ parentPageId: string }` — Notion UUIDs are 32-hex with optional
 * dashes; we accept either form.
 *
 * Sequence:
 *   1. Auth + workspace bind.
 *   2. Validate body.
 *   3. Fetch the picked page from Notion (`getPage`) to verify it exists AND
 *      the integration has access. A 404 here means the user picked a page
 *      the integration cannot see; we return 400 with a helpful message
 *      pointing at the share-with-integration UX.
 *   4. Call `installForgePage` via the same `InstallerDbClient` adapter the
 *      OAuth callback uses. The installer is idempotent — re-running on an
 *      already-installed workspace returns the existing IDs.
 *   5. Audit `workspace.installed` (best-effort).
 *   6. Return `{ ok: true, redirect: '/dashboard', pageId, requestsDbId, ... }`.
 *
 * Failure mapping:
 *   - 400 validation       → bad body
 *   - 400 validation       → parentPageId not found (picked-but-unshared)
 *   - 401 unauthenticated  → no Clerk session
 *   - 403 forbidden        → user has no Notion OAuth token
 *   - 404 not_found        → workspace row missing (shouldn't happen post-callback)
 *   - 502 upstream_failure → Notion API errored on `getPage` (non-404)
 *   - 500 internal         → installer threw something other than missing-parent
 *
 * Idempotency: the installer's `precheck-existing-install` step short-circuits
 * to a no-op return if the workspace already has all six Forge IDs persisted
 * AND the Notion page still exists. The response shape is identical whether
 * we installed fresh or no-opped.
 */

import { prisma, recordAuditEvent } from '@forge/db';
import type {
  InstallerDbClient,
  WorkspaceForgeRecord,
} from '@forge/installer';
import { InstallerError, installForgePage } from '@forge/installer';
import { asPageId, getPage, NotionNotFoundError } from '@forge/notion-client';
import * as Sentry from '@sentry/nextjs';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { requireWorkspace } from '@/lib/auth';
import { apiError } from '@/lib/errors';
import { buildNotionConfig, getNotionTokenForClerkUser } from '@/lib/notion';
import { capture } from '@/lib/posthog';
import { checkRateLimit, createRateLimiter } from '@/lib/ratelimit';
import { withSentry } from '@/lib/sentry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Notion IDs are UUIDs; the API accepts both the dashed (36-char) and
 * compact (32-char hex) forms. Match either. We do not normalize because
 * `getPage` accepts both.
 */
const parentPageIdRegex = /^[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}$/;

const installBodySchema = z.object({
  parentPageId: z
    .string()
    .min(32)
    .max(36)
    .regex(parentPageIdRegex, 'parentPageId must be a Notion UUID'),
});

/**
 * Same adapter shape the OAuth callback builds. Kept inline here (rather
 * than extracted to `@/lib/installer-db`) so the callback stays the single
 * source of truth for adapter behavior — changes there propagate by copy,
 * not by import surface. If we add a third installer caller we should
 * extract.
 */
function buildInstallerDbAdapter(): InstallerDbClient {
  return {
    async getWorkspaceForgeRecord(workspaceId) {
      const w = await prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: {
          forgePageId: true,
          forgeDbId: true,
          forgeAgentsDbId: true,
          forgeButtonBlockId: true,
          forgeBuildLogBlockId: true,
          webhookSecret: true,
        },
      });
      if (!w) return null;
      return {
        forgePageId: w.forgePageId,
        forgeDbId: w.forgeDbId,
        forgeAgentsDbId: w.forgeAgentsDbId,
        forgeButtonBlockId: w.forgeButtonBlockId,
        forgeBuildLogBlockId: w.forgeBuildLogBlockId,
        webhookSecret: w.webhookSecret,
      };
    },
    async updateWorkspaceForgeRecord(workspaceId, patch) {
      const data: Partial<WorkspaceForgeRecord> = {};
      if (patch.forgePageId !== undefined) data.forgePageId = patch.forgePageId;
      if (patch.forgeDbId !== undefined) data.forgeDbId = patch.forgeDbId;
      if (patch.forgeAgentsDbId !== undefined)
        data.forgeAgentsDbId = patch.forgeAgentsDbId;
      if (patch.forgeButtonBlockId !== undefined)
        data.forgeButtonBlockId = patch.forgeButtonBlockId;
      if (patch.forgeBuildLogBlockId !== undefined)
        data.forgeBuildLogBlockId = patch.forgeBuildLogBlockId;
      if (patch.webhookSecret !== undefined)
        data.webhookSecret = patch.webhookSecret;
      await prisma.workspace.update({
        where: { id: workspaceId },
        data,
      });
    },
  };
}

export const POST = withSentry(
  async (req) => {
    const r = await requireWorkspace();
    if (!r.ok) return r.response;
    const { clerkId, user, workspace } = r.ctx;

    // Per-user rate limit: 10/min. The installer is idempotent but each
    // call touches Notion (page fetch + block creates) and we don't want
    // a stuck UI to drum the Notion API.
    const rl = await checkRateLimit(
      createRateLimiter('onboarding.install', 10, '1 m'),
      user.id,
    );
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

    // ── Body parse + validate ─────────────────────────────────────────────
    let json: unknown;
    try {
      json = await req.json();
    } catch {
      return apiError('validation', 'Body must be valid JSON.');
    }
    const parsed = installBodySchema.safeParse(json);
    if (!parsed.success) {
      return apiError('validation', 'Invalid request body.', {
        issues: parsed.error.issues,
      });
    }
    const { parentPageId } = parsed.data;

    if (!workspace.notionWorkspaceId) {
      // Defensive — the OAuth callback always sets this. If it's missing
      // something invariant-breaking happened upstream.
      return apiError(
        'not_found',
        'Workspace has no Notion workspace id. Re-link Notion in /sign-in.',
      );
    }

    // ── Notion token ──────────────────────────────────────────────────────
    const notionToken = await getNotionTokenForClerkUser(clerkId);
    if (!notionToken) {
      return apiError(
        'forbidden',
        'No Notion access token on this user. Re-link Notion in /sign-in.',
      );
    }
    const notionConfig = buildNotionConfig(notionToken);

    // ── Verify the parent page exists + integration can see it ────────────
    try {
      const page = await getPage(notionConfig, asPageId(parentPageId));
      if (page.archived || page.in_trash) {
        return apiError(
          'validation',
          'The picked Notion page is archived. Pick a non-archived page.',
        );
      }
    } catch (err) {
      if (err instanceof NotionNotFoundError) {
        return apiError(
          'validation',
          'Notion could not find this page, or the Forge integration does not have access. Share the page with the Forge integration and try again.',
        );
      }
      const message = err instanceof Error ? err.message : 'unknown';
      return apiError(
        'upstream_failure',
        `Notion getPage failed: ${message}`,
      );
    }

    // ── Run the installer (idempotent) ────────────────────────────────────
    const appUrl =
      process.env['NEXT_PUBLIC_APP_URL'] ?? 'http://localhost:3000';

    try {
      const result = await installForgePage(
        {
          notionToken,
          workspaceId: workspace.id,
          notionWorkspaceId: workspace.notionWorkspaceId,
          parentPageId,
          appUrl,
        },
        buildInstallerDbAdapter(),
      );

      // Best-effort audit + analytics — never block the success response.
      try {
        await recordAuditEvent({
          workspaceId: workspace.id,
          userId: clerkId,
          action: 'workspace.installed',
          resourceType: 'workspace',
          resourceId: workspace.id,
          metadata: {
            forgePageId: result.pageId,
            forgeDbId: result.requestsDbId,
          },
        });
      } catch (auditErr) {
        Sentry.captureException(auditErr, {
          tags: { phase: 'audit.workspace.installed' },
        });
      }

      try {
        await capture({
          distinctId: clerkId,
          event: 'forge.workspace.installed',
          workspaceId: workspace.id,
          properties: { forgePageId: result.pageId, viaPicker: true },
        });
      } catch (captureErr) {
        Sentry.captureException(captureErr, {
          tags: { phase: 'posthog.workspace.installed' },
        });
      }

      return NextResponse.json({
        ok: true,
        redirect: '/dashboard',
        pageId: result.pageId,
        requestsDbId: result.requestsDbId,
        agentsDbId: result.agentsDbId,
        buildLogBlockId: result.buildLogBlockId,
        buttonBlockId: result.buttonBlockId,
      });
    } catch (installErr) {
      Sentry.captureException(installErr, {
        tags: {
          phase: 'installer.onboarding',
          workspaceId: workspace.id,
        },
      });

      if (installErr instanceof InstallerError) {
        return NextResponse.json(
          {
            error: 'upstream_failure',
            message: `Forge install failed at step "${installErr.step}".`,
            step: installErr.step,
          },
          { status: 502 },
        );
      }

      const message =
        installErr instanceof Error
          ? installErr.message
          : 'unexpected installer error';
      return apiError('internal', message);
    }
  },
  { routeName: 'onboarding.install' },
);
