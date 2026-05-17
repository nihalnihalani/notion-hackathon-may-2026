/**
 * Tests for the Inngest backup variant.
 *
 * We don't pull in the real `inngest` package — instead we drive
 * `runForgeOnInngest` directly with a hand-rolled InngestHandlerContext whose
 * `step.run(id, fn)` just calls `fn()` synchronously. That mirrors how Inngest
 * behaves on a fresh first-run (no checkpoints to replay) and lets us assert
 * the step-ID contract without booting the framework.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@forge/agents', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    schemaSmith: vi.fn(),
    toolCoder: vi.fn(),
    inspector: vi.fn(),
    shipper: vi.fn(),
  };
});

import {
  inspector,
  schemaSmith,
  shipper,
  toolCoder,
  type InspectionResult,
  type SchemaSmithOutput,
  type ShipperResult,
  type ToolCoderOutput,
} from '@forge/agents';

import {
  createForgeInngestFunctions,
  runForgeOnInngest,
  type InngestClientLike,
  type InngestHandlerContext,
} from '../../src/inngest/forge.js';
import type {
  GenerationRequestedEvent,
  SandboxFactory,
  WorkflowConfig,
  WorkflowDbHelpers,
  WorkflowNotionAdapter,
  WorkflowNtnAdapter,
} from '../../src/types.js';

// ─── Builders (shared with forge.test.ts shape) ──────────────────────────────

function makeEvent(
  overrides: Partial<GenerationRequestedEvent> = {},
): GenerationRequestedEvent {
  return {
    generationId: 'gen_ing_1',
    workspaceId: 'ws_ing_1',
    notionWorkspaceId: 'notion_ws_1',
    userId: 'user_1',
    userEmail: 'u@example.com',
    description: 'Sync github issues to a database',
    descriptionHash: 'b'.repeat(64),
    buildLogBlockId: 'block_log' as never,
    notionRequestRowId: 'row_1',
    ...overrides,
  };
}

function makeSchemaSmithOutput(
  overrides: Partial<SchemaSmithOutput> = {},
): SchemaSmithOutput {
  return {
    pattern: 'sync-source',
    inputSchema: { kind: 'object', describe: 'cfg', properties: {} },
    outputSchema: { kind: 'string', describe: 'r' },
    requiredScopes: ['databases.write'],
    requiredOAuth: ['github'],
    rationale: 'fits sync-source',
    ...overrides,
  };
}

function makeToolCoderOutput(): ToolCoderOutput {
  return {
    source: 'export const w = {};',
    sourceLines: 1,
    packageJsonPatch: { dependencies: {} },
    workerName: 'gh-issue-sync',
  };
}

function makePassingInspection(): InspectionResult {
  return { pass: true, stage: 'exec', errors: [], durationMs: 200 };
}

function makeFailingInspection(): InspectionResult {
  return { pass: false, stage: 'tsc', errors: ['ts err'], durationMs: 100 };
}

function makeShipperResult(): ShipperResult {
  return {
    customAgentId: 'ca_1',
    deployUrl: 'https://u/d',
    ntnWorkerName: 'gh-issue-sync',
    artifactBlobUrl: 'https://blob/a',
    capabilitiesDiscovered: 2,
  };
}

interface Harness {
  config: WorkflowConfig;
  ctx: InngestHandlerContext;
  stepIds: string[];
  db: {
    updateGenerationStatus: ReturnType<typeof vi.fn>;
    findRecentByHash: ReturnType<typeof vi.fn>;
    recordStep: ReturnType<typeof vi.fn>;
  };
  sandbox: { create: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
}

function makeHarness(opts: { cacheHit?: boolean } = {}): Harness {
  const stepIds: string[] = [];

  const ctx: InngestHandlerContext = {
    event: { name: 'forge/generation.requested', data: makeEvent() },
    step: {
      run: vi.fn(async (id: string, fn: () => Promise<unknown>) => {
        stepIds.push(id);
        return fn();
      }),
      sleep: vi.fn().mockResolvedValue(undefined),
      waitForEvent: vi.fn().mockResolvedValue(null),
    },
  };

  const findRecentByHash = vi.fn().mockResolvedValue(
    opts.cacheHit
      ? {
          id: 'gen_cached',
          workspaceId: 'ws_ing_1',
          agentId: 'agent_cached_ing',
          status: 'succeeded',
          completedAt: new Date(),
        }
      : null,
  );
  const updateGenerationStatus = vi.fn().mockResolvedValue({});
  let counter = 0;
  const recordStep = vi.fn().mockImplementation(async (input: unknown) => {
    counter++;
    return { id: `s_${counter}` };
  });

  const db: WorkflowDbHelpers = {
    findRecentByHash,
    updateGenerationStatus,
    recordStep,
    getWorkspaceContext: vi.fn().mockResolvedValue({
      workspaceId: 'ws_ing_1',
      notionWorkspaceId: 'notion_ws_1',
      notionToken: 't',
      ownerUserId: 'user_1',
    }),
    listExistingAgents: vi.fn().mockResolvedValue([]),
  };

  const notion: WorkflowNotionAdapter = {
    config: { token: 't' },
    appendBuildLogEntry: vi.fn().mockResolvedValue(undefined),
    postClarificationComment: vi.fn().mockResolvedValue(undefined),
  };

  const ntn: WorkflowNtnAdapter = {
    listDatabases: vi.fn().mockResolvedValue([]),
  };

  const sandboxClose = vi.fn().mockResolvedValue(undefined);
  const sandboxFactory: SandboxFactory = {
    create: vi.fn().mockResolvedValue({
      writeFiles: vi.fn(),
      run: vi.fn(),
      close: sandboxClose,
    }),
  };

  const config: WorkflowConfig = {
    subAgent: { anthropicApiKey: 'sk' },
    shipper: {
      dbClient: {
        generatedAgent: {
          findUnique: vi.fn(),
          create: vi.fn(),
          update: vi.fn(),
        },
      },
      notionClient: { token: 't' },
      vercelBlob: { token: 'vbt' },
    },
    db,
    notion,
    ntn,
    sandbox: sandboxFactory,
  };

  return {
    config,
    ctx,
    stepIds,
    db: { updateGenerationStatus, findRecentByHash, recordStep },
    sandbox: {
      create: sandboxFactory.create as ReturnType<typeof vi.fn>,
      close: sandboxClose,
    },
  };
}

beforeEach(() => {
  vi.mocked(schemaSmith).mockReset();
  vi.mocked(toolCoder).mockReset();
  vi.mocked(inspector).mockReset();
  vi.mocked(shipper).mockReset();
});

// ─── runForgeOnInngest tests ─────────────────────────────────────────────────

describe('runForgeOnInngest — step ID contract', () => {
  it('emits deterministic, attempt-encoded step ids on the happy path', async () => {
    const h = makeHarness();
    vi.mocked(schemaSmith).mockResolvedValue(makeSchemaSmithOutput());
    vi.mocked(toolCoder).mockResolvedValue(makeToolCoderOutput());
    vi.mocked(inspector).mockResolvedValue(makePassingInspection());
    vi.mocked(shipper).mockResolvedValue(makeShipperResult());

    const result = await runForgeOnInngest({
      event: makeEvent(),
      ctx: h.ctx,
      config: h.config,
    });

    expect(result.status).toBe('succeeded');
    expect(h.stepIds).toEqual([
      'idempotency-check',
      'mark-running',
      'discover-context',
      'schema-smith',
      'sandbox-create',
      'tool-coder-1',
      'inspector-1',
      'shipper',
      'finalize',
    ]);
  });

  it('encodes attempt count in retry step ids', async () => {
    const h = makeHarness();
    vi.mocked(schemaSmith).mockResolvedValue(makeSchemaSmithOutput());
    vi.mocked(toolCoder).mockResolvedValue(makeToolCoderOutput());
    vi.mocked(inspector)
      .mockResolvedValueOnce(makeFailingInspection())
      .mockResolvedValueOnce(makePassingInspection());
    vi.mocked(shipper).mockResolvedValue(makeShipperResult());

    await runForgeOnInngest({
      event: makeEvent(),
      ctx: h.ctx,
      config: h.config,
    });

    expect(h.stepIds).toContain('tool-coder-1');
    expect(h.stepIds).toContain('tool-coder-2');
    expect(h.stepIds).toContain('inspector-1');
    expect(h.stepIds).toContain('inspector-2');
  });
});

describe('runForgeOnInngest — idempotency', () => {
  it('short-circuits on cache hit with cache-hit-finalize step', async () => {
    const h = makeHarness({ cacheHit: true });
    const result = await runForgeOnInngest({
      event: makeEvent(),
      ctx: h.ctx,
      config: h.config,
    });
    expect(result.status).toBe('cached');
    expect(h.stepIds).toEqual(['idempotency-check', 'cache-hit-finalize']);
    expect(schemaSmith).not.toHaveBeenCalled();
  });
});

describe('runForgeOnInngest — clarification halt', () => {
  it('throws NeedsClarification, marks failed, posts comment', async () => {
    const h = makeHarness();
    vi.mocked(schemaSmith).mockResolvedValue(
      makeSchemaSmithOutput({ pattern: null, rationale: 'which db?' }),
    );

    await expect(
      runForgeOnInngest({
        event: makeEvent(),
        ctx: h.ctx,
        config: h.config,
      }),
    ).rejects.toThrow(/clarification/);

    expect(h.stepIds).toContain('post-clarification');
    expect(toolCoder).not.toHaveBeenCalled();
    expect(h.db.updateGenerationStatus.mock.calls.at(-1)?.[1].status).toBe(
      'failed',
    );
  });
});

describe('runForgeOnInngest — sandbox cleanup', () => {
  it('closes the sandbox on Inspector retry exhaustion', async () => {
    const h = makeHarness();
    vi.mocked(schemaSmith).mockResolvedValue(makeSchemaSmithOutput());
    vi.mocked(toolCoder).mockResolvedValue(makeToolCoderOutput());
    vi.mocked(inspector).mockResolvedValue(makeFailingInspection());

    await expect(
      runForgeOnInngest({
        event: makeEvent(),
        ctx: h.ctx,
        config: h.config,
      }),
    ).rejects.toThrow(/Inspector failed after 2/);

    expect(h.sandbox.close).toHaveBeenCalledTimes(1);
  });
});

// ─── createForgeInngestFunctions feature-flag tests ──────────────────────────

describe('createForgeInngestFunctions', () => {
  it('returns null when feature flag is off', () => {
    const inngest: InngestClientLike = {
      createFunction: vi.fn(),
      send: vi.fn(),
    };
    const h = makeHarness();
    const result = createForgeInngestFunctions({
      inngest,
      config: h.config,
      enabled: false,
    });
    expect(result).toBeNull();
    expect(inngest.createFunction).not.toHaveBeenCalled();
  });

  it('registers two functions (generation + onCancel) when enabled', () => {
    const inngest: InngestClientLike = {
      createFunction: vi.fn().mockImplementation((opts) => ({ id: opts.id })),
      send: vi.fn(),
    };
    const h = makeHarness();
    const result = createForgeInngestFunctions({
      inngest,
      config: h.config,
      enabled: true,
    });

    expect(result).not.toBeNull();
    expect(result?.generation).toBeDefined();
    expect(result?.onCancel).toBeDefined();
    expect(inngest.createFunction).toHaveBeenCalledTimes(2);

    // First function: main generation with concurrency + cancelOn.
    const firstCall = vi.mocked(inngest.createFunction).mock.calls[0];
    const firstOpts = firstCall?.[0] as {
      id: string;
      concurrency: { key: string; limit: number };
      cancelOn: { event: string; match: string }[];
    };
    expect(firstOpts.id).toBe('forge-generation');
    expect(firstOpts.concurrency).toEqual({
      key: 'event.data.workspaceId',
      limit: 3,
    });
    expect(firstOpts.cancelOn[0]?.event).toBe('forge/generation.cancelled');
  });

  it('respects FORGE_USE_INNGEST=true env var', () => {
    const prior = process.env['FORGE_USE_INNGEST'];
    process.env['FORGE_USE_INNGEST'] = 'true';
    try {
      const inngest: InngestClientLike = {
        createFunction: vi.fn().mockImplementation((opts) => opts),
        send: vi.fn(),
      };
      const h = makeHarness();
      const result = createForgeInngestFunctions({ inngest, config: h.config });
      expect(result).not.toBeNull();
    } finally {
      if (prior === undefined) {
        delete process.env['FORGE_USE_INNGEST'];
      } else {
        process.env['FORGE_USE_INNGEST'] = prior;
      }
    }
  });

  it('defaults to off when FORGE_USE_INNGEST env var is missing', () => {
    const prior = process.env['FORGE_USE_INNGEST'];
    delete process.env['FORGE_USE_INNGEST'];
    try {
      const inngest: InngestClientLike = {
        createFunction: vi.fn(),
        send: vi.fn(),
      };
      const h = makeHarness();
      const result = createForgeInngestFunctions({ inngest, config: h.config });
      expect(result).toBeNull();
    } finally {
      if (prior !== undefined) process.env['FORGE_USE_INNGEST'] = prior;
    }
  });
});
