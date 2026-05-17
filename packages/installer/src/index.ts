/**
 * @forge/installer — bootstraps + reconciles the Forge surface (page,
 * Requests DB, Agents DB, button, Build Log) inside a user's Notion
 * workspace.
 *
 * Public surface — by-name re-exports so additions/removals show up in
 * diffs and downstream packages can rely on a stable, intentional API.
 *
 * Quickstart (from `apps/web/app/api/auth/notion/callback/route.ts`):
 *
 *   import { installForgePage, reconcileForgePage } from '@forge/installer';
 *
 *   const result = await installForgePage(
 *     {
 *       workspaceId,
 *       notionWorkspaceId,
 *       notionToken,
 *       parentPageId: pickedParent,
 *       appUrl: env.NEXT_PUBLIC_APP_URL,
 *     },
 *     forgeInstallerDbAdapter(prisma),
 *     logger,
 *   );
 */

// ── Main entry points ────────────────────────────────────────────────────────
export { installForgePage } from './installer.js';
export { reconcileForgePage } from './reconciler.js';
export { uninstallForgePage } from './uninstaller.js';

// ── Errors ───────────────────────────────────────────────────────────────────
export { InstallerError } from './errors.js';

// ── Types ────────────────────────────────────────────────────────────────────
export type {
  InstallOptions,
  InstallProgressEvent,
  InstallStep,
  InstallationResult,
  InstallerDbClient,
  NotionFetch,
  ReconcileResult,
  WorkspaceForgeRecord,
} from './types.js';

// ── Pure helpers (exposed for the reconciler and for tests) ──────────────────
export {
  buildBuildLogHeading,
  buildBuildLogSyncedBlock,
  buildBuildLogToggleFallback,
  buildDivider,
  buildForgeButtonBookmark,
  buildForgeButtonNative,
  buildHowItWorksChildren,
  buildHowItWorksToggle,
  buildIntroCallout,
  buildPageTitleHeading,
  buildRootPageInitialChildren,
  buildSettingsChildren,
  buildSettingsToggle,
} from './block-builders.js';

export {
  AGENT_STATUS_OPTIONS,
  FORGE_AGENTS_REQUIRED_PROPERTIES,
  FORGE_REQUESTS_REQUIRED_PROPERTIES,
  PATTERN_OPTIONS,
  REQUEST_STATUS_OPTIONS,
  buildForgeRequestsDbSchema,
  forgeAgentsDbSchema,
} from './db-schemas.js';
export type { ForgePattern } from './db-schemas.js';

export { generateWorkspaceWebhookSecret } from './webhook-secret.js';
