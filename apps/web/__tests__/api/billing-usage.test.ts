/**
 * POST /api/billing/usage
 *   200 on valid internal bearer + recordUsage called
 *   401 on bad bearer + no stripe signature
 *   400 on invalid internal body
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeCtx, makeRequest, stubSentryWrapper } from './_helpers';

stubSentryWrapper();

vi.mock('@forge/db', () => ({
  recordUsage: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(() => {
  vi.resetAllMocks();
  vi.resetModules();
  process.env['FORGE_INTERNAL_TOKEN'] = 'good';
  delete process.env['STRIPE_WEBHOOK_SECRET'];
});

describe('POST /api/billing/usage', () => {
  it('records usage on a valid internal call', async () => {
    const { POST } = await import('@/app/api/billing/usage/route');
    const res = await POST(
      makeRequest('http://localhost/api/billing/usage', {
        method: 'POST',
        headers: { authorization: 'Bearer good' },
        body: { workspaceId: 'ws_1', fields: { generationsCount: 2 } },
      }) as never,
      makeCtx({}),
    );
    expect(res.status).toBe(200);
    const db = await import('@forge/db');
    expect(vi.mocked(db.recordUsage)).toHaveBeenCalledWith('ws_1', {
      generationsCount: 2,
    });
  });

  it('returns 401 on bad bearer with no stripe signature', async () => {
    const { POST } = await import('@/app/api/billing/usage/route');
    const res = await POST(
      makeRequest('http://localhost/api/billing/usage', {
        method: 'POST',
        headers: { authorization: 'Bearer wrong' },
        body: { workspaceId: 'ws_1', fields: { generationsCount: 1 } },
      }) as never,
      makeCtx({}),
    );
    expect(res.status).toBe(401);
  });

  it('returns 400 on invalid internal body', async () => {
    const { POST } = await import('@/app/api/billing/usage/route');
    const res = await POST(
      makeRequest('http://localhost/api/billing/usage', {
        method: 'POST',
        headers: { authorization: 'Bearer good' },
        body: { workspaceId: 'ws_1', fields: {} },
      }) as never,
      makeCtx({}),
    );
    expect(res.status).toBe(400);
  });
});
