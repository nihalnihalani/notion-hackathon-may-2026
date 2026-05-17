/**
 * Installer shim — runs `@forge/installer` to create or reconcile the Forge
 * page + Requests DB in the user's Notion workspace immediately after OAuth.
 *
 * Same dynamic-import pattern as `workflows.ts` (see comment there for the
 * "package not yet built" reasoning).
 *
 * Expected contract (PLAN §VII.Installation flow):
 *
 *   installForgePage({
 *     notionToken,
 *     workspaceId,         // our internal Workspace.id
 *     notionWorkspaceId,
 *   }) → Promise<{ forgePageId: string; forgeDbId: string; buildLogBlockId: string }>
 *
 * On failure the caller (the OAuth callback) catches and logs to Sentry but
 * does NOT fail the callback — the user can re-trigger install from
 * `/settings` later.
 */

export interface InstallForgePageInput {
  notionToken: string;
  /** Internal `Workspace.id` (cuid). */
  workspaceId: string;
  /** Notion's own workspace id from OAuth. */
  notionWorkspaceId: string;
}

export interface InstallForgePageResult {
  forgePageId: string;
  forgeDbId: string;
  /** Block id of the synced Build Log container — used by `/api/forge/log`. */
  buildLogBlockId: string;
}

interface InstallerModule {
  installForgePage: (
    i: InstallForgePageInput,
  ) => Promise<InstallForgePageResult>;
}

let cachedModule: InstallerModule | null = null;

async function getInstaller(): Promise<InstallerModule> {
  if (cachedModule) return cachedModule;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod: any = await import('@forge/installer');
  if (typeof mod.installForgePage !== 'function') {
    throw new Error(
      '@forge/installer does not export installForgePage. Update the package or this shim.',
    );
  }
  cachedModule = { installForgePage: mod.installForgePage };
  return cachedModule;
}

export async function installForgePage(
  input: InstallForgePageInput,
): Promise<InstallForgePageResult> {
  const m = await getInstaller();
  return m.installForgePage(input);
}

export function __resetForTests(): void {
  cachedModule = null;
}
