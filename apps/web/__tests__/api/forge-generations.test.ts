/**
 * GET /api/forge/generations/[id]
 *   200 with body shape on success
 *   401 with no session
 *   403 when generation belongs to another workspace
 *   404 when generation does not exist
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
    generation: { findUnique: vi.fn() },
  },
  getGenerationWithSteps: vi.fn(),
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

describe('GET /api/forge/generations/[id]', () => {
  it('returns the generation with steps on the happy path', async () => {
    const db = await import('@forge/db');
    vi.mocked(db.prisma.generation.findUnique).mockResolvedValue({
      id: 'gen_1',
      workspaceId: 'ws_1',
    } as never);
    vi.mocked(db.getGenerationWithSteps).mockResolvedValue({
      id: 'gen_1',
      status: 'succeeded',
      pattern: 'database_query',
      agentId: 'agent_1',
      startedAt: new Date('2026-05-17T00:00:00Z'),
      completedAt: new Date('2026-05-17T00:01:30Z'),
      totalLatencyMs: 90_000,
      totalCostUsd: null,
      steps: [],
    } as never);

    const { GET } = await import('@/app/api/forge/generations/[id]/route');
    const res = await GET(
      makeRequest('http://localhost/api/forge/generations/gen_1') as never,
      makeCtx({ id: 'gen_1' }),
    );
    expect(res.status).toBe(200);
    const body = await readJson<{ id: string; status: string }>(res);
    expect(body.id).toBe('gen_1');
    expect(body.status).toBe('succeeded');
  });

  it('returns 401 with no Clerk session', async () => {
    const clerk = await import('@clerk/nextjs/server');
    vi.mocked(clerk.auth).mockResolvedValue({ userId: null } as never);
    const { GET } = await import('@/app/api/forge/generations/[id]/route');
    const res = await GET(
      makeRequest('http://localhost/api/forge/generations/gen_1') as never,
      makeCtx({ id: 'gen_1' }),
    );
    expect(res.status).toBe(401);
  });

  it('returns 404 when the generation does not exist', async () => {
    const db = await import('@forge/db');
    vi.mocked(db.prisma.generation.findUnique).mockResolvedValue(null as never);
    const { GET } = await import('@/app/api/forge/generations/[id]/route');
    const res = await GET(
      makeRequest('http://localhost/api/forge/generations/missing') as never,
      makeCtx({ id: 'missing' }),
    );
    expect(res.status).toBe(404);
  });

  it('returns 403 when the generation belongs to another workspace', async () => {
    const db = await import('@forge/db');
    vi.mocked(db.prisma.generation.findUnique).mockResolvedValue({
      id: 'gen_other',
      workspaceId: 'ws_other',
    } as never);
    const { GET } = await import('@/app/api/forge/generations/[id]/route');
    const res = await GET(
      makeRequest('http://localhost/api/forge/generations/gen_other') as never,
      makeCtx({ id: 'gen_other' }),
    );
    expect(res.status).toBe(403);
  });
});
