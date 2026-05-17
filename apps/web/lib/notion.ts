/**
 * Per-workspace Notion client factory.
 *
 * We cache resolved Notion access tokens in Upstash with a short TTL
 * (5 min) so a hot path doesn't hit Clerk's OAuth-token endpoint on every
 * request. Module-level caching would be wrong on Vercel — each serverless
 * invocation gets a fresh module instance, defeating the cache.
 *
 * The client itself is a thin wrapper over `@forge/notion-client`'s factory.
 */

import { createPacer, type NotionClientConfig } from '@forge/notion-client';
import { clerkClient } from '@clerk/nextjs/server';
import { Redis } from '@upstash/redis';

import { prisma } from '@/lib/db';
import { unsealSecret } from '@/lib/secret-seal';

const TOKEN_TTL_SECONDS = 300; // 5 min
const TOKEN_KEY_PREFIX = 'forge:notion-token:';

let redisSingleton: Redis | null = null;

function getRedis(): Redis | null {
  if (redisSingleton) return redisSingleton;
  const url = process.env['UPSTASH_REDIS_REST_URL'];
  const token = process.env['UPSTASH_REDIS_REST_TOKEN'];
  if (!url || !token) return null;
  redisSingleton = new Redis({ url, token });
  return redisSingleton;
}

/**
 * Get a Notion OAuth access token for the given Clerk userId, caching it in
 * Upstash for `TOKEN_TTL_SECONDS`.
 *
 * Returns `null` if the user hasn't granted Notion OAuth (Clerk has no token
 * to surface). Caller should treat that as a re-install signal.
 */
export async function getNotionTokenForClerkUser(clerkUserId: string): Promise<string | null> {
  const redis = getRedis();
  const cacheKey = `${TOKEN_KEY_PREFIX}${clerkUserId}`;

  if (redis) {
    try {
      const cached = await redis.get<string>(cacheKey);
      if (cached) return cached;
    } catch {
      // Redis is a cache, not the source of truth. Continue to Clerk/DB.
    }
  }

  // Clerk's OAuth proxy stores third-party tokens against the user. The exact
  // call shape is `users.getUserOauthAccessToken(userId, provider)` in
  // @clerk/nextjs >= 7. The provider key for Notion is `oauth_notion`.
  let token: string | null = null;
  try {
    const cc = await clerkClient();
    // The Clerk SDK signature varies across major versions; cast to any here is
    // intentional and isolated. Validate at runtime.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const list = (await (cc.users as any).getUserOauthAccessToken(clerkUserId, 'oauth_notion')) as
      | { data: { token: string }[] }
      | { token: string }[];

    const arr = Array.isArray(list) ? list : list.data;
    token = arr[0]?.token ?? null;
  } catch {
    token = null;
  }

  if (!token) {
    const row = await prisma.user.findUnique({
      where: { clerkId: clerkUserId },
      select: {
        workspace: {
          select: { notionAccessTokenCiphertext: true },
        },
      },
    });
    const sealed = row?.workspace.notionAccessTokenCiphertext;
    token = sealed ? unsealSecret(sealed) : null;
  }

  if (!token) return null;

  if (redis) {
    try {
      await redis.set(cacheKey, token, { ex: TOKEN_TTL_SECONDS });
    } catch {
      // Best-effort cache write only.
    }
  }
  return token;
}

/**
 * Build a {@link NotionClientConfig} for the given workspace, with a per-
 * client pacer pre-configured to stay under Notion's 3 req/sec sustained
 * limit. The pacer is in-memory, so it only throttles within one Vercel
 * invocation — distributed pacing happens at the route layer via Upstash.
 */
export function buildNotionConfig(token: string): NotionClientConfig {
  return {
    token,
    pacer: createPacer({ allowedRequests: 3, intervalMs: 1000 }),
  };
}
