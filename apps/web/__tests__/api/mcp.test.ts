/**
 * /api/mcp
 *
 * The route is now a thin auth + per-request wiring layer around
 * `@forge/mcp-server`. We stub the SDK-backed package by re-exporting a
 * tiny in-memory server factory + transport adapter; this lets us exercise
 * the route's auth path without standing up the real MCP protocol stack.
 *
 *   GET  → 401 with no/invalid bearer
 *   GET  → 405 from the package's transport on a valid bearer
 *   POST → 401 with no/invalid bearer
 *   POST → 200 with a JSON-RPC envelope on a valid bearer
 *   POST → 401 if the workspace bound to the key was deleted
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeCtx, makeRequest, readJson, stubSentryWrapper } from './_helpers';

stubSentryWrapper();

// --- @forge/db stubs -------------------------------------------------------
vi.mock('@forge/db', () => ({
  createGeneration: vi.fn().mockResolvedValue({ id: 'gen_mcp' }),
  descriptionHash: vi.fn().mockResolvedValue('hash'),
  findActiveAgentsByWorkspace: vi.fn().mockResolvedValue([]),
  findRecentByHash: vi.fn().mockResolvedValue(null),
  getGenerationWithSteps: vi.fn().mockResolvedValue(null),
  prisma: {
    workspace: {
      findUnique: vi.fn().mockResolvedValue({
        notionWorkspaceId: 'nws_test',
        forgeBuildLogBlockId: 'blk_log',
      }),
    },
  },
}));

vi.mock('@forge/workflows', () => ({
  publishGenerationRequested: vi.fn().mockResolvedValue({ runId: 'r1' }),
}));

vi.mock('@forge/notion-client', () => ({
  asBlockId: (s: string) => s,
}));

// --- @forge/mcp-server stub ------------------------------------------------
// The package wires the official MCP SDK + an in-memory transport adapter.
// For the route tests we only care that the route hands authentication +
// config off to the package — the package's own integration tests cover the
// JSON-RPC pump. We assert via a recorder spy that the route passed a valid
// `ForgeMcpContext` through.
const handleMcpHttpRequestMock = vi.fn();
const createForgeMcpServerMock = vi.fn();
vi.mock('@forge/mcp-server', () => ({
  createForgeMcpServer: (...args: unknown[]) => createForgeMcpServerMock(...args),
  handleMcpHttpRequest: (...args: unknown[]) => handleMcpHttpRequestMock(...args),
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

beforeEach(async () => {
  vi.resetAllMocks();
  vi.resetModules();
  validateApiKeyMock.mockResolvedValue({ userId: 'user_1', workspaceId: 'ws_1' });
  checkRateLimitMock.mockResolvedValue({ success: true, reset: 0, remaining: 30, limit: 30 });
  // Re-prime the DB mocks after resetAllMocks blew them away.
  const db = await import('@forge/db');
  vi.mocked(db.prisma.workspace.findUnique).mockResolvedValue({
    notionWorkspaceId: 'nws_test',
    forgeBuildLogBlockId: 'blk_log',
  } as never);
  vi.mocked(db.createGeneration).mockResolvedValue({ id: 'gen_mcp' } as never);
  vi.mocked(db.descriptionHash).mockResolvedValue('hash');
  vi.mocked(db.findRecentByHash).mockResolvedValue(null);
  vi.mocked(db.findActiveAgentsByWorkspace).mockResolvedValue([]);
  vi.mocked(db.getGenerationWithSteps).mockResolvedValue(null);
  // Default handleMcpHttpRequest returns a canned JSON-RPC OK envelope.
  handleMcpHttpRequestMock.mockResolvedValue(
    new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
  createForgeMcpServerMock.mockReturnValue({ name: 'mcp-server' });
});

afterEach(() => vi.resetModules());

describe('GET /api/mcp', () => {
  it('returns 401 without bearer', async () => {
    validateApiKeyMock.mockResolvedValue(null);
    const { GET } = await import('@/app/api/mcp/route');
    const res = await GET(
      makeRequest('http://localhost/api/mcp') as never,
      makeCtx({}),
    );
    expect(res.status).toBe(401);
  });

  it('delegates to the package transport on valid bearer', async () => {
    handleMcpHttpRequestMock.mockResolvedValueOnce(
      new Response('Method Not Allowed', {
        status: 405,
        headers: { Allow: 'POST' },
      }),
    );
    const { GET } = await import('@/app/api/mcp/route');
    const res = await GET(
      new Request('http://localhost/api/mcp', {
        headers: { authorization: 'Bearer good-key' },
      }) as never,
      makeCtx({}),
    );
    expect(res.status).toBe(405);
    expect(handleMcpHttpRequestMock).toHaveBeenCalledTimes(1);
    // The route must have constructed an MCP server with the validated context.
    const ctxArg = createForgeMcpServerMock.mock.calls[0]?.[0];
    expect(ctxArg).toMatchObject({
      userId: 'user_1',
      workspaceId: 'ws_1',
      notionWorkspaceId: 'nws_test',
    });
  });
});

describe('POST /api/mcp', () => {
  it('returns 401 without bearer', async () => {
    validateApiKeyMock.mockResolvedValue(null);
    const { POST } = await import('@/app/api/mcp/route');
    const res = await POST(
      makeRequest('http://localhost/api/mcp', {
        method: 'POST',
        body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      }) as never,
      makeCtx({}),
    );
    expect(res.status).toBe(401);
  });

  it('returns 401 when the bound workspace is gone', async () => {
    const db = await import('@forge/db');
    vi.mocked(db.prisma.workspace.findUnique).mockResolvedValueOnce(null as never);
    const { POST } = await import('@/app/api/mcp/route');
    const res = await POST(
      makeRequest('http://localhost/api/mcp', {
        method: 'POST',
        headers: { authorization: 'Bearer good-key' },
        body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      }) as never,
      makeCtx({}),
    );
    expect(res.status).toBe(401);
  });

  it('hands the JSON-RPC body to the package transport on valid bearer', async () => {
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
    const body = await readJson<{ jsonrpc: string; result: { ok: boolean } }>(res);
    expect(body.result.ok).toBe(true);
    expect(handleMcpHttpRequestMock).toHaveBeenCalledTimes(1);
  });
});
