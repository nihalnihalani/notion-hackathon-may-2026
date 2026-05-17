/**
 * Upstash rate-limiter factory.
 *
 * Single source of truth for every per-user / per-workspace / per-endpoint
 * rate limit in the API surface. We keep one Redis client at module level
 * (safe — `@upstash/redis` uses HTTP REST under the hood; no socket state) and
 * spin up a fresh `Ratelimit` instance per (prefix, limit, window) tuple.
 *
 * Instances are cached so repeated `createRateLimiter('forge.trigger', …)`
 * calls return the same limiter — important because `@upstash/ratelimit`
 * batches in-memory before flushing to Redis.
 *
 * Edge-runtime safe: `@upstash/redis` uses `fetch` exclusively.
 */

import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

/**
 * Loose Duration alias — `@upstash/ratelimit`'s exported `Duration` is a
 * template literal type. We accept the same shape but keep our public surface
 * inferable so consumers don't need to import the upstream type.
 */
export type RateLimitWindow = `${number} ${
  | 'ms'
  | 's'
  | 'm'
  | 'h'
  | 'd'}`;

let redisSingleton: Redis | null = null;

/**
 * Read Upstash credentials lazily so that bundling code (Vite, Next build)
 * doesn't crash when the env vars are absent at compile time. Throws on first
 * USE if unset — the route handler then returns a 503 via the Sentry wrapper.
 */
function getRedis(): Redis {
  if (redisSingleton) return redisSingleton;
  const url = process.env['UPSTASH_REDIS_REST_URL'];
  const token = process.env['UPSTASH_REDIS_REST_TOKEN'];
  if (!url || !token) {
    throw new Error(
      'Rate limiter unavailable: UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN missing.',
    );
  }
  redisSingleton = new Redis({ url, token });
  return redisSingleton;
}

const limiterCache = new Map<string, Ratelimit>();

/**
 * Create (or reuse) a sliding-window rate limiter for the given key prefix.
 *
 * `prefix` should be the logical endpoint (`forge.trigger`, `agents.pause`).
 * The actual key sent to Redis is `forge-rl:{prefix}:{identifier}`. The
 * caller passes the identifier (userId, workspaceId, IP) to {@link limit}.
 *
 * Sliding window is preferred over fixed window: a 5/minute fixed limiter
 * permits 10 requests at the minute boundary, which defeats the purpose for a
 * generation endpoint where bursts have a real $-cost.
 */
export function createRateLimiter(
  prefix: string,
  requests: number,
  window: RateLimitWindow,
): Ratelimit {
  const cacheKey = `${prefix}|${requests}|${window}`;
  const cached = limiterCache.get(cacheKey);
  if (cached) return cached;

  const limiter = new Ratelimit({
    redis: getRedis(),
    limiter: Ratelimit.slidingWindow(requests, window),
    prefix: `forge-rl:${prefix}`,
    analytics: true,
  });
  limiterCache.set(cacheKey, limiter);
  return limiter;
}

/**
 * Pre-configured limiters used by route handlers. Centralized so the limits
 * are reviewable in one place; if you need to tune a limit, edit here, not
 * the route.
 */
export const limiters = {
  /** 5 generations per minute per user (PLAN §VI rate limit). */
  forgeTrigger: () => createRateLimiter('forge.trigger', 5, '1 m'),
  /** 60 cancellations per minute per user — generous; cancels are cheap. */
  forgeCancel: () => createRateLimiter('forge.cancel', 60, '1 m'),
  /** 120 pause/resume calls per minute per user. */
  agentMutation: () => createRateLimiter('agents.mutation', 120, '1 m'),
  /** 600 build-log appends per minute per generation. Above Notion's 3/sec. */
  forgeLog: () => createRateLimiter('forge.log', 600, '1 m'),
  /** 30 MCP `forge_agent` invocations per minute per API key. */
  mcpForgeAgent: () => createRateLimiter('mcp.forge_agent', 30, '1 m'),
  /** 600 healthz pings per minute per IP — accommodates uptime monitors. */
  healthz: () => createRateLimiter('healthz', 600, '1 m'),
} as const;

/**
 * Convenience wrapper around `limit()` that throws on configuration error
 * (missing env, network) and returns the result on success. Use this directly
 * in route handlers; on `success === false` return `apiError('rate_limited',…)`.
 */
export async function checkRateLimit(
  limiter: Ratelimit,
  identifier: string,
): Promise<{ success: boolean; reset: number; remaining: number; limit: number }> {
  const result = await limiter.limit(identifier);
  return {
    success: result.success,
    reset: result.reset,
    remaining: result.remaining,
    limit: result.limit,
  };
}
