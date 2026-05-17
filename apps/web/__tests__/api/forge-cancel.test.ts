/**
 * POST /api/forge/cancel/[id]
 *   200 { ok: true } on happy path
 *   401 / 403 / 404 on auth misses
 *   429 when rate-limited
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeCtx, makeRequest, readJson, stubSentryWrapper } from './_helpers';

stubSentryWrapper();

vi.mock('@clerk/nextjs/server', () => ({
  auth: vi.fn(),
  currentUser: vi.fn(),
  clerkClient: vi.fn(),
}));

vi.mock('@forge/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    generation: { findUnique: vi.fn() },
  },
  updateGenerationStatus: vi.fn(),
}));

vi.mock('@/lib/workflows', () => ({
  cancelInflight: vi.fn().mockResolvedValue({ cancelled: true }),
}));

vi.mock('@/lib/posthog', () => ({ capture: vi.fn() }));

const checkRateLimitMock = vi.fn();
vi.mock('@/lib/ratelimit', () => ({
  checkRateLimit: (...args: unknown[]) => checkRateLimitMock(...args),
  limiters: { forgeCancel: () => ({}) },
}));

const fakeUser = { id: 'user_1', workspace: { id: 'ws_1' } };

beforeEach(async () => {
  vi.resetAllMocks();
  vi.resetModules();
  const clerk = await import('@clerk/nextjs/server');
  vi.mocked(clerk.auth).mockResolvedValue({ userId: 'clerk_1' } as never);
  const db = await import('@forge/db');
  vi.mocked(db.prisma.user.findUnique).mockResolvedValue(fakeUser as never);
  checkRateLimitMock.mockResolvedValue({ success: true, reset: 0, remaining: 60, limit: 60 });
});

describe('POST /api/forge/cancel/[id]', () => {
  it('returns ok on happy path', async () => {
    const db = await import('@forge/db');
    vi.mocked(db.prisma.generation.findUnique)
      // requireGenerationOwnership lookup
      .mockResolvedValueOnce({ id: 'g1', workspaceId: 'ws_1' } as never)
      // status read inside handler
      .mockResolvedValueOnce({ status: 'running' } as never);

    const { POST } = await import('@/app/api/forge/cancel/[id]/route');
    const res = await POST(
      makeRequest('http://localhost/api/forge/cancel/g1', { method: 'POST' }) as never,
      makeCtx({ id: 'g1' }),
    );
    expect(res.status).toBe(200);
    expect(await readJson<{ ok: boolean }>(res)).toEqual({ ok: true });
    expect(vi.mocked(db.updateGenerationStatus)).toHaveBeenCalled();
  });

  it('returns 401 without session', async () => {
    const clerk = await import('@clerk/nextjs/server');
    vi.mocked(clerk.auth).mockResolvedValue({ userId: null } as never);
    const { POST } = await import('@/app/api/forge/cancel/[id]/route');
    const res = await POST(
      makeRequest('http://localhost/api/forge/cancel/g1', { method: 'POST' }) as never,
      makeCtx({ id: 'g1' }),
    );
    expect(res.status).toBe(401);
  });

  it('returns 429 when rate-limited', async () => {
    const db = await import('@forge/db');
    vi.mocked(db.prisma.generation.findUnique).mockResolvedValueOnce({
      id: 'g1',
      workspaceId: 'ws_1',
    } as never);
    checkRateLimitMock.mockResolvedValue({
      success: false,
      reset: Date.now() + 5_000,
      remaining: 0,
      limit: 60,
    });
    const { POST } = await import('@/app/api/forge/cancel/[id]/route');
    const res = await POST(
      makeRequest('http://localhost/api/forge/cancel/g1', { method: 'POST' }) as never,
      makeCtx({ id: 'g1' }),
    );
    expect(res.status).toBe(429);
  });
});
