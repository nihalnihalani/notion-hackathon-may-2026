/**
 * POST /api/agents/[id]/pause
 *   200 on happy path → status flipped to paused
 *   401 without session
 *   404 when agent missing
 *   502 when ntn pauseSync fails
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
  markAgentStatus: vi.fn(),
}));

vi.mock('@forge/ntn-wrapper', () => ({ pauseSync: vi.fn() }));

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
  checkRateLimitMock.mockResolvedValue({ success: true, reset: 0, remaining: 100, limit: 120 });
});

describe('POST /api/agents/[id]/pause', () => {
  it('returns 200 with status=paused on success', async () => {
    const db = await import('@forge/db');
    vi.mocked(db.prisma.generatedAgent.findUnique).mockResolvedValue({
      id: 'a1',
      workspaceId: 'ws_1',
      ntnWorkerName: 'forge-x-aaa',
    } as never);
    vi.mocked(db.markAgentStatus).mockResolvedValue({ id: 'a1', status: 'paused' } as never);

    const { POST } = await import('@/app/api/agents/[id]/pause/route');
    const res = await POST(
      makeRequest('http://localhost/api/agents/a1/pause', { method: 'POST' }) as never,
      makeCtx({ id: 'a1' }),
    );
    expect(res.status).toBe(200);
  });

  it('returns 401 without session', async () => {
    const clerk = await import('@clerk/nextjs/server');
    vi.mocked(clerk.auth).mockResolvedValue({ userId: null } as never);
    const { POST } = await import('@/app/api/agents/[id]/pause/route');
    const res = await POST(
      makeRequest('http://localhost/api/agents/a1/pause', { method: 'POST' }) as never,
      makeCtx({ id: 'a1' }),
    );
    expect(res.status).toBe(401);
  });

  it('returns 404 when agent missing', async () => {
    const db = await import('@forge/db');
    vi.mocked(db.prisma.generatedAgent.findUnique).mockResolvedValue(null as never);
    const { POST } = await import('@/app/api/agents/[id]/pause/route');
    const res = await POST(
      makeRequest('http://localhost/api/agents/a1/pause', { method: 'POST' }) as never,
      makeCtx({ id: 'a1' }),
    );
    expect(res.status).toBe(404);
  });

  it('returns 502 when ntn pauseSync fails', async () => {
    const db = await import('@forge/db');
    vi.mocked(db.prisma.generatedAgent.findUnique).mockResolvedValue({
      id: 'a1',
      workspaceId: 'ws_1',
      ntnWorkerName: 'forge-x-aaa',
    } as never);
    const ntn = await import('@forge/ntn-wrapper');
    vi.mocked(ntn.pauseSync).mockRejectedValue(new Error('ntn down'));

    const { POST } = await import('@/app/api/agents/[id]/pause/route');
    const res = await POST(
      makeRequest('http://localhost/api/agents/a1/pause', { method: 'POST' }) as never,
      makeCtx({ id: 'a1' }),
    );
    expect(res.status).toBe(502);
  });

  it('returns 429 when rate-limited', async () => {
    const db = await import('@forge/db');
    vi.mocked(db.prisma.generatedAgent.findUnique).mockResolvedValue({
      id: 'a1',
      workspaceId: 'ws_1',
      ntnWorkerName: 'forge-x-aaa',
    } as never);
    checkRateLimitMock.mockResolvedValue({
      success: false,
      reset: Date.now() + 5_000,
      remaining: 0,
      limit: 120,
    });
    const { POST } = await import('@/app/api/agents/[id]/pause/route');
    const res = await POST(
      makeRequest('http://localhost/api/agents/a1/pause', { method: 'POST' }) as never,
      makeCtx({ id: 'a1' }),
    );
    expect(res.status).toBe(429);
  });
});
