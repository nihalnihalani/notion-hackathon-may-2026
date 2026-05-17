/**
 * POST /api/agents/[id]/redeploy
 *   202 on success → returns { generationId, status: "queued" }
 *      and publishes a fresh `forge/generation.requested` event with
 *      force: true.
 *   403/404 when the agent isn't owned by the caller's workspace
 *   404 when the agent row disappeared between the ownership check and the
 *       description re-pull
 *   502 when the workflow publisher throws
 *   401 without session
 *   429 on rate limit
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
    generatedAgent: { findUnique: vi.fn() },
  },
  createGeneration: vi.fn(),
  descriptionHash: vi.fn(),
  recordAuditEvent: vi.fn(),
}));

vi.mock('@forge/notion-client', () => ({
  asBlockId: (s: string) => s,
}));

vi.mock('@forge/workflows', () => ({
  publishGenerationRequested: vi.fn(),
}));

vi.mock('@/lib/posthog', () => ({ capture: vi.fn() }));

const checkRateLimitMock = vi.fn();
vi.mock('@/lib/ratelimit', () => ({
  checkRateLimit: (...args: unknown[]) => checkRateLimitMock(...args),
  limiters: { forgeTrigger: () => ({}) },
}));

const installedWorkspace = {
  id: 'ws_1',
  ownerUserId: 'clerk_1',
  notionWorkspaceId: 'nws_1',
  forgeBuildLogBlockId: 'block_1',
  defaultModel: 'gpt-5.5',
};

beforeEach(async () => {
  vi.resetAllMocks();
  vi.resetModules();
  const clerk = await import('@clerk/nextjs/server');
  vi.mocked(clerk.auth).mockResolvedValue({ userId: 'clerk_1' } as never);
  const db = await import('@forge/db');
  vi.mocked(db.prisma.user.findUnique).mockResolvedValue({
    id: 'user_1',
    clerkId: 'clerk_1',
    email: 'u@example.com',
    workspace: installedWorkspace,
  } as never);
  // First call from requireAgentOwnership; the route also makes a second
  // findUnique to re-pull the description. Both succeed by default.
  vi.mocked(db.prisma.generatedAgent.findUnique).mockResolvedValue({
    id: 'a1',
    workspaceId: 'ws_1',
    ntnWorkerName: 'forge-x-aaa',
    description: 'do the thing',
  } as never);
  vi.mocked(db.descriptionHash).mockResolvedValue('hash_xyz' as never);
  vi.mocked(db.createGeneration).mockResolvedValue({
    id: 'gen_new',
  } as never);
  checkRateLimitMock.mockResolvedValue({
    success: true,
    reset: 0,
    remaining: 100,
    limit: 120,
  });
});

describe('POST /api/agents/[id]/redeploy', () => {
  it('returns 202 + queued + publishes the workflow event', async () => {
    const { POST } = await import('@/app/api/agents/[id]/redeploy/route');
    const res = await POST(
      makeRequest('http://localhost/api/agents/a1/redeploy', {
        method: 'POST',
      }) as never,
      makeCtx({ id: 'a1' }),
    );
    expect(res.status).toBe(202);
    const body = await readJson<{ generationId: string; status: string }>(res);
    expect(body).toEqual({ generationId: 'gen_new', status: 'queued' });

    const wf = await import('@forge/workflows');
    expect(wf.publishGenerationRequested).toHaveBeenCalledWith(
      expect.objectContaining({
        generationId: 'gen_new',
        workspaceId: 'ws_1',
        force: true,
        defaultModel: 'gpt-5.5',
      }),
    );

    const db = await import('@forge/db');
    expect(db.recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'agent.redeployed',
        metadata: expect.objectContaining({
          agentId: 'a1',
          workerName: 'forge-x-aaa',
          newGenerationId: 'gen_new',
        }),
      }),
    );
  });

  it('returns 403/404 when agent belongs to another workspace', async () => {
    const db = await import('@forge/db');
    vi.mocked(db.prisma.generatedAgent.findUnique).mockResolvedValue({
      id: 'a1',
      workspaceId: 'ws_OTHER',
      ntnWorkerName: 'forge-x-aaa',
      description: 'd',
    } as never);
    const { POST } = await import('@/app/api/agents/[id]/redeploy/route');
    const res = await POST(
      makeRequest('http://localhost/api/agents/a1/redeploy', {
        method: 'POST',
      }) as never,
      makeCtx({ id: 'a1' }),
    );
    expect([403, 404]).toContain(res.status);
    const wf = await import('@forge/workflows');
    expect(wf.publishGenerationRequested).not.toHaveBeenCalled();
  });

  it('returns 502 when the workflow publisher throws', async () => {
    const wf = await import('@forge/workflows');
    vi.mocked(wf.publishGenerationRequested).mockRejectedValue(new Error('queue down'));
    const { POST } = await import('@/app/api/agents/[id]/redeploy/route');
    const res = await POST(
      makeRequest('http://localhost/api/agents/a1/redeploy', {
        method: 'POST',
      }) as never,
      makeCtx({ id: 'a1' }),
    );
    expect(res.status).toBe(502);
  });

  it('returns 401 without session', async () => {
    const clerk = await import('@clerk/nextjs/server');
    vi.mocked(clerk.auth).mockResolvedValue({ userId: null } as never);
    const { POST } = await import('@/app/api/agents/[id]/redeploy/route');
    const res = await POST(
      makeRequest('http://localhost/api/agents/a1/redeploy', {
        method: 'POST',
      }) as never,
      makeCtx({ id: 'a1' }),
    );
    expect(res.status).toBe(401);
  });

  it('returns 429 when rate-limited', async () => {
    checkRateLimitMock.mockResolvedValue({
      success: false,
      reset: Date.now() + 5_000,
      remaining: 0,
      limit: 120,
    });
    const { POST } = await import('@/app/api/agents/[id]/redeploy/route');
    const res = await POST(
      makeRequest('http://localhost/api/agents/a1/redeploy', {
        method: 'POST',
      }) as never,
      makeCtx({ id: 'a1' }),
    );
    expect(res.status).toBe(429);
  });
});
