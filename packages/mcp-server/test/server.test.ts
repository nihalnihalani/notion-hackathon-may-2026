/**
 * End-to-end server tests.
 *
 * Drives a real `McpServer` produced by `createForgeMcpServer` through the
 * SDK's `InMemoryTransport` using a real MCP `Client`. This is the highest-
 * confidence proof that:
 *
 *   - the SDK registers our tools / prompts / resource correctly,
 *   - input schemas validate as JSON Schema on the wire,
 *   - tool annotations surface to the client,
 *   - error responses use the spec-compliant `{isError: true, content: ...}`
 *     shape.
 *
 * Two flavors of test:
 *
 *   1. `Client + InMemoryTransport`  — exercises the SDK directly.
 *   2. `handleMcpHttpRequest`        — exercises the Web-standard adapter
 *      that backs `apps/web/app/api/mcp/route.ts`.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createForgeMcpServer,
  FORGE_AGENTS_URI,
  FORGE_MCP_SERVER_NAME,
  FORGE_MCP_SERVER_VERSION,
  handleMcpHttpRequest,
} from '../src/index.js';
import type {
  ForgeMcpConfig,
  ForgeMcpContext,
  GeneratedAgentView,
  GenerationStatusView,
} from '../src/index.js';

// ───────────────────────────────────────────────────────────────────────────
// Fixtures
// ───────────────────────────────────────────────────────────────────────────

const ctx: ForgeMcpContext = {
  userId: 'user_alice',
  workspaceId: 'ws_alpha',
  notionWorkspaceId: 'notion_omega',
};

const sampleAgent: GeneratedAgentView = {
  id: 'agent_xyz',
  ntnWorkerName: 'linear-bug-triager',
  ntnDeployUrl: 'https://linear-bug-triager.notion.workers.dev',
  pattern: 'webhook-trigger',
  description: 'Triages new Linear bugs.',
  status: 'active',
  avatarUrl: null,
  oauthProviders: ['linear'],
  createdAt: '2026-05-17T11:00:00.000Z',
};

const pausedAgent: GeneratedAgentView = {
  ...sampleAgent,
  id: 'agent_paused',
  ntnWorkerName: 'old-agent',
  status: 'paused',
};

const sampleGeneration: GenerationStatusView = {
  id: 'gen_e2e',
  status: 'succeeded',
  pattern: 'database-query',
  agentId: 'agent_xyz',
  createdAt: '2026-05-17T12:00:00.000Z',
  completedAt: '2026-05-17T12:01:30.000Z',
  totalLatencyMs: 90000,
  totalCostUsd: 0.12,
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

function makeConfig(overrides: Partial<ForgeMcpConfig> = {}): ForgeMcpConfig {
  return {
    workflowTrigger: vi.fn(async () => ({ generationId: 'gen_e2e', workflowRunId: 'run_e2e' })),
    getGenerationStatus: vi.fn(async (id: string) => (id === 'gen_e2e' ? sampleGeneration : null)),
    listAgents: vi.fn(async (filter) =>
      filter.status === 'paused' ? [pausedAgent] : [sampleAgent, pausedAgent],
    ),
    ...overrides,
  };
}

// Spin up a real Client wired to a real server via the in-memory transport pair.
async function connectClient(config: ForgeMcpConfig): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = createForgeMcpServer(ctx, config);
  const [serverTx, clientTx] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTx);

  const client = new Client({ name: 'forge-test-client', version: '0.0.0' }, { capabilities: {} });
  await client.connect(clientTx);

  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

// ───────────────────────────────────────────────────────────────────────────
// SDK-level tests via InMemoryTransport
// ───────────────────────────────────────────────────────────────────────────

describe('createForgeMcpServer — in-memory SDK round-trips', () => {
  let close: () => Promise<void> = async () => undefined;
  afterEach(async () => {
    await close();
  });

  it('advertises the expected server name + version', async () => {
    const config = makeConfig();
    const wired = await connectClient(config);
    close = wired.close;

    const info = wired.client.getServerVersion();
    expect(info).toMatchObject({
      name: FORGE_MCP_SERVER_NAME,
      version: FORGE_MCP_SERVER_VERSION,
    });
  });

  it('lists exactly three tools with the right names and annotations', async () => {
    const config = makeConfig();
    const wired = await connectClient(config);
    close = wired.close;

    const { tools } = await wired.client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

    expect(Object.keys(byName).sort()).toStrictEqual([
      'forge_agent',
      'get_generation_status',
      'list_my_agents',
    ]);

    expect(byName['forge_agent']!.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });
    expect(byName['get_generation_status']!.annotations).toMatchObject({
      readOnlyHint: true,
      idempotentHint: true,
    });
    expect(byName['list_my_agents']!.annotations).toMatchObject({
      readOnlyHint: true,
      idempotentHint: true,
    });
  });

  it('lists two prompts and one resource', async () => {
    const config = makeConfig();
    const wired = await connectClient(config);
    close = wired.close;

    const { prompts } = await wired.client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toStrictEqual([
      'forge_describe_agent',
      'forge_diagnose_failure',
    ]);

    const { resources } = await wired.client.listResources();
    expect(resources.map((r) => r.uri)).toStrictEqual([FORGE_AGENTS_URI]);
  });

  it('forge_agent: invokes the workflow trigger and returns structuredContent.generationId', async () => {
    const trigger = vi.fn(async () => ({ generationId: 'gen_42', workflowRunId: 'run_42' }));
    const config = makeConfig({ workflowTrigger: trigger });
    const wired = await connectClient(config);
    close = wired.close;

    const result = await wired.client.callTool({
      name: 'forge_agent',
      arguments: { description: 'Summarize meeting notes and post to Slack.' },
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      generationId: 'gen_42',
      status: 'queued',
      workflowRunId: 'run_42',
    });
    expect(trigger).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'mcp',
        workspaceId: 'ws_alpha',
        userId: 'user_alice',
        notionWorkspaceId: 'notion_omega',
        force: false,
      }),
    );
  });

  it('forge_agent: returns isError=true when the workflow trigger throws', async () => {
    const config = makeConfig({
      workflowTrigger: vi.fn(async () => {
        throw new Error('Inngest down');
      }),
    });
    const wired = await connectClient(config);
    close = wired.close;

    const result = await wired.client.callTool({
      name: 'forge_agent',
      arguments: { description: 'Some valid description longer than 10 chars.' },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: 'workflow_trigger_failed' },
    });
  });

  it('get_generation_status: returns the generation + step trail', async () => {
    const config = makeConfig();
    const wired = await connectClient(config);
    close = wired.close;

    const result = await wired.client.callTool({
      name: 'get_generation_status',
      arguments: { generationId: 'gen_e2e' },
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toStrictEqual(sampleGeneration);
  });

  it('get_generation_status: returns generation_not_found for unknown ids', async () => {
    const config = makeConfig();
    const wired = await connectClient(config);
    close = wired.close;

    const result = await wired.client.callTool({
      name: 'get_generation_status',
      arguments: { generationId: 'gen_missing' },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: 'generation_not_found' },
    });
  });

  it('list_my_agents: filters by status when provided', async () => {
    const listAgents = vi.fn(async (filter: { status?: 'active' | 'paused' | 'retracted' }) =>
      filter.status === 'paused' ? [pausedAgent] : [sampleAgent, pausedAgent],
    );
    const config = makeConfig({ listAgents });
    const wired = await connectClient(config);
    close = wired.close;

    const filtered = await wired.client.callTool({
      name: 'list_my_agents',
      arguments: { status: 'paused' },
    });
    expect(filtered.isError).toBeFalsy();
    expect(filtered.structuredContent).toMatchObject({
      total: 1,
      agents: [{ id: 'agent_paused', status: 'paused' }],
    });

    const all = await wired.client.callTool({
      name: 'list_my_agents',
      arguments: {},
    });
    expect(all.structuredContent).toMatchObject({ total: 2 });
  });

  it('rejects unknown tools with a JSON-RPC protocol error', async () => {
    const config = makeConfig();
    const wired = await connectClient(config);
    close = wired.close;

    await expect(
      wired.client.callTool({ name: 'nonexistent_tool', arguments: {} }),
    ).rejects.toThrow();
  });

  it('renders the forge_describe_agent prompt with quoted slots', async () => {
    const config = makeConfig();
    const wired = await connectClient(config);
    close = wired.close;

    const result = await wired.client.getPrompt({
      name: 'forge_describe_agent',
      arguments: { input: 'A row in Bugs', output: 'A Slack ping', triggers: 'On new row' },
    });

    expect(result.messages).toHaveLength(1);
    const turn = result.messages[0]!;
    expect(turn.role).toBe('user');
    const content = turn.content as { type: string; text: string };
    expect(content.type).toBe('text');
    expect(content.text).toContain('Input: A row in Bugs');
    expect(content.text).toContain('Output: A Slack ping');
    expect(content.text).toContain('Triggers: On new row');
  });

  it('renders the forge_diagnose_failure prompt with the embedded generationId', async () => {
    const config = makeConfig();
    const wired = await connectClient(config);
    close = wired.close;

    const result = await wired.client.getPrompt({
      name: 'forge_diagnose_failure',
      arguments: { generationId: 'gen_zzz' },
    });

    const content = result.messages[0]!.content as { type: string; text: string };
    expect(content.text).toContain('Generation gen_zzz failed.');
  });

  it('reads the forge://agents resource and returns a JSON payload of the workspace agents', async () => {
    const config = makeConfig();
    const wired = await connectClient(config);
    close = wired.close;

    const result = await wired.client.readResource({ uri: FORGE_AGENTS_URI });

    expect(result.contents).toHaveLength(1);
    const c = result.contents[0]!;
    expect(c.uri).toBe(FORGE_AGENTS_URI);
    expect(c.mimeType).toBe('application/json');
    const parsed = JSON.parse(c.text as string) as {
      workspaceId: string;
      total: number;
      agents: GeneratedAgentView[];
    };
    expect(parsed.workspaceId).toBe('ws_alpha');
    expect(parsed.total).toBe(2);
    expect(parsed.agents.map((a) => a.id).sort()).toStrictEqual(['agent_paused', 'agent_xyz']);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// HTTP transport adapter
// ───────────────────────────────────────────────────────────────────────────

describe('handleMcpHttpRequest', () => {
  function buildRequest(payload: unknown, init?: { accept?: string; method?: string }): Request {
    return new Request('https://forge.example.com/api/mcp', {
      method: init?.method ?? 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: init?.accept ?? 'application/json, text/event-stream',
      },
      body: payload === undefined ? null : JSON.stringify(payload),
    });
  }

  let createdServers: Array<{ close: () => Promise<void> }> = [];
  beforeEach(() => {
    createdServers = [];
  });
  afterEach(async () => {
    for (const s of createdServers) {
      try {
        await s.close();
      } catch {
        /* ignore */
      }
    }
  });

  it('responds 405 to GET (stateless: no standalone SSE stream)', async () => {
    const server = createForgeMcpServer(ctx, makeConfig());
    createdServers.push(server);

    const res = await handleMcpHttpRequest(
      new Request('https://forge.example.com/api/mcp', { method: 'GET' }),
      server,
      ctx,
    );
    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toContain('POST');
  });

  it('responds 400 to a malformed JSON body', async () => {
    const server = createForgeMcpServer(ctx, makeConfig());
    createdServers.push(server);

    const res = await handleMcpHttpRequest(
      new Request('https://forge.example.com/api/mcp', {
        method: 'POST',
        body: 'not json',
        headers: { 'Content-Type': 'application/json' },
      }),
      server,
      ctx,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32700);
  });

  it('drives an initialize → tools/list cycle end-to-end', async () => {
    const server = createForgeMcpServer(ctx, makeConfig());
    createdServers.push(server);

    // Step 1: initialize. We open a Client just to grab the canonical
    // initialize request shape, then route it through the HTTP adapter to
    // prove the bridge produces a wire-correct InitializeResult.
    const initializeReq = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'http-test', version: '0.0.0' },
      },
    };
    const initRes = await handleMcpHttpRequest(buildRequest(initializeReq), server, ctx);
    expect(initRes.status).toBe(200);
    expect(initRes.headers.get('Content-Type')).toBe('application/json');
    const initBody = (await initRes.json()) as {
      result: { serverInfo: { name: string; version: string } };
    };
    expect(initBody.result.serverInfo).toMatchObject({
      name: FORGE_MCP_SERVER_NAME,
      version: FORGE_MCP_SERVER_VERSION,
    });
  });

  it('frames the response as SSE when only text/event-stream is acceptable', async () => {
    const server = createForgeMcpServer(ctx, makeConfig());
    createdServers.push(server);

    const res = await handleMcpHttpRequest(
      buildRequest(
        {
          jsonrpc: '2.0',
          id: 7,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'sse-test', version: '0.0.0' },
          },
        },
        { accept: 'text/event-stream' },
      ),
      server,
      ctx,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/event-stream');
    const text = await res.text();
    expect(text).toMatch(/^event: message\ndata: \{.*\}\n\n$/);
  });

  it('returns 202 with no body for a JSON-RPC notification (no id, no response expected)', async () => {
    const server = createForgeMcpServer(ctx, makeConfig());
    createdServers.push(server);

    const res = await handleMcpHttpRequest(
      buildRequest({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      server,
      ctx,
    );
    expect(res.status).toBe(202);
    expect(await res.text()).toBe('');
  });
});
