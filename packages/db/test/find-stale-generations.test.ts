/**
 * Behavioral test for `findStaleGenerations`.
 *
 * Pins the date filter (cutoff = now - staleSinceMs) and the status set
 * ({queued, running}) to the wire-level shape we pass to Prisma. We mock the
 * prisma singleton via vitest's module mock so we don't need a live DB.
 *
 * Why this matters: the stale-generation reaper cron
 * (`/api/cron/cleanup-generations`) trusts this function to scope to only
 * non-terminal rows past the deadline. A widened filter would silently mark
 * succeeded/cancelled runs as failed.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const findManyMock = vi.fn();

vi.mock('../src/client.js', () => ({
  prisma: {
    generation: { findMany: findManyMock },
  },
}));

beforeEach(() => {
  findManyMock.mockReset();
  findManyMock.mockResolvedValue([]);
});

describe('findStaleGenerations', () => {
  it('filters by status ∈ {queued, running} AND startedAt < (now - staleSinceMs)', async () => {
    const { findStaleGenerations } = await import('../src/repositories/generations.js');

    const now = 1_700_000_000_000;
    const staleSinceMs = 30 * 60 * 1000;
    await findStaleGenerations(staleSinceMs, now);

    expect(findManyMock).toHaveBeenCalledOnce();
    const args = findManyMock.mock.calls[0]?.[0] as {
      where: {
        status: { in: string[] };
        startedAt: { lt: Date };
      };
      orderBy: { startedAt: 'asc' | 'desc' };
    };
    expect(args.where.status).toEqual({ in: ['queued', 'running'] });
    expect(args.where.startedAt.lt).toBeInstanceOf(Date);
    expect(args.where.startedAt.lt.getTime()).toBe(now - staleSinceMs);
    // Oldest first: pairs with the cron's per-row reaping loop so the
    // longest-stuck row is fixed first.
    expect(args.orderBy.startedAt).toBe('asc');
  });

  it('defaults `now` to Date.now() when not supplied', async () => {
    const { findStaleGenerations } = await import('../src/repositories/generations.js');

    const before = Date.now();
    await findStaleGenerations(1000);
    const after = Date.now();

    const args = findManyMock.mock.calls[0]?.[0] as {
      where: { startedAt: { lt: Date } };
    };
    const cutoffMs = args.where.startedAt.lt.getTime();
    expect(cutoffMs).toBeGreaterThanOrEqual(before - 1000);
    expect(cutoffMs).toBeLessThanOrEqual(after - 1000);
  });

  it('returns the rows Prisma returns (pass-through, no in-JS filtering)', async () => {
    const fakeRows = [
      { id: 'gen_1', status: 'running' },
      { id: 'gen_2', status: 'queued' },
    ];
    findManyMock.mockResolvedValueOnce(fakeRows);

    const { findStaleGenerations } = await import('../src/repositories/generations.js');

    const rows = await findStaleGenerations(60_000);
    expect(rows).toBe(fakeRows);
  });
});
