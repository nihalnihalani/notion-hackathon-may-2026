/**
 * Integration tests for the forge workflow body (`runForgeGeneration`).
 *
 * Every sub-agent is mocked at the module boundary via `vi.mock`. The test
 * verifies the orchestration contract — step ordering, retry behavior,
 * idempotency, cancellation, DB writes, Notion log calls — not the sub-agent
 * internals (those have their own tests in `packages/agents/test/`).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the four sub-agent entry points BEFORE importing the workflow body.
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

import { GenerationCancelledError, runForgeGeneration } from '../src/forge.js';
import type {
  GenerationRequestedEvent,
  WorkflowConfig,
  WorkflowDbHelpers,
  WorkflowNotionAdapter,
  WorkflowNtnAdapter,
  SandboxFactory,
} from '../src/types.js';

// ─── Fixture builders ─────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<GenerationRequestedEvent> = {}): GenerationRequestedEvent {
  return {
    generationId: 'gen_test_1',
    workspaceId: 'ws_test_1',
    notionWorkspaceId: 'notion_ws_1',
    userId: 'user_1',
    userEmail: 'user@example.com',
    description: 'Triage Linear bugs every morning',
    descriptionHash: 'a'.repeat(64),
    buildLogBlockId: 'block_buildlog' as never,
    notionRequestRowId: 'row_request_1',
    ...overrides,
  };
}

function makeSchemaSmithOutput(overrides: Partial<SchemaSmithOutput> = {}): SchemaSmithOutput {
  return {
    pattern: 'database-query',
    inputSchema: { kind: 'string', describe: 'query string' },
    outputSchema: { kind: 'string', describe: 'result' },
    requiredScopes: ['databases.read'],
    requiredOAuth: [],
    rationale: 'looks like a database query agent',
    ...overrides,
  };
}

function makeToolCoderOutput(overrides: Partial<ToolCoderOutput> = {}): ToolCoderOutput {
  return {
    source: 'export const worker = {};',
    sourceLines: 1,
    packageJsonPatch: { dependencies: {} },
    workerName: 'triage-linear-bugs',
    ...overrides,
  };
}

function makePassingInspection(): InspectionResult {
  return {
    pass: true,
    stage: 'exec',
    errors: [],
    durationMs: 1000,
  };
}

function makeFailingInspection(stage: InspectionResult['stage'] = 'tsc'): InspectionResult {
  return {
    pass: false,
    stage,
    errors: ['Type error: foo is not assignable to bar'],
    durationMs: 500,
  };
}

function makeShipperResult(overrides: Partial<ShipperResult> = {}): ShipperResult {
  return {
    generatedAgentId: 'generated_agent_1',
    customAgentId: 'agent_deployed_1',
    deployUrl: 'https://workers.notion.so/triage-linear-bugs',
    ntnWorkerName: 'triage-linear-bugs',
    artifactBlobUrl: 'https://blob.vercel.app/abc.ts',
    capabilitiesDiscovered: 1,
    ...overrides,
  };
}

interface MockHarness {
  config: WorkflowConfig;
  db: {
    findRecentByHash: ReturnType<typeof vi.fn>;
    updateGenerationStatus: ReturnType<typeof vi.fn>;
    recordStep: ReturnType<typeof vi.fn>;
    getWorkspaceContext: ReturnType<typeof vi.fn>;
    listExistingAgents: ReturnType<typeof vi.fn>;
  };
  notion: {
    appendBuildLogEntry: ReturnType<typeof vi.fn>;
    postClarificationComment: ReturnType<typeof vi.fn>;
  };
  sandbox: {
    create: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };
  recordedSteps: Array<{
    kind: 'start' | 'finish';
    agent?: string;
    status?: string;
    inputJson?: unknown;
    outputJson?: unknown;
  }>;
}

function makeHarness(opts: { force?: boolean; cacheHit?: boolean } = {}): MockHarness {
  const recordedSteps: MockHarness['recordedSteps'] = [];
  let stepCounter = 0;

  const recordStep = vi.fn().mockImplementation(async (input: unknown) => {
    const i = input as {
      kind: 'start' | 'finish';
      agent?: string;
      status?: string;
      inputJson?: unknown;
      outputJson?: unknown;
    };
    if (i.kind === 'start') {
      stepCounter++;
      const id = `step_${stepCounter}`;
      recordedSteps.push({
        kind: 'start',
        ...(i.agent !== undefined && { agent: i.agent }),
        ...(i.inputJson !== undefined && { inputJson: i.inputJson }),
      });
      return { id };
    }
    recordedSteps.push({
      kind: 'finish',
      ...(i.status !== undefined && { status: i.status }),
      ...(i.outputJson !== undefined && { outputJson: i.outputJson }),
    });
    return { id: 'whatever' };
  });

  const findRecentByHash = vi.fn().mockResolvedValue(
    opts.cacheHit
      ? {
          id: 'gen_cached_prior',
          workspaceId: 'ws_test_1',
          agentId: 'agent_cached',
          status: 'succeeded',
          completedAt: new Date(),
        }
      : null,
  );

  const updateGenerationStatus = vi.fn().mockResolvedValue({});
  const getWorkspaceContext = vi.fn().mockResolvedValue({
    workspaceId: 'ws_test_1',
    notionWorkspaceId: 'notion_ws_1',
    notionToken: 'secret_xxx',
    ownerUserId: 'user_1',
  });
  const listExistingAgents = vi.fn().mockResolvedValue([]);

  const db: WorkflowDbHelpers = {
    findRecentByHash,
    updateGenerationStatus,
    recordStep,
    getWorkspaceContext,
    listExistingAgents,
  };

  const appendBuildLogEntry = vi.fn().mockResolvedValue(undefined);
  const postClarificationComment = vi.fn().mockResolvedValue(undefined);

  const notion: WorkflowNotionAdapter = {
    config: { token: 'secret_xxx' },
    appendBuildLogEntry,
    postClarificationComment,
  };

  const ntn: WorkflowNtnAdapter = {
    listDatabases: vi.fn().mockResolvedValue([{ id: 'db1', name: 'Tasks', properties: [] }]),
  };

  const sandboxClose = vi.fn().mockResolvedValue(undefined);
  const sandboxInstance = {
    writeFiles: vi.fn(),
    run: vi.fn(),
    close: sandboxClose,
  };
  const sandboxFactory: SandboxFactory = {
    create: vi.fn().mockResolvedValue(sandboxInstance),
  };

  const config: WorkflowConfig = {
    subAgent: { anthropicApiKey: 'sk-ant-fake' },
    shipper: {
      dbClient: {
        generatedAgent: {
          findUnique: vi.fn(),
          create: vi.fn(),
          update: vi.fn(),
        },
      },
      notionClient: { token: 'secret_xxx' },
      vercelBlob: { token: 'vercel_blob_xxx' },
    },
    db,
    notion,
    ntn,
    sandbox: sandboxFactory,
  };

  return {
    config,
    db: {
      findRecentByHash,
      updateGenerationStatus,
      recordStep,
      getWorkspaceContext,
      listExistingAgents,
    },
    notion: { appendBuildLogEntry, postClarificationComment },
    sandbox: {
      create: sandboxFactory.create as ReturnType<typeof vi.fn>,
      close: sandboxClose,
    },
    recordedSteps,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.mocked(schemaSmith).mockReset();
  vi.mocked(toolCoder).mockReset();
  vi.mocked(inspector).mockReset();
  vi.mocked(shipper).mockReset();
});

describe('runForgeGeneration — happy path', () => {
  it('runs schema-smith → tool-coder → inspector(pass) → shipper → finalize in order', async () => {
    const harness = makeHarness();
    vi.mocked(schemaSmith).mockResolvedValue(makeSchemaSmithOutput());
    vi.mocked(toolCoder).mockResolvedValue(makeToolCoderOutput());
    vi.mocked(inspector).mockResolvedValue(makePassingInspection());
    vi.mocked(shipper).mockResolvedValue(makeShipperResult());

    const result = await runForgeGeneration(makeEvent(), harness.config);

    expect(result.status).toBe('succeeded');
    expect(result.cacheHit).toBe(false);
    expect(result.agentId).toBe('generated_agent_1');
    expect(result.generatedAgentId).toBe('generated_agent_1');
    expect(result.customAgentId).toBe('agent_deployed_1');
    expect(result.deployUrl).toBe('https://workers.notion.so/triage-linear-bugs');

    // Each sub-agent called exactly once on the happy path.
    expect(schemaSmith).toHaveBeenCalledTimes(1);
    expect(toolCoder).toHaveBeenCalledTimes(1);
    expect(inspector).toHaveBeenCalledTimes(1);
    expect(shipper).toHaveBeenCalledTimes(1);

    // GenerationStep rows persisted in canonical order.
    const startedAgents = harness.recordedSteps
      .filter((s) => s.kind === 'start')
      .map((s) => s.agent);
    expect(startedAgents).toEqual(['schema_smith', 'tool_coder', 'inspector', 'shipper']);

    // Generation marked running then succeeded.
    const statusCalls = harness.db.updateGenerationStatus.mock.calls.map((c) => c[1].status);
    expect(statusCalls).toContain('running');
    expect(statusCalls[statusCalls.length - 1]).toBe('succeeded');

    // Sandbox lifecycle: created + closed.
    expect(harness.sandbox.create).toHaveBeenCalledTimes(1);
    expect(harness.sandbox.close).toHaveBeenCalledTimes(1);
  });
});

describe('runForgeGeneration — Inspector retry loop', () => {
  it('feeds Inspector errors back to Tool Coder and passes on second attempt', async () => {
    const harness = makeHarness();
    vi.mocked(schemaSmith).mockResolvedValue(makeSchemaSmithOutput());
    vi.mocked(toolCoder).mockResolvedValue(makeToolCoderOutput());
    vi.mocked(inspector)
      .mockResolvedValueOnce(makeFailingInspection('tsc'))
      .mockResolvedValueOnce(makePassingInspection());
    vi.mocked(shipper).mockResolvedValue(makeShipperResult());

    const result = await runForgeGeneration(makeEvent(), harness.config);

    expect(result.status).toBe('succeeded');
    expect(toolCoder).toHaveBeenCalledTimes(2);
    expect(inspector).toHaveBeenCalledTimes(2);

    // Second tool-coder call carries prevErrors.
    const secondToolCoderInput = vi.mocked(toolCoder).mock.calls[1]?.[0];
    expect(secondToolCoderInput?.prevErrors).toEqual(['Type error: foo is not assignable to bar']);
  });

  it('marks generation failed after 2 Tool Coder attempts both Inspector-fail', async () => {
    const harness = makeHarness();
    vi.mocked(schemaSmith).mockResolvedValue(makeSchemaSmithOutput());
    vi.mocked(toolCoder).mockResolvedValue(makeToolCoderOutput());
    vi.mocked(inspector).mockResolvedValue(makeFailingInspection('exec'));

    await expect(runForgeGeneration(makeEvent(), harness.config)).rejects.toThrow(
      /Inspector failed after 2/,
    );

    expect(toolCoder).toHaveBeenCalledTimes(2);
    expect(inspector).toHaveBeenCalledTimes(2);
    expect(shipper).not.toHaveBeenCalled();

    // Generation marked failed (final status update).
    const lastUpdate = harness.db.updateGenerationStatus.mock.calls.at(-1);
    expect(lastUpdate?.[1].status).toBe('failed');
  });
});

describe('runForgeGeneration — Schema Smith clarification halt', () => {
  it('halts with status: needs_clarification when Schema Smith returns pattern: null', async () => {
    const harness = makeHarness();
    vi.mocked(schemaSmith).mockResolvedValue(
      makeSchemaSmithOutput({
        pattern: null,
        rationale: 'Which database do you mean by "the bugs list"?',
      }),
    );

    await expect(runForgeGeneration(makeEvent(), harness.config)).rejects.toThrow(
      /Schema Smith requested clarification/,
    );

    // Clarification comment posted to Notion row.
    expect(harness.notion.postClarificationComment).toHaveBeenCalledWith(
      'row_request_1',
      'Which database do you mean by "the bugs list"?',
    );
    // No downstream sub-agents called.
    expect(toolCoder).not.toHaveBeenCalled();
    expect(inspector).not.toHaveBeenCalled();
    expect(shipper).not.toHaveBeenCalled();
    // Sandbox never created.
    expect(harness.sandbox.create).not.toHaveBeenCalled();
    // Generation marked failed.
    const lastUpdate = harness.db.updateGenerationStatus.mock.calls.at(-1);
    expect(lastUpdate?.[1].status).toBe('failed');
  });
});

describe('runForgeGeneration — idempotency cache hit', () => {
  it('returns cached agent without calling any sub-agent', async () => {
    const harness = makeHarness({ cacheHit: true });

    const result = await runForgeGeneration(makeEvent(), harness.config);

    expect(result.status).toBe('cached');
    expect(result.cacheHit).toBe(true);
    expect(result.agentId).toBe('agent_cached');

    expect(schemaSmith).not.toHaveBeenCalled();
    expect(toolCoder).not.toHaveBeenCalled();
    expect(inspector).not.toHaveBeenCalled();
    expect(shipper).not.toHaveBeenCalled();

    // We mark the current generation succeeded with the cached agentId.
    const updateCall = harness.db.updateGenerationStatus.mock.calls[0];
    expect(updateCall?.[1].status).toBe('succeeded');
    expect(updateCall?.[1].agentId).toBe('agent_cached');
  });

  it('bypasses the cache when force: true', async () => {
    const harness = makeHarness({ cacheHit: true });
    vi.mocked(schemaSmith).mockResolvedValue(makeSchemaSmithOutput());
    vi.mocked(toolCoder).mockResolvedValue(makeToolCoderOutput());
    vi.mocked(inspector).mockResolvedValue(makePassingInspection());
    vi.mocked(shipper).mockResolvedValue(makeShipperResult());

    const result = await runForgeGeneration(makeEvent({ force: true }), harness.config);

    expect(result.status).toBe('succeeded');
    expect(result.cacheHit).toBe(false);
    expect(schemaSmith).toHaveBeenCalled();
  });
});

describe('runForgeGeneration — cancellation', () => {
  it('marks generation cancelled when abort signal fires before Schema Smith', async () => {
    const harness = makeHarness();
    const abortController = new AbortController();
    abortController.abort();
    harness.config.subAgent.abortSignal = abortController.signal;

    await expect(runForgeGeneration(makeEvent(), harness.config)).rejects.toBeInstanceOf(
      GenerationCancelledError,
    );

    // Generation marked cancelled.
    const lastUpdate = harness.db.updateGenerationStatus.mock.calls.at(-1);
    expect(lastUpdate?.[1].status).toBe('cancelled');
    // Schema Smith never called.
    expect(schemaSmith).not.toHaveBeenCalled();
  });
});

describe('runForgeGeneration — sandbox cleanup', () => {
  it('closes the sandbox even on Shipper failure', async () => {
    const harness = makeHarness();
    vi.mocked(schemaSmith).mockResolvedValue(makeSchemaSmithOutput());
    vi.mocked(toolCoder).mockResolvedValue(makeToolCoderOutput());
    vi.mocked(inspector).mockResolvedValue(makePassingInspection());
    vi.mocked(shipper).mockRejectedValue(new Error('blob upload failed'));

    await expect(runForgeGeneration(makeEvent(), harness.config)).rejects.toThrow(
      /blob upload failed/,
    );

    expect(harness.sandbox.create).toHaveBeenCalledTimes(1);
    expect(harness.sandbox.close).toHaveBeenCalledTimes(1);
  });
});
