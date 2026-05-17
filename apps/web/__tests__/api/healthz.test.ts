/**
 * /api/healthz contract:
 *   - 200 always
 *   - body shape: { status, checks: { database, redis }, version, timestamp }
 *   - `status` flips to 'degraded' when any check fails
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeCtx, makeRequest, readJson, stubSentryWrapper } from './_helpers';

stubSentryWrapper();

vi.mock('@forge/db', () => ({
  prisma: {
    $queryRaw: vi.fn(),
  },
}));

vi.mock('@upstash/redis', () => ({
  Redis: vi.fn().mockImplementation(() => ({
    ping: vi.fn().mockResolvedValue('PONG'),
  })),
}));

describe('GET /api/healthz', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env['UPSTASH_REDIS_REST_URL'] = 'https://u';
    process.env['UPSTASH_REDIS_REST_TOKEN'] = 't';
  });

  it('returns 200 with status=ok when all checks pass', async () => {
    const db = await import('@forge/db');
    vi.mocked(db.prisma.$queryRaw).mockResolvedValueOnce(1 as never);

    const { GET } = await import('@/app/api/healthz/route');
    const res = await GET(
      makeRequest('http://localhost/api/healthz') as never,
      makeCtx({}),
    );
    expect(res.status).toBe(200);
    const body = await readJson<{ status: string; checks: Record<string, { ok: boolean }> }>(res);
    expect(body.status).toBe('ok');
    expect(body.checks.database?.ok).toBe(true);
    expect(body.checks.redis?.ok).toBe(true);
  });

  it('returns 200 with status=degraded when database fails', async () => {
    const db = await import('@forge/db');
    vi.mocked(db.prisma.$queryRaw).mockRejectedValueOnce(new Error('boom'));

    const { GET } = await import('@/app/api/healthz/route');
    const res = await GET(
      makeRequest('http://localhost/api/healthz') as never,
      makeCtx({}),
    );
    expect(res.status).toBe(200);
    const body = await readJson<{ status: string; checks: Record<string, { ok: boolean }> }>(res);
    expect(body.status).toBe('degraded');
    expect(body.checks.database?.ok).toBe(false);
  });
});
