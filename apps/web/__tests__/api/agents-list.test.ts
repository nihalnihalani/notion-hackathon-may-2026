/**
 * GET /api/agents
 *   200 with agents + nextCursor on happy path
 *   401 without session
 *   400 with invalid query (e.g. status value)
 *   nextCursor populated when more than `limit` rows are returned
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
    generatedAgent: { findMany: vi.fn() },
  },
}));

const fakeUser = { id: 'user_1', workspace: { id: 'ws_1' } };

beforeEach(async () => {
  vi.resetAllMocks();
  vi.resetModules();
  const clerk = await import('@clerk/nextjs/server');
  vi.mocked(clerk.auth).mockResolvedValue({ userId: 'clerk_1' } as never);
  const db = await import('@forge/db');
  vi.mocked(db.prisma.user.findUnique).mockResolvedValue(fakeUser as never);
});

function row(i: number) {
  return {
    id: `a${i}`,
    workspaceId: 'ws_1',
    generationId: `g${i}`,
    ntnWorkerName: `forge-x-${i}`,
    ntnDeployUrl: null,
    notionCustomAgentId: null,
    pattern: 'database_query',
    description: 'd',
    sourceBlobUrl: 'blob:',
    avatarUrl: null,
    capabilities: [],
    oauthProviders: [],
    webhookUrl: null,
    status: 'active',
    createdAt: new Date(2_026_000_000_000 - i * 1000),
    lastInvokedAt: null,
    totalInvocations: 0,
  };
}

describe('GET /api/agents', () => {
  it('returns a list with nextCursor when over the limit', async () => {
    const db = await import('@forge/db');
    vi.mocked(db.prisma.generatedAgent.findMany).mockResolvedValue(
      Array.from({ length: 51 }, (_, i) => row(i)) as never,
    );
    const { GET } = await import('@/app/api/agents/route');
    const res = await GET(
      makeRequest('http://localhost/api/agents?limit=50') as never,
      makeCtx({}),
    );
    expect(res.status).toBe(200);
    const body = await readJson<{ agents: unknown[]; nextCursor: string | null }>(res);
    expect(body.agents.length).toBe(50);
    expect(body.nextCursor).not.toBeNull();
  });

  it('returns 401 without session', async () => {
    const clerk = await import('@clerk/nextjs/server');
    vi.mocked(clerk.auth).mockResolvedValue({ userId: null } as never);
    const { GET } = await import('@/app/api/agents/route');
    const res = await GET(
      makeRequest('http://localhost/api/agents') as never,
      makeCtx({}),
    );
    expect(res.status).toBe(401);
  });

  it('returns 400 with an invalid status query', async () => {
    const { GET } = await import('@/app/api/agents/route');
    const res = await GET(
      makeRequest('http://localhost/api/agents?status=bogus') as never,
      makeCtx({}),
    );
    expect(res.status).toBe(400);
  });
});
