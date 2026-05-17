/**
 * POST /api/auth/notion/callback — Notion OAuth completion.
 *
 * Clerk's Notion OAuth proxy hands control back here after the user grants
 * consent. Clerk has already stored the Notion access token + workspace
 * metadata on the user object; we read it back via `clerkClient` and persist
 * to PlanetScale.
 *
 * Sequence:
 *   1. `requireUser()` — must have a Clerk session.
 *   2. Pull Notion token from Clerk (`oauth_notion`).
 *   3. Parse workspace metadata from the token payload (Notion returns
 *      `workspace_id` + `workspace_name` in the OAuth response, which Clerk
 *      mirrors on the linked-account object).
 *   4. `upsertWorkspace()` and bind the local `User` row to it.
 *   5. Best-effort call into `@forge/installer` to create the Forge page.
 *      Errors logged to Sentry but the callback still succeeds.
 *   6. Audit `workspace.installed` (best-effort).
 *   7. 303 redirect to `/agents`.
 */

import { clerkClient } from '@clerk/nextjs/server';
import { prisma, recordAuditEvent, upsertWorkspace } from '@forge/db';
import { InstallerError, installForgePage } from '@forge/installer';
import type {
  InstallerDbClient,
  WorkspaceForgeRecord,
} from '@forge/installer';
import * as Sentry from '@sentry/nextjs';
import { NextResponse } from 'next/server';

import { requireUser } from '@/lib/auth';
import { apiError } from '@/lib/errors';
import { capture } from '@/lib/posthog';
import { withSentry } from '@/lib/sentry';

/**
 * Minimal `InstallerDbClient` adapter wired to the workspace repository.
 *
 * The installer expects a structural slice — it never touches Prisma
 * directly so we keep the coupling at this boundary (this file). The
 * adapter ONLY persists the install-time forge IDs + webhook secret; it
 * does NOT touch name / ownerUserId / installedAt (those live in the
 * upstream `upsertWorkspace` call that runs before the installer).
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

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface ClerkOauthAccount {
  token: string;
  provider: string;
  externalAccountId?: string;
  publicMetadata?: Record<string, unknown>;
  // Notion-specific fields surfaced by Clerk's OAuth proxy:
  workspaceId?: string;
  workspaceName?: string;
}

export const POST = withSentry(
  async () => {
    const r = await requireUser();
    if (!r.ok) return r.response;
    const { userId: clerkUserId, email } = r;

    const cc = await clerkClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const oauthResp = (await (cc.users as any).getUserOauthAccessToken(
      clerkUserId,
      'oauth_notion',
    )) as { data: ClerkOauthAccount[] } | ClerkOauthAccount[];

    const accounts = Array.isArray(oauthResp) ? oauthResp : oauthResp.data;
    const account = accounts[0];
    if (!account?.token) {
      Sentry.captureMessage('notion-callback: no notion oauth token on user', {
        level: 'warning',
        tags: { clerkUserId },
      });
      return apiError(
        'forbidden',
        'Notion OAuth did not return an access token. Re-link Notion in /sign-in.',
      );
    }

    // Notion's token payload contains workspace_id + workspace_name; Clerk
    // surfaces these on the linked-account object. Fall back to publicMetadata
    // where Clerk versions vary.
    const notionWorkspaceId =
      account.workspaceId ??
      (account.publicMetadata?.['workspace_id'] as string | undefined);
    const notionWorkspaceName =
      account.workspaceName ??
      (account.publicMetadata?.['workspace_name'] as string | undefined) ??
      'Untitled Workspace';

    if (!notionWorkspaceId) {
      Sentry.captureMessage('notion-callback: missing workspace_id in token', {
        level: 'error',
        tags: { clerkUserId },
      });
      return apiError(
        'upstream_failure',
        'Notion OAuth response did not include a workspace id.',
      );
    }

    const workspace = await upsertWorkspace({
      notionWorkspaceId,
      name: notionWorkspaceName,
      ownerUserId: clerkUserId,
    });

    // Materialize the local `User` row if absent, and bind to workspace.
    await prisma.user.upsert({
      where: { clerkId: clerkUserId },
      create: {
        clerkId: clerkUserId,
        email: email ?? `${clerkUserId}@noemail.local`,
        workspaceId: workspace.id,
      },
      update: {
        workspaceId: workspace.id,
        ...(email && { email }),
      },
    });

    // Fire-and-log installer; failures must NOT block the callback. The
    // installer is idempotent — if `parentPageId` is missing on first run
    // (the user hasn't picked a page yet) it throws; the dashboard's
    // /settings page surfaces a "finish install" flow that re-calls with
    // the picked page.
    //
    // Parent page id selection: in v1 we read it from a Notion-set query
    // param the OAuth proxy passes through. The picker UI is tracked
    // separately — for now we attempt install only when present, and let
    // the install retry on the next page load.
    const parentPageId =
      (account.publicMetadata?.['parent_page_id'] as string | undefined) ??
      undefined;
    const appUrl =
      process.env['NEXT_PUBLIC_APP_URL'] ?? 'http://localhost:3000';

    try {
      const result = await installForgePage(
        {
          notionToken: account.token,
          workspaceId: workspace.id,
          notionWorkspaceId,
          ...(parentPageId ? { parentPageId } : {}),
          appUrl,
        },
        buildInstallerDbAdapter(),
      );

      // The installer already persisted all 6 fields via the adapter — no
      // second upsert needed. Audit + analytics best-effort below.
      try {
        await recordAuditEvent({
          workspaceId: workspace.id,
          userId: clerkUserId,
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

      // OAuth grant audit (now that the union supports `oauth.granted` with
      // a `provider` field).
      try {
        await recordAuditEvent({
          workspaceId: workspace.id,
          userId: clerkUserId,
          action: 'oauth.granted',
          resourceType: 'oauth',
          resourceId: 'notion',
          metadata: { provider: 'notion', scopes: [] },
        });
      } catch (auditErr) {
        Sentry.captureException(auditErr, {
          tags: { phase: 'audit.oauth.granted' },
        });
      }

      await capture({
        distinctId: clerkUserId,
        event: 'forge.workspace.installed',
        workspaceId: workspace.id,
        properties: { forgePageId: result.pageId },
      });
    } catch (installErr) {
      Sentry.captureException(installErr, {
        tags: { phase: 'installer', workspaceId: workspace.id },
      });

      // Notion's REST API requires a parent page for `POST /v1/pages`. If we
      // got here without one, the installer threw `InstallerError(step:
      // 'create-root-page')`. Bounce the user to the picker flow so they
      // can choose a page; the picker re-calls the installer with the
      // selected id.
      const isMissingParent =
        installErr instanceof InstallerError &&
        installErr.step === 'create-root-page' &&
        !parentPageId;
      if (isMissingParent) {
        const pickerUrl = new URL(
          '/onboarding/pick-parent',
          process.env['NEXT_PUBLIC_APP_URL'] ?? 'http://localhost:3000',
        );
        return NextResponse.redirect(pickerUrl, { status: 303 });
      }
    }

    // 303 ensures the browser issues a GET to /agents (POST→GET semantic).
    const target = new URL(
      '/agents',
      process.env['NEXT_PUBLIC_APP_URL'] ?? 'http://localhost:3000',
    );
    return NextResponse.redirect(target, { status: 303 });
  },
  { routeName: 'auth.notion.callback' },
);
