/**
 * Token-bucket pacer for the Notion API.
 *
 * Notion's documented sustained limit is **3 requests per second per
 * integration**; bursts above this attract 429s with `Retry-After`. The pacer
 * lets a single process self-throttle so we waste fewer round-trips on 429
 * retries (which are themselves rate-limited).
 *
 * Implementation: classic token bucket.
 *   - `allowedRequests` tokens refilled per `intervalMs` ms.
 *   - `acquire()` resolves immediately if a token is available, otherwise it
 *     waits for the next refill window.
 *
 * Edge-runtime safe: uses only `setTimeout` and `Date.now()`. Pure in-memory:
 * for distributed pacing (multi-region Vercel deployments) compose this with
 * an Upstash-Redis limiter at the API-route layer; this library does not
 * reach across processes.
 */

import type { Pacer } from './types.js';

export interface PacerOptions {
  /** Tokens per refill window. e.g. `3`. */
  allowedRequests: number;
  /** Refill window length in milliseconds. e.g. `1_000`. */
  intervalMs: number;
  /**
   * Optional clock + scheduler injection for tests. Defaults to `Date.now`
   * and `setTimeout`. When using vitest fake timers leave these unset and
   * advance the timer instead.
   */
  now?: () => number;
  setTimeout?: (cb: () => void, ms: number) => unknown;
}

/**
 * Build a pacer with the given capacity. The bucket starts full so the first
 * `allowedRequests` calls never wait.
 *
 * @example
 *   const pacer = createPacer({ allowedRequests: 3, intervalMs: 1000 });
 *   await pacer.acquire();
 *   await notionRequest(...);
 */
export function createPacer(opts: PacerOptions): Pacer {
  if (opts.allowedRequests <= 0) {
    throw new RangeError('pacer: allowedRequests must be > 0');
  }
  if (opts.intervalMs <= 0) {
    throw new RangeError('pacer: intervalMs must be > 0');
  }

  const now = opts.now ?? (() => Date.now());
  // Note: globalThis.setTimeout in Edge / browsers returns a numeric id, in
  // Node it returns a Timer. We don't need the return value here.
  const schedule = opts.setTimeout ?? ((cb: () => void, ms: number): unknown => setTimeout(cb, ms));

  const capacity = opts.allowedRequests;
  let tokens = capacity;
  let lastRefill = now();
  // FIFO queue of waiters. Ensures fairness — first to call acquire() first
  // to get a token once one is available.
  const waiters: (() => void)[] = [];

  function refill(): void {
    const t = now();
    const elapsed = t - lastRefill;
    if (elapsed <= 0) return;
    // Refill rate: capacity tokens per intervalMs.
    const refillAmount = (elapsed / opts.intervalMs) * capacity;
    if (refillAmount <= 0) return;
    // Only clamp to the burst capacity when nobody is queued — otherwise
    // pending waiters would lose out on time that elapsed while the bucket
    // was full. With waiters present, treat the bucket as a fair scheduler:
    // every elapsed ms grants its share of tokens, and we drain them in FIFO
    // order. This matches the intuition "3 req/sec sustained" even under
    // back-pressure: a long delay in scheduling shouldn't punish waiters.
    tokens = waiters.length > 0 ? tokens + refillAmount : Math.min(capacity, tokens + refillAmount);
    lastRefill = t;
  }

  function drainWaiters(): void {
    while (tokens >= 1 && waiters.length > 0) {
      tokens -= 1;
      const next = waiters.shift();
      if (next) next();
    }
  }

  function scheduleRefill(): void {
    // Wait long enough for at least one full token to accumulate.
    const tokensNeeded = 1 - tokens;
    if (tokensNeeded <= 0) {
      drainWaiters();
      return;
    }
    const msUntilToken = Math.ceil((tokensNeeded * opts.intervalMs) / capacity);
    schedule(() => {
      refill();
      drainWaiters();
      if (waiters.length > 0) scheduleRefill();
    }, msUntilToken);
  }

  return {
    acquire(): Promise<void> {
      refill();
      if (tokens >= 1 && waiters.length === 0) {
        tokens -= 1;
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        waiters.push(resolve);
        // If this is the head of the queue, kick off a refill timer.
        if (waiters.length === 1) scheduleRefill();
      });
    },
  };
}
