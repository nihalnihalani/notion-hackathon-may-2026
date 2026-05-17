/**
 * Token-bucket pacer tests.
 *
 * We use a virtual clock (the injection points on PacerOptions) rather than
 * vitest's fake timers so we can step time deterministically without
 * coordinating timer ticks with promise microtasks.
 */

import { describe, expect, it } from 'vitest';
import { createPacer } from '../src/pacer.js';

function virtualClock() {
  let nowMs = 0;
  const scheduled: Array<{ at: number; cb: () => void }> = [];
  return {
    now: () => nowMs,
    setTimeout: (cb: () => void, ms: number): unknown => {
      scheduled.push({ at: nowMs + ms, cb });
      return scheduled.length;
    },
    /** Advance virtual time, firing any due callbacks IN ORDER. */
    async advance(ms: number): Promise<void> {
      nowMs += ms;
      // Run any callbacks due at or before current time, in order of due time.
      while (true) {
        scheduled.sort((a, b) => a.at - b.at);
        const head = scheduled[0];
        if (!head || head.at > nowMs) break;
        scheduled.shift();
        head.cb();
        // Yield to the microtask queue so awaited acquires can resolve.
        await Promise.resolve();
        await Promise.resolve();
      }
    },
  };
}

describe('createPacer', () => {
  it('allows up to `allowedRequests` immediate acquires', async () => {
    const clock = virtualClock();
    const pacer = createPacer({
      allowedRequests: 3,
      intervalMs: 1000,
      now: clock.now,
      setTimeout: clock.setTimeout,
    });
    let resolved = 0;
    await pacer.acquire().then(() => resolved++);
    await pacer.acquire().then(() => resolved++);
    await pacer.acquire().then(() => resolved++);
    expect(resolved).toBe(3);
  });

  it('queues the 4th acquire until a token refills', async () => {
    const clock = virtualClock();
    const pacer = createPacer({
      allowedRequests: 3,
      intervalMs: 900, // 3 tokens / 900ms → ~300ms per token
      now: clock.now,
      setTimeout: clock.setTimeout,
    });
    await pacer.acquire();
    await pacer.acquire();
    await pacer.acquire();
    let fourthDone = false;
    const fourth = pacer.acquire().then(() => {
      fourthDone = true;
    });
    expect(fourthDone).toBe(false);

    // Not enough time for a full token to accumulate.
    await clock.advance(100);
    expect(fourthDone).toBe(false);

    // Now we should have enough time for one token.
    await clock.advance(250);
    await fourth;
    expect(fourthDone).toBe(true);
  });

  it('serves queued waiters in FIFO order', async () => {
    const clock = virtualClock();
    const pacer = createPacer({
      allowedRequests: 1,
      intervalMs: 100,
      now: clock.now,
      setTimeout: clock.setTimeout,
    });
    await pacer.acquire(); // consumes the only initial token
    const order: number[] = [];
    const a = pacer.acquire().then(() => order.push(1));
    const b = pacer.acquire().then(() => order.push(2));
    const c = pacer.acquire().then(() => order.push(3));

    // Step the clock forward enough for three tokens (3 × 100ms).
    await clock.advance(400);
    await Promise.all([a, b, c]);
    expect(order).toEqual([1, 2, 3]);
  });

  it('rejects nonsensical config', () => {
    expect(() => createPacer({ allowedRequests: 0, intervalMs: 1000 })).toThrow(
      /allowedRequests/,
    );
    expect(() => createPacer({ allowedRequests: 3, intervalMs: 0 })).toThrow(
      /intervalMs/,
    );
  });
});
