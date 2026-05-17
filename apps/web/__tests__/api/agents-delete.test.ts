/**
 * DELETE /api/agents/[id]
 *   204 on success
 *   204 when ntn says "not found" (treated as success)
 *   502 on other ntn errors
 *   401 without session
 *   429 when rate-limited
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeCtx, makeRequest, stubSentryWrapper } from './_helpers';

stubSentryWrapper();

vi.mock('@clerk/nextjs/server', () => ({
  auth: vi.fn(),
  currentUser: vi.fn(),
  clerkClient: vi.fn(),
}));

vi.mock('@forge/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    generatedAgent: { findUnique: vi.fn() },
  },
  softDeleteAgent: vi.fn(),
  recordAuditEvent: vi.fn(),
}));

class NtnNotInstalledError extends Error {}
vi.mock('@forge/ntn-wrapper', () => ({
  deleteWorker: vi.fn(),
  NtnNotInstalledError,
}));

vi.mock('@/lib/posthog', () => ({ capture: vi.fn() }));

const checkRateLimitMock = vi.fn();
vi.mock('@/lib/ratelimit', () => ({
  checkRateLimit: (...args: unknown[]) => checkRateLimitMock(...args),
  limiters: { agentMutation: () => ({}) },
}));

beforeEach(async () => {
  vi.resetAllMocks();
  vi.resetModules();
  const clerk = await import('@clerk/nextjs/server');
  vi.mocked(clerk.auth).mockResolvedValue({ userId: 'clerk_1' } as never);
  const db = await import('@forge/db');
  vi.mocked(db.prisma.user.findUnique).mockResolvedValue({
    id: 'user_1',
    workspace: { id: 'ws_1' },
  } as never);
  vi.mocked(db.prisma.generatedAgent.findUnique).mockResolvedValue({
    id: 'a1',
    workspaceId: 'ws_1',
    ntnWorkerName: 'forge-x-aaa',
  } as never);
  checkRateLimitMock.mockResolvedValue({ success: true, reset: 0, remaining: 100, limit: 120 });
});

describe('DELETE /api/agents/[id]', () => {
  it('returns 204 on success', async () => {
    const { DELETE } = await import('@/app/api/agents/[id]/route');
    const res = await DELETE(
      makeRequest('http://localhost/api/agents/a1', { method: 'DELETE' }) as never,
      makeCtx({ id: 'a1' }),
    );
    expect(res.status).toBe(204);
  });

  it('returns 204 when ntn says the worker is already gone', async () => {
    const ntn = await import('@forge/ntn-wrapper');
    vi.mocked(ntn.deleteWorker).mockRejectedValue(new Error('not found'));
    const { DELETE } = await import('@/app/api/agents/[id]/route');
    const res = await DELETE(
      makeRequest('http://localhost/api/agents/a1', { method: 'DELETE' }) as never,
      makeCtx({ id: 'a1' }),
    );
    expect(res.status).toBe(204);
  });

  it('returns 502 on other ntn errors', async () => {
    const ntn = await import('@forge/ntn-wrapper');
    vi.mocked(ntn.deleteWorker).mockRejectedValue(new Error('connection refused'));
    const { DELETE } = await import('@/app/api/agents/[id]/route');
    const res = await DELETE(
      makeRequest('http://localhost/api/agents/a1', { method: 'DELETE' }) as never,
      makeCtx({ id: 'a1' }),
    );
    expect(res.status).toBe(502);
  });

  it('returns 401 without session', async () => {
    const clerk = await import('@clerk/nextjs/server');
    vi.mocked(clerk.auth).mockResolvedValue({ userId: null } as never);
    const { DELETE } = await import('@/app/api/agents/[id]/route');
    const res = await DELETE(
      makeRequest('http://localhost/api/agents/a1', { method: 'DELETE' }) as never,
      makeCtx({ id: 'a1' }),
    );
    expect(res.status).toBe(401);
  });

  it('returns 429 when rate-limited', async () => {
    checkRateLimitMock.mockResolvedValue({
      success: false,
      reset: Date.now() + 5_000,
      remaining: 0,
      limit: 120,
    });
    const { DELETE } = await import('@/app/api/agents/[id]/route');
    const res = await DELETE(
      makeRequest('http://localhost/api/agents/a1', { method: 'DELETE' }) as never,
      makeCtx({ id: 'a1' }),
    );
    expect(res.status).toBe(429);
  });
});
