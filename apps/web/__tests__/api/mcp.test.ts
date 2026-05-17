/**
 * /api/mcp
 *   GET  → 401 with no/invalid bearer
 *   GET  → 200 with text/event-stream on valid bearer
 *   POST → tools/list returns the catalog
 *   POST → tools/call forge_agent queues a generation
 *   POST → 429 when rate-limited
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeCtx, makeRequest, readJson, stubSentryWrapper } from './_helpers';

stubSentryWrapper();

vi.mock('@forge/db', () => ({
  createGeneration: vi.fn().mockResolvedValue({ id: 'gen_mcp' }),
  descriptionHash: vi.fn().mockResolvedValue('hash'),
  findRecentByHash: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/lib/workflows', () => ({
  publishGenerationRequested: vi.fn().mockResolvedValue({ workflowRunId: 'r1' }),
}));

const validateApiKeyMock = vi.fn();
vi.mock('@/lib/api-keys', () => ({
  validateApiKey: (k: string) => validateApiKeyMock(k),
  extractBearer: (req: Request) => {
    const h = req.headers.get('authorization');
    if (!h?.toLowerCase().startsWith('bearer ')) return null;
    return h.slice(7).trim() || null;
  },
}));

const checkRateLimitMock = vi.fn();
vi.mock('@/lib/ratelimit', () => ({
  checkRateLimit: (...args: unknown[]) => checkRateLimitMock(...args),
  limiters: { mcpForgeAgent: () => ({}) },
}));

beforeEach(() => {
  vi.resetAllMocks();
  vi.resetModules();
  validateApiKeyMock.mockResolvedValue({ userId: 'user_1', workspaceId: 'ws_1' });
  checkRateLimitMock.mockResolvedValue({ success: true, reset: 0, remaining: 30, limit: 30 });
});

afterEach(() => vi.resetModules());

describe('GET /api/mcp (SSE)', () => {
  it('returns 401 without bearer', async () => {
    validateApiKeyMock.mockResolvedValue(null);
    const { GET } = await import('@/app/api/mcp/route');
    const res = await GET(
      makeRequest('http://localhost/api/mcp') as never,
      makeCtx({}),
    );
    expect(res.status).toBe(401);
  });

  it('returns text/event-stream on valid bearer', async () => {
    const { GET } = await import('@/app/api/mcp/route');
    const ac = new AbortController();
    const res = await GET(
      new Request('http://localhost/api/mcp', {
        headers: { authorization: 'Bearer good-key' },
        signal: ac.signal,
      }) as never,
      makeCtx({}),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    // Close the SSE so vitest exits cleanly.
    ac.abort();
    if (res.body) {
      try {
        await res.body.cancel();
      } catch {
        // already closed
      }
    }
  });
});

describe('POST /api/mcp (JSON-RPC)', () => {
  it('returns the tool catalog on tools/list', async () => {
    const { POST } = await import('@/app/api/mcp/route');
    const res = await POST(
      makeRequest('http://localhost/api/mcp', {
        method: 'POST',
        headers: { authorization: 'Bearer good-key' },
        body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      }) as never,
      makeCtx({}),
    );
    expect(res.status).toBe(200);
    const body = await readJson<{ result: { tools: Array<{ name: string }> } }>(res);
    expect(body.result.tools[0]?.name).toBe('forge_agent');
  });

  it('queues a generation on tools/call forge_agent', async () => {
    const { POST } = await import('@/app/api/mcp/route');
    const res = await POST(
      makeRequest('http://localhost/api/mcp', {
        method: 'POST',
        headers: { authorization: 'Bearer good-key' },
        body: {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'forge_agent', arguments: { description: 'Triage bugs' } },
        },
      }) as never,
      makeCtx({}),
    );
    expect(res.status).toBe(200);
    const body = await readJson<{ result?: { content?: Array<{ text?: string }> } }>(res);
    expect(body.result?.content?.[0]?.text).toContain('Queued');
  });

  it('returns rate-limit JSON-RPC error', async () => {
    checkRateLimitMock.mockResolvedValue({
      success: false,
      reset: Date.now() + 5_000,
      remaining: 0,
      limit: 30,
    });
    const { POST } = await import('@/app/api/mcp/route');
    const res = await POST(
      makeRequest('http://localhost/api/mcp', {
        method: 'POST',
        headers: { authorization: 'Bearer good-key' },
        body: {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'forge_agent', arguments: { description: 'x' } },
        },
      }) as never,
      makeCtx({}),
    );
    expect(res.status).toBe(200);
    const body = await readJson<{ error?: { message: string } }>(res);
    expect(body.error?.message).toMatch(/rate limited/i);
  });
});
