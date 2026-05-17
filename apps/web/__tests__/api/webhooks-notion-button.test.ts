/**
 * POST /api/webhooks/notion-button
 *   401 on signature mismatch
 *   200 + ignored on unknown workspace
 *   200 + cached when an existing successful generation matches
 *   200 + queued on the happy path
 *   400 on stale envelope timestamp (>5min old)
 *   400 on future envelope timestamp (>1min in the future)
 *   400 on missing envelope id/timestamp
 *   200 + duplicate on Redis dedupe hit (handler NOT invoked)
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeCtx, makeRequest, readJson, stubSentryWrapper } from './_helpers';

stubSentryWrapper();

vi.mock('@/lib/webhook-dedup', () => ({
  checkWebhookReplay: vi.fn(),
}));

vi.mock('@forge/db', () => ({
  prisma: {
    user: { findFirst: vi.fn() },
    workspace: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'ws_1',
        webhookSecret: 's3cr3t',
      }),
    },
  },
  createGeneration: vi.fn().mockResolvedValue({ id: 'gen_new' }),
  descriptionHash: vi.fn().mockResolvedValue('hash-abc'),
  findRecentByHash: vi.fn(),
  findWorkspaceByNotionId: vi.fn(),
  recordAuditEvent: vi.fn(),
}));

vi.mock('@forge/notion-client', () => ({
  addComment: vi.fn().mockResolvedValue(undefined),
  asBlockId: (s: string) => s,
  asPageId: (s: string) => s,
  getPage: vi.fn(),
  verifyNotionWebhookSignature: vi.fn(),
}));

vi.mock('@/lib/notion', () => ({
  getNotionTokenForClerkUser: vi.fn().mockResolvedValue('ntoken'),
  buildNotionConfig: () => ({ token: 'ntoken' }),
}));

vi.mock('@forge/workflows', () => ({
  publishGenerationRequested: vi.fn().mockResolvedValue({ runId: 'r1' }),
}));

vi.mock('@/lib/posthog', () => ({ capture: vi.fn() }));

beforeEach(async () => {
  vi.resetAllMocks();
  vi.resetModules();
  process.env['NOTION_WEBHOOK_SECRET'] = 's3cr3t';

  // Re-prime the notion lib token resolver after resetAllMocks cleared it.
  const ln = await import('@/lib/notion');
  vi.mocked(ln.getNotionTokenForClerkUser).mockResolvedValue('ntoken');

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
    notionWorkspaceId: 'nws_1',
    forgeBuildLogBlockId: 'blk_log_1',
    defaultModel: 'gpt-5.5',
  } as never);
  vi.mocked(db.prisma.user.findFirst).mockResolvedValue({
    id: 'user_1',
    clerkId: 'clerk_owner',
  } as never);
  vi.mocked(db.prisma.workspace.findUnique).mockResolvedValue({
    id: 'ws_1',
    webhookSecret: 's3cr3t',
  } as never);
  vi.mocked(db.findRecentByHash).mockResolvedValue(null);

  const dedup = await import('@/lib/webhook-dedup');
  vi.mocked(dedup.checkWebhookReplay).mockResolvedValue({
    ok: true,
    duplicate: false,
  });
});

function payload(over: Partial<{ id: string; timestamp: string }> = {}) {
  return {
    id: over.id ?? 'evt_1',
    timestamp: over.timestamp ?? new Date().toISOString(),
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
    const wf = await import('@forge/workflows');
    expect(wf.publishGenerationRequested).toHaveBeenCalledWith(
      expect.objectContaining({ defaultModel: 'gpt-5.5' }),
    );
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

  it('returns 400 on stale envelope timestamp (>5 min old)', async () => {
    const dedup = await import('@/lib/webhook-dedup');
    vi.mocked(dedup.checkWebhookReplay).mockResolvedValue({
      ok: false,
      reason: 'stale',
    });
    const db = await import('@forge/db');
    const { POST } = await import('@/app/api/webhooks/notion-button/route');
    const res = await POST(
      makeRequest('http://localhost/api/webhooks/notion-button', {
        method: 'POST',
        body: payload({ timestamp: new Date(Date.now() - 6 * 60_000).toISOString() }),
      }) as never,
      makeCtx({}),
    );
    expect(res.status).toBe(400);
    // Business-logic side effects MUST NOT fire on a rejected envelope.
    expect(db.createGeneration).not.toHaveBeenCalled();
    expect(db.findRecentByHash).not.toHaveBeenCalled();
  });

  it('returns 400 on future envelope timestamp (>1 min skew)', async () => {
    const dedup = await import('@/lib/webhook-dedup');
    vi.mocked(dedup.checkWebhookReplay).mockResolvedValue({
      ok: false,
      reason: 'future_skew',
    });
    const db = await import('@forge/db');
    const { POST } = await import('@/app/api/webhooks/notion-button/route');
    const res = await POST(
      makeRequest('http://localhost/api/webhooks/notion-button', {
        method: 'POST',
        body: payload({ timestamp: new Date(Date.now() + 120_000).toISOString() }),
      }) as never,
      makeCtx({}),
    );
    expect(res.status).toBe(400);
    expect(db.createGeneration).not.toHaveBeenCalled();
  });

  it('returns 400 when envelope is missing id/timestamp', async () => {
    const db = await import('@forge/db');
    const { POST } = await import('@/app/api/webhooks/notion-button/route');
    // Drop both `id` and `timestamp` from the envelope.
    const { id: _id, timestamp: _ts, ...stripped } = payload();
    void _id;
    void _ts;
    const res = await POST(
      makeRequest('http://localhost/api/webhooks/notion-button', {
        method: 'POST',
        body: stripped,
      }) as never,
      makeCtx({}),
    );
    expect(res.status).toBe(400);
    expect(db.createGeneration).not.toHaveBeenCalled();
    // Envelope validation happens before the dedupe Redis call.
    const dedup = await import('@/lib/webhook-dedup');
    expect(dedup.checkWebhookReplay).not.toHaveBeenCalled();
  });

  it('returns 200 + duplicate on dedupe hit and does NOT invoke business logic', async () => {
    const dedup = await import('@/lib/webhook-dedup');
    vi.mocked(dedup.checkWebhookReplay).mockResolvedValue({
      ok: true,
      duplicate: true,
      eventId: 'evt_1',
    });
    const db = await import('@forge/db');
    const wf = await import('@forge/workflows');
    const { POST } = await import('@/app/api/webhooks/notion-button/route');
    const res = await POST(
      makeRequest('http://localhost/api/webhooks/notion-button', {
        method: 'POST',
        body: payload(),
      }) as never,
      makeCtx({}),
    );
    expect(res.status).toBe(200);
    const body = await readJson<{ status: string; eventId: string }>(res);
    expect(body.status).toBe('duplicate');
    expect(body.eventId).toBe('evt_1');
    // Critical: handler must NOT have done any work on a duplicate.
    expect(db.createGeneration).not.toHaveBeenCalled();
    expect(db.findRecentByHash).not.toHaveBeenCalled();
    expect(wf.publishGenerationRequested).not.toHaveBeenCalled();
  });
});
