/**
 * PATCH /api/settings/default-model
 *   200 + body { ok, model } on happy path; persists via prisma + audit
 *   400 on invalid model
 *   400 on invalid JSON body
 *   401 without session
 *
 * The handler also exposes a POST alias for the legacy frontend — we
 * cover one POST case to lock that in.
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
    workspace: { update: vi.fn() },
  },
  recordAuditEvent: vi.fn(),
}));

vi.mock('@/lib/posthog', () => ({ capture: vi.fn() }));

const checkRateLimitMock = vi.fn();
vi.mock('@/lib/ratelimit', () => ({
  checkRateLimit: (...args: unknown[]) => checkRateLimitMock(...args),
  createRateLimiter: () => ({}),
}));

beforeEach(async () => {
  vi.resetAllMocks();
  vi.resetModules();
  const clerk = await import('@clerk/nextjs/server');
  vi.mocked(clerk.auth).mockResolvedValue({ userId: 'clerk_1' } as never);
  const db = await import('@forge/db');
  vi.mocked(db.prisma.user.findUnique).mockResolvedValue({
    id: 'user_1',
    clerkId: 'clerk_1',
    workspace: {
      id: 'ws_1',
      ownerUserId: 'clerk_1',
      defaultModel: 'auto',
    },
  } as never);
  vi.mocked(db.prisma.workspace.update).mockResolvedValue({} as never);
  checkRateLimitMock.mockResolvedValue({
    success: true,
    reset: 0,
    remaining: 29,
    limit: 30,
  });
});

describe('PATCH /api/settings/default-model', () => {
  it('returns 200 and persists the new model on a valid body', async () => {
    const { PATCH } = await import('@/app/api/settings/default-model/route');
    const res = await PATCH(
      makeRequest('http://localhost/api/settings/default-model', {
        method: 'PATCH',
        body: { model: 'gpt-5.5' },
      }) as never,
      makeCtx({}),
    );
    expect(res.status).toBe(200);
    const body = await readJson<{ ok: boolean; model: string }>(res);
    expect(body).toEqual({ ok: true, model: 'gpt-5.5' });

    const db = await import('@forge/db');
    expect(db.prisma.workspace.update).toHaveBeenCalledWith({
      where: { id: 'ws_1' },
      data: { defaultModel: 'gpt-5.5' },
    });
    expect(db.recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'workspace.default_model_changed',
        metadata: expect.objectContaining({
          previousModel: 'auto',
          newModel: 'gpt-5.5',
        }),
      }),
    );
  });

  it('rejects an unknown model with 400', async () => {
    const { PATCH } = await import('@/app/api/settings/default-model/route');
    const res = await PATCH(
      makeRequest('http://localhost/api/settings/default-model', {
        method: 'PATCH',
        body: { model: 'gpt-3' },
      }) as never,
      makeCtx({}),
    );
    expect(res.status).toBe(400);
  });

  it('rejects a non-JSON body with 400', async () => {
    const { PATCH } = await import('@/app/api/settings/default-model/route');
    const req = new Request('http://localhost/api/settings/default-model', {
      method: 'PATCH',
      body: 'not json',
      headers: { 'content-type': 'application/json' },
    });
    const res = await PATCH(req as never, makeCtx({}));
    expect(res.status).toBe(400);
  });

  it('returns 401 without a session', async () => {
    const clerk = await import('@clerk/nextjs/server');
    vi.mocked(clerk.auth).mockResolvedValue({ userId: null } as never);
    const { PATCH } = await import('@/app/api/settings/default-model/route');
    const res = await PATCH(
      makeRequest('http://localhost/api/settings/default-model', {
        method: 'PATCH',
        body: { model: 'auto' },
      }) as never,
      makeCtx({}),
    );
    expect(res.status).toBe(401);
  });

  it('POST alias works the same as PATCH (legacy frontend)', async () => {
    const { POST } = await import('@/app/api/settings/default-model/route');
    const res = await POST(
      makeRequest('http://localhost/api/settings/default-model', {
        method: 'POST',
        body: { model: 'gpt-5.4-mini' },
      }) as never,
      makeCtx({}),
    );
    expect(res.status).toBe(200);
  });

  it('returns 429 with Retry-After + X-RateLimit headers when rate-limited', async () => {
    checkRateLimitMock.mockResolvedValue({
      success: false,
      reset: Date.now() + 30_000,
      remaining: 0,
      limit: 30,
    });
    const { PATCH } = await import('@/app/api/settings/default-model/route');
    const res = await PATCH(
      makeRequest('http://localhost/api/settings/default-model', {
        method: 'PATCH',
        body: { model: 'auto' },
      }) as never,
      makeCtx({}),
    );
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBeTruthy();
    expect(res.headers.get('x-ratelimit-limit')).toBe('30');
    expect(res.headers.get('x-ratelimit-remaining')).toBe('0');
    const db = await import('@forge/db');
    expect(db.prisma.workspace.update).not.toHaveBeenCalled();
  });
});
