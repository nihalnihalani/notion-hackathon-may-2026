/**
 * API-key validation for the MCP endpoint.
 *
 * Storage model (v1):
 *   - Keys are minted on the dashboard's `/settings` page (not in this file).
 *   - The plaintext key is shown ONCE; what we persist is
 *     `sha256(key)` in PlanetScale on `UserApiKey.hashedKey`.
 *   - Validation reads the same DB row the settings route creates, so key
 *     minting, revocation, and MCP auth use one source of truth.
 *
 * Hash uses SHA-256 via Web Crypto. The MCP route runs on the Node runtime
 * because it also needs Prisma and workflow dispatch.
 */

import { prisma } from '@forge/db';

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const view = new Uint8Array(digest);
  let out = '';
  for (const b of view) out += b.toString(16).padStart(2, '0');
  return out;
}

export interface ApiKeyClaims {
  userId: string; // internal User.id
  workspaceId: string;
}

/**
 * Validate the plaintext API key. Returns the bound claims, or `null` on miss
 * (wrong key, revoked key, or Redis unavailable — caller cannot distinguish,
 * which is the desired side-channel hygiene).
 */
export async function validateApiKey(plaintextKey: string): Promise<ApiKeyClaims | null> {
  if (!plaintextKey || plaintextKey.length < 16) return null;
  const hashedKey = await sha256Hex(plaintextKey);
  let row: { id: string; userId: string; user: { workspaceId: string } | null } | null;
  try {
    row = await prisma.userApiKey.findFirst({
      where: { hashedKey, revokedAt: null },
      select: {
        id: true,
        userId: true,
        user: { select: { workspaceId: true } },
      },
    });
  } catch {
    return null;
  }
  if (!row?.user) {
    return null;
  }
  void prisma.userApiKey
    .update({ where: { id: row.id }, data: { lastUsedAt: new Date() } })
    .catch(() => {
      // last-used telemetry must not reject a valid MCP call
    });
  return { userId: row.userId, workspaceId: row.user.workspaceId };
}

/**
 * Extract a Bearer token from the `Authorization` header. Returns `null` if
 * the header is absent or malformed. Used by /api/mcp.
 */
export function extractBearer(req: Request): string | null {
  const h = req.headers.get('authorization');
  if (!h) return null;
  if (!h.toLowerCase().startsWith('bearer ')) return null;
  const tok = h.slice('bearer '.length).trim();
  return tok || null;
}
