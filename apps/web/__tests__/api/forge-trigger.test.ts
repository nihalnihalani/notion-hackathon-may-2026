/**
 * /api/forge/trigger
 *   happy path        → 202 { generationId, status: 'queued' }
 *   cached hit        → 200 { generationId, status: 'cached', agentId }
 *   unauthenticated   → 401
 *   validation fail   → 400 with issues
 *   rate limited      → 429
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  descriptionHash: vi.fn().mockResolvedValue('hash-abc'),
  findRecentByHash: vi.fn(),
  createGeneration: vi.fn(),
}));

vi.mock('@/lib/workflows', () => ({
  publishGenerationRequested: vi.fn().mockResolvedValue({ workflowRunId: 'r1' }),
}));

vi.mock('@/lib/posthog', () => ({ capture: vi.fn() }));

const checkRateLimitMock = vi.fn();
vi.mock('@/lib/ratelimit', () => ({
  checkRateLimit: (...args: unknown[]) => checkRateLimitMock(...args),
  limiters: {
    forgeTrigger: () => ({}),
  },
}));

const fakeUser = { id: 'user_1', workspace: { id: 'ws_1' } };

beforeEach(async () => {
  vi.resetAllMocks();
  const clerk = await import('@clerk/nextjs/server');
  vi.mocked(clerk.auth).mockResolvedValue({ userId: 'clerk_1' } as never);

  const db = await import('@forge/db');
  vi.mocked(db.prisma.user.findUnique).mockResolvedValue(fakeUser as never);
  vi.mocked(db.descriptionHash).mockResolvedValue('hash-abc');
  vi.mocked(db.findRecentByHash).mockResolvedValue(null);
  vi.mocked(db.createGeneration).mockResolvedValue({ id: 'gen_1' } as never);
  checkRateLimitMock.mockResolvedValue({ success: true, reset: 0, remaining: 4, limit: 5 });
});

afterEach(() => {
  vi.resetModules();
});

describe('POST /api/forge/trigger', () => {
  it('queues a new generation on the happy path', async () => {
    const { POST } = await import('@/app/api/forge/trigger/route');
    const res = await POST(
      makeRequest('http://localhost/api/forge/trigger', {
        method: 'POST',
        body: { description: 'Triage Linear bugs' },
      }) as never,
      makeCtx({}),
    );
    expect(res.status).toBe(202);
    const body = await readJson<{ generationId: string; status: string }>(res);
    expect(body).toEqual({ generationId: 'gen_1', status: 'queued' });
  });

  it('returns cached hit when an existing generation matches', async () => {
    const db = await import('@forge/db');
    vi.mocked(db.findRecentByHash).mockResolvedValue({
      id: 'gen_old',
      agentId: 'agent_old',
    } as never);

    const { POST } = await import('@/app/api/forge/trigger/route');
    const res = await POST(
      makeRequest('http://localhost/api/forge/trigger', {
        method: 'POST',
        body: { description: 'Triage Linear bugs' },
      }) as never,
      makeCtx({}),
    );
    expect(res.status).toBe(200);
    const body = await readJson<{ status: string; agentId: string }>(res);
    expect(body.status).toBe('cached');
    expect(body.agentId).toBe('agent_old');
  });

  it('returns 401 when there is no Clerk session', async () => {
    const clerk = await import('@clerk/nextjs/server');
    vi.mocked(clerk.auth).mockResolvedValue({ userId: null } as never);

    const { POST } = await import('@/app/api/forge/trigger/route');
    const res = await POST(
      makeRequest('http://localhost/api/forge/trigger', {
        method: 'POST',
        body: { description: 'x' },
      }) as never,
      makeCtx({}),
    );
    expect(res.status).toBe(401);
  });

  it('returns 400 on missing description', async () => {
    const { POST } = await import('@/app/api/forge/trigger/route');
    const res = await POST(
      makeRequest('http://localhost/api/forge/trigger', {
        method: 'POST',
        body: {},
      }) as never,
      makeCtx({}),
    );
    expect(res.status).toBe(400);
    const body = await readJson<{ error: string }>(res);
    expect(body.error).toBe('validation');
  });

  it('returns 429 when rate-limited', async () => {
    checkRateLimitMock.mockResolvedValue({
      success: false,
      reset: Date.now() + 60_000,
      remaining: 0,
      limit: 5,
    });
    const { POST } = await import('@/app/api/forge/trigger/route');
    const res = await POST(
      makeRequest('http://localhost/api/forge/trigger', {
        method: 'POST',
        body: { description: 'hello' },
      }) as never,
      makeCtx({}),
    );
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBeTruthy();
  });
});
