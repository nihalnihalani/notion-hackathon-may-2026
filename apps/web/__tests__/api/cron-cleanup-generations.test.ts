/**
 * /api/cron/cleanup-generations — stale-generation reaper cron.
 *
 *   - 401 when Authorization header is missing
 *   - 401 when Authorization header carries the wrong secret
 *   - 503 when CRON_SECRET env var is unset (deploy misconfigured)
 *   - 200 { reaped: 0 } when no stale rows exist
 *   - 200 { reaped: N } when N stale rows are present
 *   - each reaped row gets status='failed' + a synthetic step with the
 *     expected `errorJson.kind`
 *   - PostHog captureEvent is called once per reaped row
 *   - opsMetrics.publishGenerationEvent is called when env is wired
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeCtx, makeRequest, readJson, stubSentryWrapper } from './_helpers';

stubSentryWrapper();

vi.mock('@forge/db', () => ({
  prisma: {
    generation: { updateMany: vi.fn() },
    generationStep: { create: vi.fn() },
  },
  findStaleGenerations: vi.fn(),
}));

const opsPublishMock = vi.fn();
const createOpsMetricsAdapterFromEnvMock = vi.fn(() => ({
  publishGenerationEvent: opsPublishMock,
}));
vi.mock('@forge/workflows', () => ({
  createOpsMetricsAdapterFromEnv: (...args: unknown[]) =>
    createOpsMetricsAdapterFromEnvMock(...(args as [])),
}));

const captureEventMock = vi.fn();
const flushEventsMock = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/posthog-server', () => ({
  captureEvent: (...args: unknown[]) => captureEventMock(...args),
  flushEvents: () => flushEventsMock(),
}));

const GOOD_SECRET = 'super-secret-cron-token';

function authedRequest(): Request {
  return makeRequest('http://localhost/api/cron/cleanup-generations', {
    method: 'GET',
    headers: { authorization: `Bearer ${GOOD_SECRET}` },
  });
}

interface CronOkBody {
  ok: true;
  reaped: number;
  scanned: number;
  durationMs: number;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.resetModules();
  process.env['CRON_SECRET'] = GOOD_SECRET;
  // resetAllMocks wipes the implementation too — re-attach the adapter
  // factory so every test starts with ops-metrics wired.
  createOpsMetricsAdapterFromEnvMock.mockImplementation(() => ({
    publishGenerationEvent: opsPublishMock,
  }));
  // Default: no stale rows. Each test overrides as needed.
  flushEventsMock.mockResolvedValue(undefined);
});

describe('GET /api/cron/cleanup-generations', () => {
  it('returns 401 when Authorization header is missing', async () => {
    const { GET } = await import('@/app/api/cron/cleanup-generations/route');
    const res = await GET(
      makeRequest('http://localhost/api/cron/cleanup-generations', {
        method: 'GET',
      }) as never,
      makeCtx({}),
    );
    expect(res.status).toBe(401);
  });

  it('returns 401 when Authorization header has the wrong secret', async () => {
    const { GET } = await import('@/app/api/cron/cleanup-generations/route');
    const res = await GET(
      makeRequest('http://localhost/api/cron/cleanup-generations', {
        method: 'GET',
        headers: { authorization: 'Bearer not-the-secret' },
      }) as never,
      makeCtx({}),
    );
    expect(res.status).toBe(401);
  });

  it('returns 503 when CRON_SECRET env var is unset', async () => {
    delete process.env['CRON_SECRET'];
    const { GET } = await import('@/app/api/cron/cleanup-generations/route');
    const res = await GET(authedRequest() as never, makeCtx({}));
    expect(res.status).toBe(503);
  });

  it('returns 200 with reaped: 0 when no stale rows are present', async () => {
    const db = await import('@forge/db');
    vi.mocked(db.findStaleGenerations).mockResolvedValue([]);

    const { GET } = await import('@/app/api/cron/cleanup-generations/route');
    const res = await GET(authedRequest() as never, makeCtx({}));
    expect(res.status).toBe(200);
    const body = await readJson<CronOkBody>(res);
    expect(body.ok).toBe(true);
    expect(body.reaped).toBe(0);
    expect(body.scanned).toBe(0);
    expect(typeof body.durationMs).toBe('number');
    expect(captureEventMock).not.toHaveBeenCalled();
    expect(opsPublishMock).not.toHaveBeenCalled();
  });

  it('reaps every stale row and writes the expected errorJson', async () => {
    const db = await import('@forge/db');
    const now = Date.now();
    const stale = [
      {
        id: 'gen_a',
        workspaceId: 'ws_1',
        userId: 'u_1',
        notionRowId: null,
        description: 'triage linear bugs',
        descriptionHash: 'h1',
        status: 'running' as const,
        pattern: 'external_api_call' as const,
        agentId: null,
        startedAt: new Date(now - 45 * 60 * 1000),
        completedAt: null,
        totalLatencyMs: null,
        totalCostUsd: null,
      },
      {
        id: 'gen_b',
        workspaceId: 'ws_2',
        userId: 'u_2',
        notionRowId: null,
        description: 'daily digest',
        descriptionHash: 'h2',
        status: 'queued' as const,
        pattern: null,
        agentId: null,
        startedAt: new Date(now - 35 * 60 * 1000),
        completedAt: null,
        totalLatencyMs: null,
        totalCostUsd: null,
      },
    ];
    vi.mocked(db.findStaleGenerations).mockResolvedValue(stale as never);
    vi.mocked(db.prisma.generation.updateMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(db.prisma.generationStep.create).mockResolvedValue({} as never);

    const { GET } = await import('@/app/api/cron/cleanup-generations/route');
    const res = await GET(authedRequest() as never, makeCtx({}));
    expect(res.status).toBe(200);
    const body = await readJson<CronOkBody>(res);
    expect(body.reaped).toBe(2);
    expect(body.scanned).toBe(2);

    // updateMany was called once per row, scoped to id + non-terminal status.
    expect(db.prisma.generation.updateMany).toHaveBeenCalledTimes(2);
    const firstUpdate = vi.mocked(db.prisma.generation.updateMany).mock.calls[0]?.[0];
    expect(firstUpdate?.where).toMatchObject({
      id: 'gen_a',
      status: { in: ['queued', 'running'] },
    });
    expect(firstUpdate?.data).toMatchObject({ status: 'failed' });
    expect(typeof (firstUpdate?.data as { totalLatencyMs: number }).totalLatencyMs).toBe('number');

    // Synthetic step trail written for each reaping with the canonical kind.
    expect(db.prisma.generationStep.create).toHaveBeenCalledTimes(2);
    const firstStep = vi.mocked(db.prisma.generationStep.create).mock.calls[0]?.[0];
    expect(firstStep?.data).toMatchObject({
      generationId: 'gen_a',
      status: 'failed',
      agent: 'inspector',
    });
    expect((firstStep?.data as { errorJson: { kind: string } }).errorJson.kind).toBe(
      'stale_generation_reaped',
    );

    // PostHog: one event per reaped row.
    expect(captureEventMock).toHaveBeenCalledTimes(2);
    const phCall = captureEventMock.mock.calls[0]?.[0] as {
      event: string;
      properties: { generationId: string; ageMs: number };
    };
    expect(phCall.event).toBe('forge.cron.stale_generation_reaped');
    expect(phCall.properties.generationId).toBe('gen_a');
    expect(typeof phCall.properties.ageMs).toBe('number');
    expect(phCall.properties.ageMs).toBeGreaterThan(30 * 60 * 1000);

    // OpsMetrics: one publish per reaped row when adapter is wired.
    expect(opsPublishMock).toHaveBeenCalledTimes(2);
    expect(opsPublishMock).toHaveBeenCalledWith(
      expect.objectContaining({
        generationId: 'gen_a',
        status: 'failed',
        errorMessage: expect.stringContaining('reaped'),
      }),
    );

    // Queue drained before the response resolves.
    expect(flushEventsMock).toHaveBeenCalledOnce();
  });

  it('does not count or emit for rows that lost the update race (count: 0)', async () => {
    const db = await import('@forge/db');
    const now = Date.now();
    vi.mocked(db.findStaleGenerations).mockResolvedValue([
      {
        id: 'gen_a',
        workspaceId: 'ws_1',
        userId: 'u_1',
        notionRowId: null,
        description: 'd',
        descriptionHash: 'h',
        status: 'running',
        pattern: null,
        agentId: null,
        startedAt: new Date(now - 40 * 60 * 1000),
        completedAt: null,
        totalLatencyMs: null,
        totalCostUsd: null,
      },
    ] as never);
    // Another worker already reaped this row — our UPDATE matches zero rows.
    vi.mocked(db.prisma.generation.updateMany).mockResolvedValue({ count: 0 } as never);

    const { GET } = await import('@/app/api/cron/cleanup-generations/route');
    const res = await GET(authedRequest() as never, makeCtx({}));
    expect(res.status).toBe(200);
    const body = await readJson<CronOkBody>(res);
    expect(body.reaped).toBe(0);
    expect(body.scanned).toBe(1);
    expect(captureEventMock).not.toHaveBeenCalled();
    expect(opsPublishMock).not.toHaveBeenCalled();
    expect(db.prisma.generationStep.create).not.toHaveBeenCalled();
  });
});
