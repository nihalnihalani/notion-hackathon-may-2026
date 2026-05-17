/**
 * Webhook replay protection — timestamp window + Redis SETNX dedupe.
 *
 * Notion (and most webhook providers) deliver events at-least-once: a slow
 * 200 from us, a 5xx, or a transient network blip will trigger a retry with
 * the same body. Without dedupe the receiver re-processes the event, which
 * for Forge means a duplicate Generation row + duplicate AI spend.
 *
 * Strategy:
 *   1. Reject events whose `timestamp` is more than `MAX_AGE_MS` in the past
 *      (replay) or more than `MAX_FUTURE_MS` in the future (clock skew /
 *      forgery). Both are signature-bypass attempts.
 *   2. Atomically `SETNX` the event `id` to a 24h-TTL key in Upstash. If the
 *      key already exists this is a duplicate delivery — return `duplicate`
 *      and the caller MUST respond 200 so the provider stops retrying.
 *
 * Redis is fronted by a module-level singleton mirroring `lib/ratelimit.ts`.
 * Edge-runtime safe (Upstash uses fetch, no socket state).
 *
 * Keys are namespaced per webhook source so the `notion-button` and
 * `notion-page-edit` handlers can share this module without colliding.
 */

import { Redis } from '@upstash/redis';

/** Window the event timestamp must fall inside, in milliseconds. */
export const MAX_AGE_MS = 5 * 60_000; // 5 minutes past
export const MAX_FUTURE_MS = 60_000; // 1 minute future (clock skew tolerance)

/** TTL on the dedupe SETNX key. 24h covers Notion's max retry window. */
const DEDUPE_TTL_SECONDS = 24 * 60 * 60;

let redisSingleton: Redis | null = null;

function getRedis(): Redis {
  if (redisSingleton) return redisSingleton;
  const url = process.env['UPSTASH_REDIS_REST_URL'];
  const token = process.env['UPSTASH_REDIS_REST_TOKEN'];
  if (!url || !token) {
    throw new Error(
      'Webhook dedupe unavailable: UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN missing.',
    );
  }
  redisSingleton = new Redis({ url, token });
  return redisSingleton;
}

/**
 * Outcome of an envelope check. `ok` is `false` ONLY for malformed/stale
 * envelopes (caller returns 4xx). A successful dedupe with a prior hit
 * comes back as `ok: true, duplicate: true` and the caller MUST 200 it.
 */
export type WebhookDedupeResult =
  | { ok: true; duplicate: false }
  | { ok: true; duplicate: true; eventId: string }
  | {
      ok: false;
      reason: 'missing_id' | 'missing_timestamp' | 'malformed_timestamp' | 'stale' | 'future_skew';
    };

export interface WebhookEnvelope {
  id?: unknown;
  timestamp?: unknown;
}

/**
 * Validate the timestamp window on a webhook envelope. Pure — no IO.
 *
 * Exported separately so route tests can drive the failure modes without
 * touching Redis.
 */
export function validateWebhookEnvelope(
  envelope: WebhookEnvelope,
  now: number = Date.now(),
):
  | { ok: true; eventId: string; timestampMs: number }
  | {
      ok: false;
      reason: 'missing_id' | 'missing_timestamp' | 'malformed_timestamp' | 'stale' | 'future_skew';
    } {
  if (typeof envelope.id !== 'string' || envelope.id.length === 0) {
    return { ok: false, reason: 'missing_id' };
  }
  if (typeof envelope.timestamp !== 'string' || envelope.timestamp.length === 0) {
    return { ok: false, reason: 'missing_timestamp' };
  }
  const ts = Date.parse(envelope.timestamp);
  if (!Number.isFinite(ts)) {
    return { ok: false, reason: 'malformed_timestamp' };
  }
  if (now - ts > MAX_AGE_MS) {
    return { ok: false, reason: 'stale' };
  }
  if (ts - now > MAX_FUTURE_MS) {
    return { ok: false, reason: 'future_skew' };
  }
  return { ok: true, eventId: envelope.id, timestampMs: ts };
}

/**
 * Validate + dedupe a webhook envelope.
 *
 * `source` is the logical webhook name (e.g. `notion-button`) and forms the
 * Redis key namespace `forge-webhook-dedup:{source}:{event.id}`.
 *
 * On the duplicate path the caller MUST respond with 200 — a 4xx makes the
 * provider retry, which is exactly the loop we're trying to break.
 */
export async function checkWebhookReplay(
  source: string,
  envelope: WebhookEnvelope,
  now: number = Date.now(),
): Promise<WebhookDedupeResult> {
  const v = validateWebhookEnvelope(envelope, now);
  if (!v.ok) return v;

  const redis = getRedis();
  const key = `forge-webhook-dedup:${source}:${v.eventId}`;
  // `SET key value NX EX <ttl>` — atomic insert-if-absent with TTL. Returns
  // `'OK'` on insert, `null` on a pre-existing key (duplicate delivery).
  const result = await redis.set(key, '1', { nx: true, ex: DEDUPE_TTL_SECONDS });
  if (result === null) {
    return { ok: true, duplicate: true, eventId: v.eventId };
  }
  return { ok: true, duplicate: false };
}
