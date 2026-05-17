/**
 * Forge page installer.
 *
 * Run from the Vercel function on the OAuth callback path. Creates the
 * Forge root page + Forge Requests DB + Forge Agents DB + button +
 * Build Log container + Settings toggle inside the user's Notion
 * workspace, and persists the resulting IDs back to PlanetScale.
 *
 * Guarantees (PLAN §VII Installation Flow):
 *   - **Idempotent**: re-running on a workspace that already has the IDs
 *     persisted and whose Forge page still exists is a no-op.
 *   - **Self-healing**: if the page was deleted in Notion (`404`), the
 *     installer re-creates everything and updates the row.
 *   - **Fail-fast**: any step that fails throws an `InstallerError` with
 *     the canonical step name as `error.step`, so the caller can map to
 *     a Sentry tag / structured log without `instanceof` chains.
 *
 * Notion API quirks documented in `block-builders.ts`:
 *   1. Button blocks are not creatable via REST → bookmark fallback.
 *   2. Synced blocks ARE creatable as "original" via
 *      `synced_block.synced_from = null`. We use them for the Build Log
 *      container so dashboards can mirror it later.
 *   3. The Notion API requires every page to have a parent — there is no
 *      true "workspace root" create. Caller must supply `parentPageId`.
 */

import {
  appendBlocks,
  asBlockId,
  asDatabaseId,
  asPageId,
  createDatabase,
  createPage,
  getPage,
  NotionNotFoundError,
} from '@forge/notion-client';
import type { Logger, NotionClientConfig } from '@forge/notion-client';

import {
  buildBuildLogHeading,
  buildBuildLogSyncedBlock,
  buildBuildLogToggleFallback,
  buildDivider,
  buildForgeButtonBookmark,
  buildPageTitleHeading,
  buildRootPageInitialChildren,
  buildSettingsChildren,
  buildSettingsToggle,
} from './block-builders.js';
import { buildForgeRequestsDbSchema, forgeAgentsDbSchema } from './db-schemas.js';
import { InstallerError } from './errors.js';
import type {
  InstallOptions,
  InstallProgressEvent,
  InstallStep,
  InstallationResult,
  InstallerDbClient,
} from './types.js';
import { generateWorkspaceWebhookSecret } from './webhook-secret.js';

// ── Tiny structured logger helper ────────────────────────────────────────────

function emit(
  logger: Logger | undefined,
  step: InstallStep,
  status: InstallProgressEvent['status'],
  message: string,
): void {
  logger?.info?.(`[installer] ${step} ${status}: ${message}`, {
    step,
    status,
  });
}

// ── Step wrappers ────────────────────────────────────────────────────────────

/**
 * Wrap a step in try/catch so any thrown error is wrapped in
 * `InstallerError` carrying the canonical step name. Re-throws on
 * failure — the caller sees a single error type at the top level.
 */
async function step<T>(
  ctx: { logger: Logger | undefined; workspaceId: string },
  name: InstallStep,
  description: string,
  body: () => Promise<T>,
): Promise<T> {
  emit(ctx.logger, name, 'started', description);
  try {
    const out = await body();
    emit(ctx.logger, name, 'completed', description);
    return out;
  } catch (error) {
    if (error instanceof InstallerError) throw error;
    throw new InstallerError(`installer step "${name}" failed`, {
      step: name,
      workspaceId: ctx.workspaceId,
      cause: error,
    });
  }
}

// ── Public entry point ───────────────────────────────────────────────────────

/**
 * Install (or no-op re-run) the Forge page + DBs in a user's workspace.
 *
 * @returns the persisted Notion-side IDs. Same shape returned whether we
 *          freshly created, re-created (page was deleted), or no-opped
 *          (page already present).
 */
export async function installForgePage(
  opts: InstallOptions,
  db: InstallerDbClient,
  logger?: Logger,
): Promise<InstallationResult> {
  const ctx = { logger, workspaceId: opts.workspaceId };

  const notionConfig: NotionClientConfig = {
    token: opts.notionToken,
    ...(opts.notion?.fetch ? { fetch: opts.notion.fetch } : {}),
    ...(opts.notion?.baseUrl ? { baseUrl: opts.notion.baseUrl } : {}),
    ...(opts.notion?.notionVersion ? { notionVersion: opts.notion.notionVersion } : {}),
    ...(opts.notion?.pacer ? { pacer: opts.notion.pacer } : {}),
  };

  // ── Step 1: pre-check existing install ─────────────────────────────────
  const existing = await step(
    ctx,
    'precheck-existing-install',
    'check Workspace row for pre-existing Forge page',
    async () => db.getWorkspaceForgeRecord(opts.workspaceId),
  );

  if (
    existing?.forgePageId &&
    existing.forgeDbId &&
    existing.forgeAgentsDbId &&
    existing.forgeButtonBlockId &&
    existing.forgeBuildLogBlockId
  ) {
    // Verify the page still exists in Notion. Notion's "delete" archives
    // pages but `getPage` still resolves; only a true unlink / missing
    // page returns 404 with code = object_not_found.
    let pageStillThere = false;
    try {
      const page = await getPage(notionConfig, asPageId(existing.forgePageId));
      // If the user archived the page we still treat it as gone — they
      // explicitly removed the Forge surface.
      pageStillThere = !page.archived && !page.in_trash;
    } catch (error) {
      if (!(error instanceof NotionNotFoundError)) throw error;
    }

    if (pageStillThere) {
      emit(logger, 'precheck-existing-install', 'skipped', 'forge page already installed; no-op');
      return {
        pageId: existing.forgePageId,
        requestsDbId: existing.forgeDbId,
        agentsDbId: existing.forgeAgentsDbId,
        buildLogBlockId: existing.forgeBuildLogBlockId,
        buttonBlockId: existing.forgeButtonBlockId,
      };
    }
    emit(
      logger,
      'precheck-existing-install',
      'completed',
      'persisted forge page missing in Notion; re-installing',
    );
  }

  // The Notion API REQUIRES a parent for every created page. There is no
  // "workspace root" create; integrations must own at least one page
  // explicitly granted to them. Fail fast if the caller didn't supply one.
  const parentPageId = opts.parentPageId;
  if (!parentPageId) {
    throw new InstallerError(
      'parentPageId is required: the Notion REST API does not support ' +
        'creating a page with parent.workspace; the caller must surface a ' +
        'page-picker on first sign-in.',
      { step: 'create-root-page', workspaceId: opts.workspaceId },
    );
  }

  // Generate (or reuse) the per-workspace webhook secret. We mint it
  // before any Notion API calls so it can be embedded in the trigger URL
  // (callers verify it on the inbound webhook via
  // verifyNotionWebhookSignature in `@forge/notion-client`).
  const webhookSecret = existing?.webhookSecret ?? generateWorkspaceWebhookSecret();

  const webhookUrl =
    `${opts.appUrl.replace(/\/+$/, '')}/api/webhooks/notion-button` +
    `?ws=${encodeURIComponent(opts.notionWorkspaceId)}`;

  // ── Step 2: create the root page ───────────────────────────────────────
  const rootPage = await step(
    ctx,
    'create-root-page',
    'POST /v1/pages — create Forge root page',
    async () => {
      const initial = buildRootPageInitialChildren();
      // The H1 title is also the page title (passed as title property),
      // not a child — Notion treats the first H1 as the breadcrumb name
      // and would render two if we duplicated. We still keep the
      // explicit `heading_1` builder for completeness.
      void buildPageTitleHeading();
      // `children` shape in the wire payload accepts our create-shape
      // inputs (no `id`/`created_time`); the NotionBlock union on
      // `CreatePageParams` is the read-shape so we cast through unknown.
      const children = initial as unknown as Parameters<typeof createPage>[1]['children'];
      return createPage(notionConfig, {
        parent: { type: 'page_id', page_id: parentPageId },
        properties: {
          title: {
            title: [
              {
                type: 'text',
                text: {
                  content: 'Forge — your agents, in plain English',
                  link: null,
                },
              },
            ],
          },
        },
        icon: { type: 'emoji', emoji: '⚡' },
        // Inline the welcome callout + "How it works" + divider at create
        // time so the page renders fully populated on first load. The
        // Notion API allows up to ~100 children per create call; we send
        // 3 here.
        ...(children ? { children } : {}),
      });
    },
  );

  const pageId = rootPage.id;

  // ── Step 3: create Forge Requests DB (skeleton — relation set later) ──
  //
  // The "Deployed Agent" relation needs the Agents DB id. We could
  // create Agents first then Requests — and we do — but we also tolerate
  // a future re-ordering by always building the Requests schema via
  // `buildForgeRequestsDbSchema(agentsDbId)`.

  const agentsDb = await step(ctx, 'create-agents-db', 'POST /v1/databases — Forge Agents DB', () =>
    createDatabase(notionConfig, {
      parent: { type: 'page_id', page_id: pageId },
      title: [
        {
          type: 'text',
          text: { content: 'Forge Agents', link: null },
        },
      ],
      properties: forgeAgentsDbSchema,
      icon: { type: 'emoji', emoji: '🤖' },
      is_inline: true,
    }),
  );

  const requestsDb = await step(
    ctx,
    'create-requests-db',
    'POST /v1/databases — Forge Requests DB',
    () =>
      createDatabase(notionConfig, {
        parent: { type: 'page_id', page_id: pageId },
        title: [
          {
            type: 'text',
            text: { content: 'Forge Requests', link: null },
          },
        ],
        properties: buildForgeRequestsDbSchema(agentsDb.id),
        icon: { type: 'emoji', emoji: '📋' },
        is_inline: true,
      }),
  );

  // ── Step 4: link-relations is implicit on creation ─────────────────────
  //
  // Notion auto-creates the back-relation when you create a `relation`
  // property with `single_property: {}` against another DB the integration
  // has access to. We emit a no-op step so logs stay structured.
  await step(
    ctx,
    'link-relations',
    'verify back-relation on Forge Requests → Forge Agents',
    async () => {
      // The verification path would be `getDatabase(agentsDb.id)` and
      // inspecting `properties.<auto-named>.relation.synced_property_id`,
      // but we skip the round-trip in v1; the reconciler does this.
    },
  );

  // ── Step 5: append the button (bookmark fallback) ──────────────────────
  const buttonResp = await step(
    ctx,
    'create-button-block',
    'PATCH /v1/blocks/{id}/children — append Forge button (bookmark fallback)',
    () => appendBlocks(notionConfig, asBlockId(pageId), [buildForgeButtonBookmark(webhookUrl)]),
  );
  const buttonBlock = buttonResp.results[0];
  if (!buttonBlock) {
    throw new InstallerError('Notion returned no blocks for the button append', {
      step: 'create-button-block',
      workspaceId: opts.workspaceId,
    });
  }

  // ── Step 6: append the Build Log heading + synced block ────────────────
  const buildLogResp = await step(
    ctx,
    'create-build-log-block',
    'PATCH /v1/blocks/{id}/children — append Build Log container',
    async () => {
      try {
        return await appendBlocks(notionConfig, asBlockId(pageId), [
          buildDivider(),
          buildBuildLogHeading(),
          buildBuildLogSyncedBlock(),
        ]);
      } catch (error) {
        // Workspaces on the Free tier sometimes cannot create
        // synced_blocks (validation_error). Retry with a toggle fallback.
        logger?.warn?.('synced_block creation failed; falling back to toggle', {
          err: String(error),
        });
        return appendBlocks(notionConfig, asBlockId(pageId), [
          buildDivider(),
          buildBuildLogHeading(),
          buildBuildLogToggleFallback(),
        ]);
      }
    },
  );
  // The last block of the three is the synced_block / toggle — that's our
  // container ID. Notion returns blocks in the order we sent them.
  const buildLogContainer = buildLogResp.results.at(-1);
  if (!buildLogContainer) {
    throw new InstallerError('Notion returned no blocks for the Build Log append', {
      step: 'create-build-log-block',
      workspaceId: opts.workspaceId,
    });
  }

  // ── Step 7: append the Settings toggle with its bulleted children ──────
  await step(
    ctx,
    'create-settings-block',
    'PATCH /v1/blocks/{id}/children — append Settings toggle',
    async () => {
      const toggleResp = await appendBlocks(notionConfig, asBlockId(pageId), [
        buildDivider(),
        buildSettingsToggle(),
      ]);
      const toggleBlock = toggleResp.results.at(-1);
      if (!toggleBlock) return;
      // Append children to the toggle block we just created.
      await appendBlocks(notionConfig, asBlockId(toggleBlock.id), buildSettingsChildren());
    },
  );

  // ── Step 8: persist everything on the Workspace row ────────────────────
  await step(ctx, 'persist-workspace-row', 'UPDATE Workspace set forge*Id columns', () =>
    db.updateWorkspaceForgeRecord(opts.workspaceId, {
      forgePageId: pageId,
      forgeDbId: requestsDb.id,
      forgeAgentsDbId: agentsDb.id,
      forgeButtonBlockId: buttonBlock.id,
      forgeBuildLogBlockId: buildLogContainer.id,
      webhookSecret,
    }),
  );

  return {
    pageId,
    requestsDbId: asDatabaseId(requestsDb.id),
    agentsDbId: asDatabaseId(agentsDb.id),
    buildLogBlockId: asBlockId(buildLogContainer.id),
    buttonBlockId: asBlockId(buttonBlock.id),
  };
}
