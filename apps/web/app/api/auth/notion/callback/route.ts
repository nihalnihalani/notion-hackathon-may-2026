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
import * as Sentry from '@sentry/nextjs';
import { NextResponse } from 'next/server';

import { requireUser } from '@/lib/auth';
import { apiError } from '@/lib/errors';
import { installForgePage } from '@/lib/installer';
import { capture } from '@/lib/posthog';
import { withSentry } from '@/lib/sentry';

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

    // Fire-and-log installer; failures must NOT block the callback.
    try {
      const result = await installForgePage({
        notionToken: account.token,
        workspaceId: workspace.id,
        notionWorkspaceId,
      });
      await upsertWorkspace({
        notionWorkspaceId,
        name: notionWorkspaceName,
        ownerUserId: clerkUserId,
        forgePageId: result.forgePageId,
        forgeDbId: result.forgeDbId,
      });

      // Audit + analytics — also best-effort.
      try {
        await recordAuditEvent({
          workspaceId: workspace.id,
          userId: clerkUserId,
          action: 'workspace.installed',
          resourceType: 'workspace',
          resourceId: workspace.id,
          metadata: {
            forgePageId: result.forgePageId,
            forgeDbId: result.forgeDbId,
          },
        });
      } catch (auditErr) {
        Sentry.captureException(auditErr, {
          tags: { phase: 'audit.workspace.installed' },
        });
      }
      await capture({
        distinctId: clerkUserId,
        event: 'workspace.installed',
        workspaceId: workspace.id,
        properties: { forgePageId: result.forgePageId },
      });
    } catch (installErr) {
      Sentry.captureException(installErr, {
        tags: { phase: 'installer', workspaceId: workspace.id },
      });
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
