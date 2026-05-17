/**
 * POST /api/settings/uninstall — user-requested removal of the Forge
 * surface from their Notion workspace.
 *
 * Workflow:
 *   1. Auth + workspace bind.
 *   2. **Workspace-owner gate**: only the user whose id matches
 *      `Workspace.ownerUserId` may invoke this — co-collaborators get 403.
 *   3. Confirm-string check: body must include `{ confirm: "UNINSTALL" }`
 *      verbatim. This is the last guard against an autopilot click on a
 *      destructive operation.
 *   4. Call `@forge/installer`'s `uninstallForgePage`, which archives the
 *      root Notion page (cascade-archives the Requests DB, Agents DB,
 *      button, Build Log container).
 *   5. Mark every `GeneratedAgent` row for this workspace as `retracted`.
 *      The NTN workers themselves are NOT deleted here — the orchestrator
 *      will reap them on next reconcile.
 *   6. Audit log + analytics.
 *
 * Forge's audit trail + Generation history are preserved in PlanetScale —
 * see the comment block in `packages/installer/src/uninstaller.ts`.
 *
 * Returns 200 `{ ok: true, redirect: '/' }` on success (including the
 * "nothing to archive" branch). 502 if the Notion archive fails.
 * 400 if the confirm string is missing or wrong. 403 if the caller isn't
 * the workspace owner.
 */

import { prisma, recordAuditEvent } from '@forge/db';
import { uninstallForgePage } from '@forge/installer';
import type { InstallerDbClient, WorkspaceForgeRecord } from '@forge/installer';
import * as Sentry from '@sentry/nextjs';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { requireWorkspace } from '@/lib/auth';
import { apiError } from '@/lib/errors';
import { getNotionTokenForClerkUser } from '@/lib/notion';
import { capture } from '@/lib/posthog';
import { checkRateLimit, limiters } from '@/lib/ratelimit';
import { withSentry } from '@/lib/sentry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  // Must match this magic value EXACTLY. The frontend asks the user to
  // type it; anything else is presumed accidental.
  confirm: z.literal('UNINSTALL'),
});

/**
 * Same adapter shape used by the OAuth callback — kept inlined here so
 * this handler doesn't depend on the callback module.
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
      if (patch.forgeAgentsDbId !== undefined) data.forgeAgentsDbId = patch.forgeAgentsDbId;
      if (patch.forgeButtonBlockId !== undefined)
        data.forgeButtonBlockId = patch.forgeButtonBlockId;
      if (patch.forgeBuildLogBlockId !== undefined)
        data.forgeBuildLogBlockId = patch.forgeBuildLogBlockId;
      if (patch.webhookSecret !== undefined) data.webhookSecret = patch.webhookSecret;
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
    const { user, workspace, clerkId } = r.ctx;

    const rl = await checkRateLimit(limiters.agentMutation(), user.id);
    if (!rl.success) {
      return apiError('rate_limited', 'Too many uninstall attempts.');
    }

    // Workspace-owner gate. `ownerUserId` is set at install time to the
    // Clerk user id of the user who connected Notion (see the OAuth
    // callback). Anyone else on the workspace (future multi-user) gets
    // 403 — they should ask the owner to uninstall.
    if (workspace.ownerUserId !== clerkId) {
      return apiError('forbidden', 'Only the workspace owner can uninstall Forge.');
    }

    // Body parse + confirm-string check. We treat an empty/JSON-less body
    // as a validation failure rather than throwing — the frontend has to
    // pass `{ confirm: "UNINSTALL" }` to proceed.
    let json: unknown = {};
    try {
      json = await req.json();
    } catch {
      // Some legacy clients call POST with no body. Fall through to the
      // schema check below so the user gets a uniform validation error.
    }
    const parsed = bodySchema.safeParse(json);
    if (!parsed.success) {
      return apiError('validation', 'Body must include `{ "confirm": "UNINSTALL" }`.', {
        issues: parsed.error.issues,
      });
    }

    const token = await getNotionTokenForClerkUser(clerkId);
    if (!token) {
      return apiError('forbidden', 'Notion OAuth token missing — sign in with Notion first.');
    }

    try {
      await uninstallForgePage(
        {
          notionToken: token,
          workspaceId: workspace.id,
          notionWorkspaceId: workspace.notionWorkspaceId,
          appUrl: process.env['NEXT_PUBLIC_APP_URL'] ?? 'http://localhost:3000',
        },
        buildInstallerDbAdapter(),
      );
    } catch (error) {
      Sentry.captureException(error, {
        tags: { phase: 'installer.uninstall', workspaceId: workspace.id },
      });
      return apiError('upstream_failure', 'uninstallForgePage failed.');
    }

    // Mark every non-retracted GeneratedAgent row as retracted. Best-effort:
    // a transient DB error here should not fail the uninstall — the
    // installer side has already archived the Notion page so the user's
    // mental model says "it's gone". A nightly reconciler can sweep any
    // stragglers.
    try {
      await prisma.generatedAgent.updateMany({
        where: { workspaceId: workspace.id, status: { not: 'retracted' } },
        data: { status: 'retracted' },
      });
    } catch (error) {
      Sentry.captureException(error, {
        tags: {
          phase: 'workspace.uninstall.retract_agents',
          workspaceId: workspace.id,
        },
      });
    }

    try {
      await recordAuditEvent({
        workspaceId: workspace.id,
        userId: clerkId,
        action: 'workspace.uninstalled',
        resourceType: 'workspace',
        resourceId: workspace.id,
        metadata: {},
      });
    } catch (error) {
      Sentry.captureException(error, {
        tags: { phase: 'audit.workspace.uninstalled' },
      });
    }

    await capture({
      distinctId: user.id,
      event: 'forge.workspace.uninstalled',
      workspaceId: workspace.id,
    });

    return NextResponse.json({ ok: true, redirect: '/' });
  },
  { routeName: 'settings.uninstall' },
);
