/**
 * Uninstaller — user-requested removal of the Forge surface from a
 * workspace.
 *
 * Notion's REST API does not expose a true "delete page" — every delete
 * is a soft archive. We:
 *   1. Archive the root page (`archived: true`). Notion cascades the
 *      archive to its children, so the Requests DB, Agents DB, button,
 *      and Build Log container all disappear together.
 *   2. Null out the forge*Id columns on the Workspace row so a future
 *      `installForgePage` runs a fresh install rather than no-opping.
 *   3. **Preserve `webhookSecret`** — if the user re-installs, we want
 *      old webhook URLs that may still be queued to keep verifying. The
 *      next install reuses the same secret.
 *
 * We do NOT:
 *   - Delete any GeneratedAgent rows or Generation history. Forge keeps
 *     the audit trail; the user can re-link by re-installing.
 *   - Revoke the OAuth token. That's a Clerk-side concern.
 */

import { archivePage, asPageId } from '@forge/notion-client';
import type { Logger, NotionClientConfig } from '@forge/notion-client';

import { InstallerError } from './errors.js';
import type { InstallOptions, InstallerDbClient } from './types.js';

export async function uninstallForgePage(
  opts: InstallOptions,
  db: InstallerDbClient,
  logger?: Logger,
): Promise<void> {
  const row = await db.getWorkspaceForgeRecord(opts.workspaceId);

  if (!row?.forgePageId) {
    // Nothing to do — but we don't throw, so the caller can use this as
    // an idempotent "remove me" endpoint.
    logger?.info?.('[uninstaller] no forge page on record; nothing to archive', {
      workspaceId: opts.workspaceId,
    });
    return;
  }

  const notionConfig: NotionClientConfig = {
    token: opts.notionToken,
    ...(opts.notion?.fetch ? { fetch: opts.notion.fetch } : {}),
    ...(opts.notion?.baseUrl ? { baseUrl: opts.notion.baseUrl } : {}),
    ...(opts.notion?.notionVersion
      ? { notionVersion: opts.notion.notionVersion }
      : {}),
    ...(opts.notion?.pacer ? { pacer: opts.notion.pacer } : {}),
  };

  try {
    await archivePage(notionConfig, asPageId(row.forgePageId));
  } catch (error) {
    throw new InstallerError('failed to archive Forge root page', {
      step: 'archive-root-page',
      workspaceId: opts.workspaceId,
      cause: error,
    });
  }

  await db.updateWorkspaceForgeRecord(opts.workspaceId, {
    forgePageId: null,
    forgeDbId: null,
    forgeAgentsDbId: null,
    forgeButtonBlockId: null,
    forgeBuildLogBlockId: null,
    // Intentionally NOT clearing webhookSecret — see file header.
  });
}
