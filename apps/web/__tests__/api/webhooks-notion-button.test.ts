/**
 * POST /api/webhooks/notion-button
 *   401 on signature mismatch
 *   200 + ignored on unknown workspace
 *   200 + cached when an existing successful generation matches
 *   200 + queued on the happy path
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeCtx, makeRequest, readJson, stubSentryWrapper } from './_helpers';

stubSentryWrapper();

vi.mock('@forge/db', () => ({
  prisma: { user: { findFirst: vi.fn() } },
  createGeneration: vi.fn().mockResolvedValue({ id: 'gen_new' }),
  descriptionHash: vi.fn().mockResolvedValue('hash-abc'),
  findRecentByHash: vi.fn(),
  findWorkspaceByNotionId: vi.fn(),
}));

vi.mock('@forge/notion-client', () => ({
  addComment: vi.fn().mockResolvedValue(undefined),
  asPageId: (s: string) => s,
  getPage: vi.fn(),
  verifyNotionWebhookSignature: vi.fn(),
}));

vi.mock('@/lib/notion', () => ({
  getNotionTokenForClerkUser: vi.fn().mockResolvedValue('ntoken'),
  buildNotionConfig: () => ({ token: 'ntoken' }),
}));

vi.mock('@/lib/workflows', () => ({
  publishGenerationRequested: vi.fn().mockResolvedValue({ workflowRunId: 'r1' }),
}));

vi.mock('@/lib/posthog', () => ({ capture: vi.fn() }));

beforeEach(async () => {
  vi.resetAllMocks();
  vi.resetModules();
  process.env['NOTION_WEBHOOK_SECRET'] = 's3cr3t';

  const nc = await import('@forge/notion-client');
  vi.mocked(nc.verifyNotionWebhookSignature).mockResolvedValue({ valid: true });
  vi.mocked(nc.getPage).mockResolvedValue({
    properties: {
      Description: {
        title: [{ plain_text: 'Triage Linear bugs' }],
      },
    },
  } as never);

  const db = await import('@forge/db');
  vi.mocked(db.findWorkspaceByNotionId).mockResolvedValue({
    id: 'ws_1',
    ownerUserId: 'clerk_owner',
  } as never);
  vi.mocked(db.prisma.user.findFirst).mockResolvedValue({
    id: 'user_1',
    clerkId: 'clerk_owner',
  } as never);
  vi.mocked(db.findRecentByHash).mockResolvedValue(null);
});

function payload() {
  return {
    pageId: 'page_1',
    blockId: 'block_1',
    userId: 'notion_user_1',
    workspaceId: 'nws_1',
  };
}

describe('POST /api/webhooks/notion-button', () => {
  it('queues a generation on the happy path', async () => {
    const { POST } = await import('@/app/api/webhooks/notion-button/route');
    const res = await POST(
      makeRequest('http://localhost/api/webhooks/notion-button', {
        method: 'POST',
        body: payload(),
      }) as never,
      makeCtx({}),
    );
    expect(res.status).toBe(200);
    const body = await readJson<{ status: string; generationId: string }>(res);
    expect(body.status).toBe('queued');
    expect(body.generationId).toBe('gen_new');
  });

  it('returns 401 on signature mismatch', async () => {
    const nc = await import('@forge/notion-client');
    vi.mocked(nc.verifyNotionWebhookSignature).mockResolvedValue({
      valid: false,
      reason: 'signature_mismatch',
    });
    const { POST } = await import('@/app/api/webhooks/notion-button/route');
    const res = await POST(
      makeRequest('http://localhost/api/webhooks/notion-button', {
        method: 'POST',
        body: payload(),
      }) as never,
      makeCtx({}),
    );
    expect(res.status).toBe(401);
  });

  it('returns 200 + ignored when workspace not installed', async () => {
    const db = await import('@forge/db');
    vi.mocked(db.findWorkspaceByNotionId).mockResolvedValue(null);
    const { POST } = await import('@/app/api/webhooks/notion-button/route');
    const res = await POST(
      makeRequest('http://localhost/api/webhooks/notion-button', {
        method: 'POST',
        body: payload(),
      }) as never,
      makeCtx({}),
    );
    expect(res.status).toBe(200);
    const body = await readJson<{ ignored: string }>(res);
    expect(body.ignored).toBe('not_installed');
  });

  it('returns cached on idempotency hit', async () => {
    const db = await import('@forge/db');
    vi.mocked(db.findRecentByHash).mockResolvedValue({
      id: 'gen_old',
      agentId: 'agent_old',
    } as never);
    const { POST } = await import('@/app/api/webhooks/notion-button/route');
    const res = await POST(
      makeRequest('http://localhost/api/webhooks/notion-button', {
        method: 'POST',
        body: payload(),
      }) as never,
      makeCtx({}),
    );
    expect(res.status).toBe(200);
    const body = await readJson<{ status: string; generationId: string }>(res);
    expect(body.status).toBe('cached');
    expect(body.generationId).toBe('gen_old');
  });
});
