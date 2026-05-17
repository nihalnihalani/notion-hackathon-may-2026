/**
 * POST /api/webhooks/notion-page-edit
 *   200 + debouncedSeconds on happy path
 *   401 on signature mismatch
 *   400 on missing body fields
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeCtx, makeRequest, readJson, stubSentryWrapper } from './_helpers';

stubSentryWrapper();

vi.mock('@forge/db', () => ({
  findWorkspaceByNotionId: vi.fn(),
  recordAuditEvent: vi.fn(),
  prisma: {
    workspace: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'ws_1',
        webhookSecret: 's3cr3t',
      }),
    },
  },
}));

vi.mock('@forge/notion-client', () => ({
  verifyNotionWebhookSignature: vi.fn(),
}));

const redisSetMock = vi.fn().mockResolvedValue('OK');
vi.mock('@upstash/redis', () => ({
  Redis: vi.fn().mockImplementation(() => ({ set: redisSetMock })),
}));

beforeEach(async () => {
  vi.resetAllMocks();
  vi.resetModules();
  process.env['NOTION_WEBHOOK_SECRET'] = 's3cr3t';
  process.env['UPSTASH_REDIS_REST_URL'] = 'https://u';
  process.env['UPSTASH_REDIS_REST_TOKEN'] = 't';

  const nc = await import('@forge/notion-client');
  vi.mocked(nc.verifyNotionWebhookSignature).mockResolvedValue({ valid: true });
  const db = await import('@forge/db');
  vi.mocked(db.findWorkspaceByNotionId).mockResolvedValue({
    id: 'ws_1',
    ownerUserId: 'clerk_owner',
  } as never);
});

describe('POST /api/webhooks/notion-page-edit', () => {
  it('records the latest edit in Upstash and returns 200', async () => {
    const { POST } = await import('@/app/api/webhooks/notion-page-edit/route');
    const res = await POST(
      makeRequest('http://localhost/api/webhooks/notion-page-edit', {
        method: 'POST',
        body: { pageId: 'p1', workspaceId: 'nws_1' },
      }) as never,
      makeCtx({}),
    );
    expect(res.status).toBe(200);
    const body = await readJson<{ debouncedSeconds: number }>(res);
    expect(body.debouncedSeconds).toBe(30);
  });

  it('returns 401 on signature mismatch', async () => {
    const nc = await import('@forge/notion-client');
    vi.mocked(nc.verifyNotionWebhookSignature).mockResolvedValue({
      valid: false,
      reason: 'signature_mismatch',
    });
    const { POST } = await import('@/app/api/webhooks/notion-page-edit/route');
    const res = await POST(
      makeRequest('http://localhost/api/webhooks/notion-page-edit', {
        method: 'POST',
        body: { pageId: 'p1', workspaceId: 'nws_1' },
      }) as never,
      makeCtx({}),
    );
    expect(res.status).toBe(401);
  });

  it('returns 400 when neither header nor body has a workspace id', async () => {
    const { POST } = await import('@/app/api/webhooks/notion-page-edit/route');
    const res = await POST(
      makeRequest('http://localhost/api/webhooks/notion-page-edit', {
        method: 'POST',
        body: { pageId: 'p1' },
      }) as never,
      makeCtx({}),
    );
    expect(res.status).toBe(400);
  });
});
