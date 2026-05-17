/**
 * POST /api/forge/log
 *   204 on successful internal call
 *   401 on bad bearer
 *   400 on invalid body
 *   404 on unknown generation id
 *   429 when rate-limited
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeCtx, makeRequest, stubSentryWrapper } from './_helpers';

stubSentryWrapper();

vi.mock('@forge/db', () => ({
  prisma: { generation: { findUnique: vi.fn() } },
}));

vi.mock('@forge/notion-client', () => ({
  appendBuildLogEntry: vi.fn().mockResolvedValue(undefined),
  asBlockId: (s: string) => s,
}));

vi.mock('@/lib/notion', () => ({
  getNotionTokenForClerkUser: vi.fn().mockResolvedValue('ntoken'),
  buildNotionConfig: () => ({ token: 'ntoken' }),
}));

const checkRateLimitMock = vi.fn();
vi.mock('@/lib/ratelimit', () => ({
  checkRateLimit: (...args: unknown[]) => checkRateLimitMock(...args),
  limiters: { forgeLog: () => ({}) },
}));

beforeEach(async () => {
  vi.resetAllMocks();
  vi.resetModules();
  process.env['FORGE_INTERNAL_TOKEN'] = 'goodtoken';
  checkRateLimitMock.mockResolvedValue({ success: true, reset: 0, remaining: 100, limit: 600 });
});

describe('POST /api/forge/log', () => {
  it('returns 204 on success', async () => {
    const db = await import('@forge/db');
    vi.mocked(db.prisma.generation.findUnique).mockResolvedValue({
      id: 'gen_1',
      workspace: {
        id: 'ws_1',
        ownerUserId: 'clerk_owner',
        forgePageId: 'page_1',
        forgeDbId: 'db_1',
      },
    } as never);

    const { POST } = await import('@/app/api/forge/log/route');
    const res = await POST(
      makeRequest('http://localhost/api/forge/log', {
        method: 'POST',
        headers: { authorization: 'Bearer goodtoken' },
        body: {
          generationId: 'gen_1',
          step: 'schema-smith',
          status: 'succeeded',
          message: 'pattern = database_query',
        },
      }) as never,
      makeCtx({}),
    );
    expect(res.status).toBe(204);
  });

  it('returns 401 on bad bearer', async () => {
    const { POST } = await import('@/app/api/forge/log/route');
    const res = await POST(
      makeRequest('http://localhost/api/forge/log', {
        method: 'POST',
        headers: { authorization: 'Bearer wrong' },
        body: { generationId: 'g', step: 's', status: 'info', message: 'm' },
      }) as never,
      makeCtx({}),
    );
    expect(res.status).toBe(401);
  });

  it('returns 400 on invalid body', async () => {
    const { POST } = await import('@/app/api/forge/log/route');
    const res = await POST(
      makeRequest('http://localhost/api/forge/log', {
        method: 'POST',
        headers: { authorization: 'Bearer goodtoken' },
        body: { foo: 'bar' },
      }) as never,
      makeCtx({}),
    );
    expect(res.status).toBe(400);
  });

  it('returns 429 when rate-limited', async () => {
    checkRateLimitMock.mockResolvedValue({
      success: false,
      reset: Date.now() + 5_000,
      remaining: 0,
      limit: 600,
    });
    const { POST } = await import('@/app/api/forge/log/route');
    const res = await POST(
      makeRequest('http://localhost/api/forge/log', {
        method: 'POST',
        headers: { authorization: 'Bearer goodtoken' },
        body: {
          generationId: 'gen_1',
          step: 's',
          status: 'info',
          message: 'm',
        },
      }) as never,
      makeCtx({}),
    );
    expect(res.status).toBe(429);
  });
});
