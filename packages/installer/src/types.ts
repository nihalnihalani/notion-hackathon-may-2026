/**
 * Public types for `@forge/installer`.
 *
 * These shapes are the contract between the installer and its callers
 * (Vercel Functions on the OAuth callback path, the reconciler on each
 * login, manual install scripts in `scripts/`).
 */

/**
 * The IDs the installer records after a successful install.
 *
 * Returned from {@link installForgePage} and persisted on the matching
 * `Workspace` row via `@forge/db`'s repository helpers.
 *
 * In **button-block fallback mode** (see PLAN §VII + the Notion API
 * limitations documented in `installer.ts`) `buttonBlockId` references a
 * `bookmark` block pointing at the webhook trigger URL rather than a true
 * `button` block — the Notion REST API does not support creating button
 * blocks via POST `/v1/blocks/{id}/children` as of API version
 * 2026-03-11. The caller does not need to distinguish; the orchestrator
 * resolves the user-action path off the trigger URL regardless.
 */
export interface InstallationResult {
  pageId: string;
  requestsDbId: string;
  agentsDbId: string;
  buildLogBlockId: string;
  buttonBlockId: string;
}

/**
 * Inputs to {@link installForgePage} / {@link reconcileForgePage} /
 * {@link uninstallForgePage}.
 *
 * - `workspaceId`     Forge-side PK (`Workspace.id`). Used to persist back.
 * - `notionWorkspaceId` Notion-side workspace ID from OAuth.
 * - `notionToken`     OAuth access token for the Notion workspace.
 * - `parentPageId`    Optional Notion page to install under. **Notion's
 *                     REST API requires a parent for `POST /v1/pages` — you
 *                     cannot create a page with `parent.workspace = true`
 *                     unless you authored the integration as a workspace
 *                     integration**. If omitted the installer attempts to
 *                     search for any existing top-level page the
 *                     integration can access and falls back to throwing a
 *                     typed `InstallerError(no-parent-page)`.
 * - `appUrl`          Public URL of the Forge web app, used as the base for
 *                     the webhook trigger URL embedded in the button/link.
 */
export interface InstallOptions {
  workspaceId: string;
  notionWorkspaceId: string;
  notionToken: string;
  parentPageId?: string;
  appUrl: string;
  /**
   * Advanced overrides for the underlying `@forge/notion-client` config.
   * Test code injects a `fetch` here; production code injects a `pacer`
   * (Upstash Redis) for the per-workspace rate-limit budget. Everything
   * here is optional and merged with `{ token: notionToken }`.
   */
  notion?: {
    fetch?: NotionFetch;
    baseUrl?: string;
    notionVersion?: string;
    pacer?: { acquire(): Promise<void> };
  };
}

/** Minimal fetch signature — narrower than the global so consumers don't
 *  need to import `@forge/notion-client`'s `FetchLike`. */
export type NotionFetch = (
  url: string | URL,
  init?: RequestInit,
) => Promise<Response>;

/** Optional progress event the installer emits to a logger / streamer. */
export interface InstallProgressEvent {
  step: InstallStep;
  status: 'started' | 'completed' | 'skipped';
  message: string;
}

/** Canonical step names — also used as the `step` on InstallerError. */
export type InstallStep =
  | 'precheck-existing-install'
  | 'create-root-page'
  | 'create-requests-db'
  | 'create-agents-db'
  | 'link-relations'
  | 'create-button-block'
  | 'create-build-log-block'
  | 'create-settings-block'
  | 'persist-workspace-row'
  | 'archive-root-page'
  | 'reconcile';

/**
 * Minimal slice of `@forge/db` we depend on. We define it structurally so
 * the installer can be unit-tested with a fake without pulling in the full
 * Prisma client surface, and so we never accidentally widen our coupling
 * to the rest of the DB package.
 */
export interface InstallerDbClient {
  /** Get the current persisted ids for a workspace, or null if none. */
  getWorkspaceForgeRecord(
    workspaceId: string,
  ): Promise<WorkspaceForgeRecord | null>;
  /** Persist a partial set of forge-side IDs back to the Workspace row. */
  updateWorkspaceForgeRecord(
    workspaceId: string,
    patch: Partial<WorkspaceForgeRecord>,
  ): Promise<void>;
}

/** Shape of the Workspace columns the installer cares about. */
export interface WorkspaceForgeRecord {
  forgePageId: string | null;
  forgeDbId: string | null;
  forgeAgentsDbId: string | null;
  forgeButtonBlockId: string | null;
  forgeBuildLogBlockId: string | null;
  webhookSecret: string | null;
}

/** Reconciler return — what we changed (audit-friendly). */
export interface ReconcileResult {
  changes: string[];
}
