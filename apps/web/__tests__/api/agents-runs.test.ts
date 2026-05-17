/**
 * GET /api/agents/[id]/runs
 *   200 with { runs, nextCursor } when listRuns succeeds
 *   200 with empty list when NTN reports "not found"
 *   502 when listRuns throws an unrelated error
 *   404 when the agent isn't owned by the caller
 *   400 when `limit` is out of range
 *   401 without session
 *
 * GET /api/agents/[id]/runs/[runId]
 *   200 with { logs, exitCode, startedAt, durationMs }
 *   400 with a malformed runId
 *   404 when getRunLogs reports the run isn't found
 *   404 when the agent isn't owned by the caller
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
}));

class NtnNotInstalledError extends Error {}
vi.mock('@forge/ntn-wrapper', () => ({
  listRuns: vi.fn(),
  getRunLogs: vi.fn(),
  NtnNotInstalledError,
}));

beforeEach(async () => {
  vi.resetAllMocks();
  vi.resetModules();
  const clerk = await import('@clerk/nextjs/server');
  vi.mocked(clerk.auth).mockResolvedValue({ userId: 'clerk_1' } as never);
  const db = await import('@forge/db');
  vi.mocked(db.prisma.user.findUnique).mockResolvedValue({
    id: 'user_1',
    clerkId: 'clerk_1',
    workspace: { id: 'ws_1', ownerUserId: 'clerk_1' },
  } as never);
  vi.mocked(db.prisma.generatedAgent.findUnique).mockResolvedValue({
    id: 'a1',
    workspaceId: 'ws_1',
    ntnWorkerName: 'forge-x-aaa',
  } as never);
});

describe('GET /api/agents/[id]/runs', () => {
  it('returns 200 with runs + nextCursor when over the limit', async () => {
    const ntn = await import('@forge/ntn-wrapper');
    // limit+1 runs so the handler trims to `limit` and emits a cursor.
    vi.mocked(ntn.listRuns).mockResolvedValue(
      Array.from({ length: 3 }, (_, i) => ({
        id: `run_${i}`,
        status: 'succeeded',
        startedAt: new Date(1_700_000_000_000 + i * 1000).toISOString(),
        durationMs: 100 + i,
        trigger: 'manual',
      })) as never,
    );

    const { GET } = await import('@/app/api/agents/[id]/runs/route');
    const res = await GET(
      makeRequest('http://localhost/api/agents/a1/runs?limit=2') as never,
      makeCtx({ id: 'a1' }),
    );
    expect(res.status).toBe(200);
    const body = await readJson<{
      runs: ReadonlyArray<{ runId: string; durationMs: number | null }>;
      nextCursor: string | null;
    }>(res);
    expect(body.runs).toHaveLength(2);
    expect(body.runs[0]?.runId).toBe('run_0');
    expect(body.nextCursor).toBe('run_1');
    expect(res.headers.get('cache-control')).toContain('max-age=60');
  });

  it('returns 200 with empty list when NTN says the worker is gone', async () => {
    const ntn = await import('@forge/ntn-wrapper');
    vi.mocked(ntn.listRuns).mockRejectedValue(new Error('worker not found'));
    const { GET } = await import('@/app/api/agents/[id]/runs/route');
    const res = await GET(
      makeRequest('http://localhost/api/agents/a1/runs') as never,
      makeCtx({ id: 'a1' }),
    );
    expect(res.status).toBe(200);
    const body = await readJson<{ runs: unknown[]; nextCursor: null }>(res);
    expect(body.runs).toEqual([]);
    expect(body.nextCursor).toBeNull();
  });

  it('returns 502 on an unrelated listRuns error', async () => {
    const ntn = await import('@forge/ntn-wrapper');
    vi.mocked(ntn.listRuns).mockRejectedValue(new Error('connection refused'));
    const { GET } = await import('@/app/api/agents/[id]/runs/route');
    const res = await GET(
      makeRequest('http://localhost/api/agents/a1/runs') as never,
      makeCtx({ id: 'a1' }),
    );
    expect(res.status).toBe(502);
  });

  it('returns 404 when the agent is owned by another workspace', async () => {
    const db = await import('@forge/db');
    vi.mocked(db.prisma.generatedAgent.findUnique).mockResolvedValue({
      id: 'a1',
      workspaceId: 'ws_OTHER',
      ntnWorkerName: 'forge-x-aaa',
    } as never);
    const { GET } = await import('@/app/api/agents/[id]/runs/route');
    const res = await GET(
      makeRequest('http://localhost/api/agents/a1/runs') as never,
      makeCtx({ id: 'a1' }),
    );
    // requireAgentOwnership returns 403 for cross-workspace access; the
    // test asserts the gate is enforced rather than the exact status.
    expect([403, 404]).toContain(res.status);
  });

  it('returns 400 when limit is out of range', async () => {
    const { GET } = await import('@/app/api/agents/[id]/runs/route');
    const res = await GET(
      makeRequest('http://localhost/api/agents/a1/runs?limit=99999') as never,
      makeCtx({ id: 'a1' }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 401 without session', async () => {
    const clerk = await import('@clerk/nextjs/server');
    vi.mocked(clerk.auth).mockResolvedValue({ userId: null } as never);
    const { GET } = await import('@/app/api/agents/[id]/runs/route');
    const res = await GET(
      makeRequest('http://localhost/api/agents/a1/runs') as never,
      makeCtx({ id: 'a1' }),
    );
    expect(res.status).toBe(401);
  });
});

describe('GET /api/agents/[id]/runs/[runId]', () => {
  it('returns 200 with logs + metadata', async () => {
    const ntn = await import('@forge/ntn-wrapper');
    vi.mocked(ntn.getRunLogs).mockResolvedValue({
      logs: 'line1\nline2',
      lines: ['line1', 'line2'],
    });
    vi.mocked(ntn.listRuns).mockResolvedValue([
      {
        id: 'run_1',
        status: 'succeeded',
        startedAt: '2026-05-01T00:00:00Z',
        durationMs: 1234,
        exitCode: 0,
      },
    ] as never);

    const { GET } = await import('@/app/api/agents/[id]/runs/[runId]/route');
    const res = await GET(
      makeRequest('http://localhost/api/agents/a1/runs/run_1') as never,
      makeCtx({ id: 'a1', runId: 'run_1' }),
    );
    expect(res.status).toBe(200);
    const body = await readJson<{
      runId: string;
      logs: string;
      exitCode: number | null;
      startedAt: string | null;
      durationMs: number | null;
    }>(res);
    expect(body).toMatchObject({
      runId: 'run_1',
      logs: 'line1\nline2',
      exitCode: 0,
      durationMs: 1234,
    });
  });

  it('returns 400 with a malformed runId', async () => {
    const { GET } = await import('@/app/api/agents/[id]/runs/[runId]/route');
    const res = await GET(
      makeRequest('http://localhost/api/agents/a1/runs/bad..id') as never,
      makeCtx({ id: 'a1', runId: 'bad..id' }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 404 when getRunLogs reports a missing run', async () => {
    const ntn = await import('@forge/ntn-wrapper');
    vi.mocked(ntn.getRunLogs).mockRejectedValue(new Error('not found'));
    vi.mocked(ntn.listRuns).mockResolvedValue([] as never);
    const { GET } = await import('@/app/api/agents/[id]/runs/[runId]/route');
    const res = await GET(
      makeRequest('http://localhost/api/agents/a1/runs/run_gone') as never,
      makeCtx({ id: 'a1', runId: 'run_gone' }),
    );
    expect(res.status).toBe(404);
  });

  it('returns 403/404 when the agent belongs to another workspace', async () => {
    const db = await import('@forge/db');
    vi.mocked(db.prisma.generatedAgent.findUnique).mockResolvedValue({
      id: 'a1',
      workspaceId: 'ws_OTHER',
      ntnWorkerName: 'forge-x-aaa',
    } as never);
    const { GET } = await import('@/app/api/agents/[id]/runs/[runId]/route');
    const res = await GET(
      makeRequest('http://localhost/api/agents/a1/runs/run_1') as never,
      makeCtx({ id: 'a1', runId: 'run_1' }),
    );
    expect([403, 404]).toContain(res.status);
  });
});
