/**
 * Workspace repository — typed query helpers for the `Workspace` model.
 *
 * Rules of the repository layer:
 *   - No raw SQL. Only Prisma client calls and `$transaction`.
 *   - Each function returns a fully typed Prisma model (or `null` for misses).
 *   - No swallowing errors. Let Prisma exceptions propagate; the API layer
 *     is responsible for translating them to HTTP responses.
 */

import { prisma } from "../client.js";
import type { Workspace } from "../types.js";

/**
 * Idempotently create-or-update a Workspace by `notionWorkspaceId`.
 *
 * Used on OAuth completion. If the Notion workspace has reinstalled (their
 * `notionWorkspaceId` survives uninstall+reinstall) we update the surface
 * fields and keep the existing primary key intact so all FKs from
 * `Generation`, `GeneratedAgent`, etc. remain valid.
 *
 * `ownerUserId` is the Clerk user id, not the FK to `User.id`.
 */
export async function upsertWorkspace(input: {
  notionWorkspaceId: string;
  name: string;
  ownerUserId: string;
  forgePageId?: string | null;
  forgeDbId?: string | null;
}): Promise<Workspace> {
  return prisma.workspace.upsert({
    where: { notionWorkspaceId: input.notionWorkspaceId },
    create: {
      notionWorkspaceId: input.notionWorkspaceId,
      name: input.name,
      ownerUserId: input.ownerUserId,
      forgePageId: input.forgePageId ?? null,
      forgeDbId: input.forgeDbId ?? null,
    },
    update: {
      name: input.name,
      ownerUserId: input.ownerUserId,
      // Only overwrite forgePageId / forgeDbId if the caller provided non-null
      // values. The installer is the only thing that should ever set these.
      ...(input.forgePageId != null && { forgePageId: input.forgePageId }),
      ...(input.forgeDbId != null && { forgeDbId: input.forgeDbId }),
    },
  });
}

/**
 * Look up a Workspace by its Notion-side id. Returns `null` if not installed.
 */
export async function findWorkspaceByNotionId(
  notionWorkspaceId: string,
): Promise<Workspace | null> {
  return prisma.workspace.findUnique({
    where: { notionWorkspaceId },
  });
}

/**
 * Return the installed Forge page + Requests DB ids for a workspace.
 *
 * Returns `null` if the workspace doesn't exist OR if the installer has not
 * yet recorded the page ids (partial install). The caller should treat both
 * as "needs (re-)install".
 */
export async function getForgePageIds(
  workspaceId: string,
): Promise<{ forgePageId: string; forgeDbId: string } | null> {
  const w = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { forgePageId: true, forgeDbId: true },
  });

  if (!w?.forgePageId || !w.forgeDbId) return null;
  return { forgePageId: w.forgePageId, forgeDbId: w.forgeDbId };
}
