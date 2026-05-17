/**
 * API-key validation for the MCP endpoint.
 *
 * Storage model (v1):
 *   - Keys are minted on the dashboard's `/settings` page (not in this file).
 *   - The plaintext key is shown ONCE; what we persist is
 *     `sha256(key)` mapped to `{ userId, workspaceId }` in Upstash Redis
 *     under the namespace `forge:apikey:<hash>`.
 *   - Validation is a single `GET` against Redis — sub-millisecond on the
 *     same region.
 *
 * Why Upstash and not PlanetScale: the auth check sits on the hottest path
 * (every MCP tool call) and we want a 1-RTT lookup on Edge runtime. The DB
 * schema doesn't carry an `apiKeyHash` field today; adding one is the right
 * long-term move (so revocation survives a Redis flush) but is out of scope
 * for this PR.
 *
 * Hash uses SHA-256 via Web Crypto so this module runs on Edge.
 */

import { Redis } from '@upstash/redis';

const KEY_PREFIX = 'forge:apikey:';

let redisSingleton: Redis | null = null;

function getRedis(): Redis | null {
  if (redisSingleton) return redisSingleton;
  const url = process.env['UPSTASH_REDIS_REST_URL'];
  const token = process.env['UPSTASH_REDIS_REST_TOKEN'];
  if (!url || !token) return null;
  redisSingleton = new Redis({ url, token });
  return redisSingleton;
}

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
export async function validateApiKey(
  plaintextKey: string,
): Promise<ApiKeyClaims | null> {
  if (!plaintextKey || plaintextKey.length < 16) return null;
  const redis = getRedis();
  if (!redis) return null;
  const hash = await sha256Hex(plaintextKey);
  const claims = await redis.get<ApiKeyClaims>(`${KEY_PREFIX}${hash}`);
  if (!claims) return null;
  if (typeof claims.userId !== 'string' || typeof claims.workspaceId !== 'string') {
    return null;
  }
  return claims;
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
