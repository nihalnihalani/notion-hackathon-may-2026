/**
 * Reconciler — verify the Forge surface still has the expected blocks
 * + DB columns and patch any gaps. Runs on every user login from the
 * Vercel auth callback.
 *
 * Rules:
 *   - **Never destroys**: missing columns get added; existing rows /
 *     columns are left alone, even if the user renamed them.
 *   - **Idempotent**: calling reconcile on a healthy install returns
 *     `{ changes: [] }` without side effects.
 *   - **Cheap**: at most one GET per resource type + ≤2 PATCH/POSTs in
 *     the steady state. We do not crawl the whole page.
 *
 * What we reconcile today:
 *   1. **Workspace row completeness** — if any forge*Id column is null
 *      but the row exists, we delegate to a full re-install of the
 *      missing pieces only (not yet implemented; for v1 we just log and
 *      let the next auth callback rerun `installForgePage`).
 *   2. **Button block present** — if `forgeButtonBlockId` is null OR the
 *      block returns 404, append a fresh bookmark and update the row.
 *   3. **Build Log container present** — same, with the synced/toggle
 *      fallback path.
 *   4. **Webhook secret present** — if missing (older install), mint one.
 *
 * What we explicitly do NOT reconcile in v1 (deferred to Devil's
 * Advocate review):
 *   - Database property schema (`buildForgeRequestsDbSchema` outputs).
 *     The Notion users may have renamed columns; auto-adding "missing"
 *     ones would create dupes. The plan calls for reconcile-without-
 *     destroy: we'd need a fuzzy-match step that's out of scope for v1.
 */

import {
  appendBlocks,
  asBlockId,
  asPageId,
  getBlock,
  getPage,
  NotionNotFoundError,
} from '@forge/notion-client';
import type { Logger, NotionClientConfig } from '@forge/notion-client';

import { buildForgeButtonBookmark } from './block-builders.js';
import { InstallerError } from './errors.js';
import type {
  InstallOptions,
  InstallerDbClient,
  ReconcileResult,
} from './types.js';
import { generateWorkspaceWebhookSecret } from './webhook-secret.js';

/** True if a getBlock/getPage 404 means "block is gone". */
function isGone(err: unknown): boolean {
  return err instanceof NotionNotFoundError;
}

export async function reconcileForgePage(
  opts: InstallOptions,
  db: InstallerDbClient,
  logger?: Logger,
): Promise<ReconcileResult> {
  const notionConfig: NotionClientConfig = {
    token: opts.notionToken,
    ...(opts.notion?.fetch ? { fetch: opts.notion.fetch } : {}),
    ...(opts.notion?.baseUrl ? { baseUrl: opts.notion.baseUrl } : {}),
    ...(opts.notion?.notionVersion
      ? { notionVersion: opts.notion.notionVersion }
      : {}),
    ...(opts.notion?.pacer ? { pacer: opts.notion.pacer } : {}),
  };
  const changes: string[] = [];

  const row = await db.getWorkspaceForgeRecord(opts.workspaceId);
  if (!row) {
    // First-ever login — caller should have run `installForgePage` first.
    throw new InstallerError(
      'reconcile called before install: no Workspace row found',
      { step: 'reconcile', workspaceId: opts.workspaceId },
    );
  }

  // ── 0. mint a webhook secret if missing (older installs) ───────────────
  if (!row.webhookSecret) {
    const secret = generateWorkspaceWebhookSecret();
    await db.updateWorkspaceForgeRecord(opts.workspaceId, {
      webhookSecret: secret,
    });
    changes.push('minted webhook secret');
    logger?.info?.('[reconciler] minted webhook secret', {
      workspaceId: opts.workspaceId,
    });
  }

  // ── 1. workspace row completeness ──────────────────────────────────────
  if (
    !row.forgePageId ||
    !row.forgeDbId ||
    !row.forgeAgentsDbId
  ) {
    // Hard precondition for the rest of reconcile. Caller path: route to
    // the full installer (the orchestrator's auth-callback already does
    // this; reconcile is the cheap-path).
    throw new InstallerError(
      'reconcile cannot run: Workspace row missing core IDs; rerun installForgePage',
      { step: 'reconcile', workspaceId: opts.workspaceId },
    );
  }

  // ── 1.b. verify the root page still exists ─────────────────────────────
  try {
    const page = await getPage(notionConfig, asPageId(row.forgePageId));
    if (page.archived || page.in_trash) {
      throw new InstallerError(
        'forge page is archived; full re-install required',
        { step: 'reconcile', workspaceId: opts.workspaceId },
      );
    }
  } catch (error) {
    if (isGone(error)) {
      throw new InstallerError(
        'forge page returned 404; full re-install required',
        { step: 'reconcile', workspaceId: opts.workspaceId, cause: error },
      );
    }
    throw error;
  }

  // ── 2. button block ────────────────────────────────────────────────────
  const webhookUrl =
    `${opts.appUrl.replace(/\/+$/, '')}/api/webhooks/notion-button` +
    `?ws=${encodeURIComponent(opts.notionWorkspaceId)}`;

  let buttonOk = false;
  if (row.forgeButtonBlockId) {
    try {
      const blk = await getBlock(notionConfig, asBlockId(row.forgeButtonBlockId));
      if (!blk.archived && !blk.in_trash) buttonOk = true;
    } catch (error) {
      if (!isGone(error)) throw error;
    }
  }
  if (!buttonOk) {
    const resp = await appendBlocks(notionConfig, asBlockId(row.forgePageId), [
      buildForgeButtonBookmark(webhookUrl),
    ]);
    const newBlk = resp.results[0];
    if (newBlk) {
      await db.updateWorkspaceForgeRecord(opts.workspaceId, {
        forgeButtonBlockId: newBlk.id,
      });
      changes.push('re-added forge button block');
    }
  }

  // ── 3. build log container ─────────────────────────────────────────────
  let buildLogOk = false;
  if (row.forgeBuildLogBlockId) {
    try {
      const blk = await getBlock(
        notionConfig,
        asBlockId(row.forgeBuildLogBlockId),
      );
      if (!blk.archived && !blk.in_trash) buildLogOk = true;
    } catch (error) {
      if (!isGone(error)) throw error;
    }
  }
  if (!buildLogOk) {
    // Re-installing a build log container is non-trivial because the
    // orchestrator's append target ID changes. We defer to a full
    // install rerun by throwing — the caller (auth callback) will
    // catch + dispatch to `installForgePage`.
    throw new InstallerError(
      'build log container missing; full re-install required',
      { step: 'reconcile', workspaceId: opts.workspaceId },
    );
  }

  return { changes };
}
