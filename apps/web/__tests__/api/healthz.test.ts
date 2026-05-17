/**
 * /api/healthz contract:
 *   - 200 always
 *   - body shape: { status, checks: { database, redis, notion }, version, timestamp }
 *   - `status` flips to 'degraded' when any check fails
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

interface HealthCheck {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

describe('GET /api/healthz', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.resetModules();
    process.env['UPSTASH_REDIS_REST_URL'] = 'https://u';
    process.env['UPSTASH_REDIS_REST_TOKEN'] = 't';
    process.env['NOTION_OAUTH_CLIENT_ID'] = 'cid';
    process.env['NOTION_OAUTH_CLIENT_SECRET'] = 'csec';
    // Default fetch stub — Notion answers with a 401 (unauthenticated GET),
    // which is the "Notion is up" signal we want.
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('{}', { status: 401 }),
    ) as never;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
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
    const body = await readJson<{ status: string; checks: Record<string, HealthCheck> }>(res);
    expect(body.status).toBe('ok');
    expect(body.checks.database?.ok).toBe(true);
    expect(body.checks.redis?.ok).toBe(true);
    expect(body.checks.notion?.ok).toBe(true);
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
    const body = await readJson<{ status: string; checks: Record<string, HealthCheck> }>(res);
    expect(body.status).toBe('degraded');
    expect(body.checks.database?.ok).toBe(false);
    // The Notion check is still present in the response.
    expect(body.checks.notion).toBeDefined();
  });

  it('treats a Notion 4xx response as `ok: true` (API reachable)', async () => {
    const db = await import('@forge/db');
    vi.mocked(db.prisma.$queryRaw).mockResolvedValueOnce(1 as never);
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('{}', { status: 405 }),
    ) as never;

    const { GET } = await import('@/app/api/healthz/route');
    const res = await GET(
      makeRequest('http://localhost/api/healthz') as never,
      makeCtx({}),
    );
    const body = await readJson<{ checks: Record<string, HealthCheck> }>(res);
    expect(body.checks.notion?.ok).toBe(true);
  });

  it('treats a Notion network failure as `ok: false`', async () => {
    const db = await import('@forge/db');
    vi.mocked(db.prisma.$queryRaw).mockResolvedValueOnce(1 as never);
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ENOTFOUND')) as never;

    const { GET } = await import('@/app/api/healthz/route');
    const res = await GET(
      makeRequest('http://localhost/api/healthz') as never,
      makeCtx({}),
    );
    const body = await readJson<{ status: string; checks: Record<string, HealthCheck> }>(res);
    expect(body.status).toBe('degraded');
    expect(body.checks.notion?.ok).toBe(false);
  });
});
