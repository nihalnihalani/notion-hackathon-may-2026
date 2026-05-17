/**
 * Unit tests for the pure tool handlers in `src/tools.ts`.
 *
 * These exercise the handlers directly (no MCP transport, no SDK) so
 * failures point straight at the handler logic rather than serialization.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  forgeAgent,
  getGenerationStatus,
  listMyAgents,
} from '../src/tools.js';
import type {
  ForgeMcpConfig,
  ForgeMcpContext,
  GeneratedAgentView,
  GenerationStatusView,
} from '../src/types.js';

const ctx: ForgeMcpContext = {
  userId: 'user_123',
  workspaceId: 'ws_abc',
  notionWorkspaceId: 'notion_xyz',
};

function makeConfig(overrides: Partial<ForgeMcpConfig> = {}): ForgeMcpConfig {
  return {
    workflowTrigger: vi.fn(async () => ({ generationId: 'gen_1', workflowRunId: 'run_1' })),
    getGenerationStatus: vi.fn(async () => null),
    listAgents: vi.fn(async () => []),
    ...overrides,
  };
}

function assertSuccess<T>(
  result: { isError?: unknown; structuredContent: T },
): asserts result is { structuredContent: T; content: ReadonlyArray<{ type: 'text'; text: string }> } {
  if ((result as { isError?: unknown }).isError === true) {
    throw new Error(
      `Expected success but got error: ${JSON.stringify((result as { structuredContent: unknown }).structuredContent)}`,
    );
  }
}

describe('forgeAgent', () => {
  it('forwards the description + force flag to the workflow trigger and returns its generationId', async () => {
    const trigger = vi.fn(async () => ({ generationId: 'gen_42', workflowRunId: 'run_42' }));
    const config = makeConfig({ workflowTrigger: trigger });

    const result = await forgeAgent(
      {
        description: 'Triage every new Linear bug by severity and ping #oncall.',
        force: true,
      },
      ctx,
      config,
    );

    assertSuccess(result);
    expect(result.structuredContent).toStrictEqual({
      generationId: 'gen_42',
      status: 'queued',
      workflowRunId: 'run_42',
    });
    expect(trigger).toHaveBeenCalledWith({
      userId: 'user_123',
      workspaceId: 'ws_abc',
      notionWorkspaceId: 'notion_xyz',
      description: 'Triage every new Linear bug by severity and ping #oncall.',
      force: true,
      source: 'mcp',
    });
  });

  it('defaults `force` to false when omitted', async () => {
    const trigger = vi.fn(async () => ({ generationId: 'gen_1' }));
    const config = makeConfig({ workflowTrigger: trigger });

    await forgeAgent(
      { description: 'Some valid description longer than 10 chars.' },
      ctx,
      config,
    );

    expect(trigger).toHaveBeenCalledWith(expect.objectContaining({ force: false }));
  });

  it('returns workflowRunId=null when the trigger omits it', async () => {
    const config = makeConfig({
      workflowTrigger: vi.fn(async () => ({ generationId: 'gen_no_run' })),
    });

    const result = await forgeAgent(
      { description: 'Some valid description longer than 10 chars.' },
      ctx,
      config,
    );

    assertSuccess(result);
    expect(result.structuredContent.workflowRunId).toBeNull();
  });

  it('returns an MCP error block when the workflow trigger throws', async () => {
    const cause = new Error('Inngest is down');
    const config = makeConfig({
      workflowTrigger: vi.fn(async () => {
        throw cause;
      }),
    });

    const result = await forgeAgent(
      { description: 'Some valid description longer than 10 chars.' },
      ctx,
      config,
    );

    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        error: { code: 'workflow_trigger_failed' },
      },
    });
  });
});

describe('getGenerationStatus', () => {
  const sampleGeneration: GenerationStatusView = {
    id: 'gen_1',
    status: 'running',
    pattern: 'database-query',
    agentId: null,
    createdAt: '2026-05-17T12:00:00.000Z',
    completedAt: null,
    totalLatencyMs: null,
    totalCostUsd: null,
    steps: [
      {
        id: 'step_1',
        agent: 'schema-smith',
        attempt: 1,
        status: 'succeeded',
        modelUsed: 'claude-opus-4-7',
        startedAt: '2026-05-17T12:00:01.000Z',
        completedAt: '2026-05-17T12:00:05.000Z',
        latencyMs: 4000,
        costUsd: 0.04,
        errorJson: null,
      },
    ],
  };

  it('returns the projection unchanged when the row exists', async () => {
    const config = makeConfig({
      getGenerationStatus: vi.fn(async () => sampleGeneration),
    });

    const result = await getGenerationStatus({ generationId: 'gen_1' }, ctx, config);

    assertSuccess(result);
    expect(result.structuredContent).toStrictEqual(sampleGeneration);
  });

  it('returns `generation_not_found` when the row is null (also covers cross-workspace lookups)', async () => {
    const config = makeConfig({
      getGenerationStatus: vi.fn(async () => null),
    });

    const result = await getGenerationStatus({ generationId: 'gen_missing' }, ctx, config);

    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: 'generation_not_found',
          metadata: { generationId: 'gen_missing' },
        },
      },
    });
  });

  it('wraps unexpected throws as ForgeMcpError', async () => {
    const config = makeConfig({
      getGenerationStatus: vi.fn(async () => {
        throw new Error('DB unreachable');
      }),
    });

    const result = await getGenerationStatus({ generationId: 'gen_1' }, ctx, config);

    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        error: { code: 'internal_error', message: 'DB unreachable' },
      },
    });
  });
});

describe('listMyAgents', () => {
  const sample: GeneratedAgentView = {
    id: 'agent_1',
    ntnWorkerName: 'linear-bug-triager',
    ntnDeployUrl: 'https://linear-bug-triager.notion.workers.dev',
    pattern: 'webhook-trigger',
    description: 'Triages new Linear bugs.',
    status: 'active',
    avatarUrl: null,
    oauthProviders: ['linear', 'slack'],
    createdAt: '2026-05-17T11:00:00.000Z',
  };

  it('passes through the workspace-scoped rows with `total`', async () => {
    const config = makeConfig({
      listAgents: vi.fn(async () => [sample]),
    });

    const result = await listMyAgents({}, ctx, config);

    assertSuccess(result);
    expect(result.structuredContent.total).toBe(1);
    expect(result.structuredContent.agents).toStrictEqual([sample]);
  });

  it('forwards the status filter when provided', async () => {
    const listAgents = vi.fn(async () => [sample]);
    const config = makeConfig({ listAgents });

    await listMyAgents({ status: 'paused' }, ctx, config);

    expect(listAgents).toHaveBeenCalledWith({ status: 'paused' }, ctx);
  });

  it('omits the status filter when none is provided', async () => {
    const listAgents = vi.fn(async () => [sample]);
    const config = makeConfig({ listAgents });

    await listMyAgents({}, ctx, config);

    expect(listAgents).toHaveBeenCalledWith({}, ctx);
  });

  it('defensively strips retracted rows even if a future repo regresses', async () => {
    const retracted: GeneratedAgentView = { ...sample, id: 'agent_x', status: 'retracted' };
    const config = makeConfig({
      listAgents: vi.fn(async () => [sample, retracted]),
    });

    const result = await listMyAgents({}, ctx, config);
    assertSuccess(result);
    expect(result.structuredContent.total).toBe(1);
    expect(result.structuredContent.agents).toStrictEqual([sample]);
  });

  it('returns an MCP error block when the underlying listAgents throws', async () => {
    const config = makeConfig({
      listAgents: vi.fn(async () => {
        throw new Error('boom');
      }),
    });

    const result = await listMyAgents({}, ctx, config);

    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        error: { code: 'agent_list_failed' },
      },
    });
  });
});
