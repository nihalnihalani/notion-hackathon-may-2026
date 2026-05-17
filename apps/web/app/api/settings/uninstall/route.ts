/**
 * POST /api/settings/uninstall — user-requested removal of the Forge
 * surface from their Notion workspace.
 *
 * Calls `@forge/installer`'s `uninstallForgePage`, which archives the
 * root page in Notion (cascade-archives the Requests DB, Agents DB,
 * button, Build Log container). Forge's audit trail + Generation history
 * are preserved in PlanetScale — see the comment block in
 * `packages/installer/src/uninstaller.ts`.
 *
 * Returns 200 with `{ ok: true }` on success (including the "nothing to
 * do" branch). 502 if the Notion archive fails. Audit best-effort.
 */

import { prisma, recordAuditEvent } from '@forge/db';
import { uninstallForgePage } from '@forge/installer';
import type {
  InstallerDbClient,
  WorkspaceForgeRecord,
} from '@forge/installer';
import * as Sentry from '@sentry/nextjs';
import { NextResponse } from 'next/server';

import { requireWorkspace } from '@/lib/auth';
import { apiError } from '@/lib/errors';
import { getNotionTokenForClerkUser } from '@/lib/notion';
import { capture } from '@/lib/posthog';
import { checkRateLimit, limiters } from '@/lib/ratelimit';
import { withSentry } from '@/lib/sentry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Same adapter shape used by the OAuth callback — kept inlined here so
 *  this handler doesn't depend on the callback module. */
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
  async () => {
    const r = await requireWorkspace();
    if (!r.ok) return r.response;
    const { user, workspace, clerkId } = r.ctx;

    const rl = await checkRateLimit(limiters.agentMutation(), user.id);
    if (!rl.success) {
      return apiError('rate_limited', 'Too many uninstall attempts.');
    }

    const token = await getNotionTokenForClerkUser(clerkId);
    if (!token) {
      return apiError(
        'forbidden',
        'Notion OAuth token missing — sign in with Notion first.',
      );
    }

    try {
      await uninstallForgePage(
        {
          notionToken: token,
          workspaceId: workspace.id,
          notionWorkspaceId: workspace.notionWorkspaceId,
          appUrl:
            process.env['NEXT_PUBLIC_APP_URL'] ?? 'http://localhost:3000',
        },
        buildInstallerDbAdapter(),
      );
    } catch (err) {
      Sentry.captureException(err, {
        tags: { phase: 'installer.uninstall', workspaceId: workspace.id },
      });
      return apiError('upstream_failure', 'uninstallForgePage failed.');
    }

    try {
      await recordAuditEvent({
        workspaceId: workspace.id,
        userId: clerkId,
        action: 'oauth.revoked',
        resourceType: 'workspace',
        resourceId: workspace.id,
        metadata: { provider: 'notion' },
      });
    } catch (err) {
      Sentry.captureException(err, {
        tags: { phase: 'audit.oauth.revoked' },
      });
    }

    await capture({
      distinctId: user.id,
      event: 'forge.workspace.uninstalled',
      workspaceId: workspace.id,
    });

    return NextResponse.json({ ok: true });
  },
  { routeName: 'settings.uninstall' },
);
