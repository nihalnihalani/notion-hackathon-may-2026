/**
 * Tool Coder unit tests.
 *
 * Anthropic + OpenAI clients are injected via SubAgentConfig — no fetch
 * interception. Mirrors the Schema Smith test style.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RateLimitError } from '@forge/connectors';
import { toolCoder } from '../src/tool-coder.js';
import { ToolCoderError, ProviderFallbackError } from '../src/errors.js';
import type { AnthropicClientLike, OpenaiClientLike, SchemaSmithOutput } from '../src/types.js';

const SAMPLE_SCHEMA: SchemaSmithOutput = {
  pattern: 'database-query',
  inputSchema: {
    kind: 'object',
    describe: 'Input',
    properties: { q: { kind: 'string', describe: 'query' } },
    required: ['q'],
  },
  outputSchema: {
    kind: 'object',
    describe: 'Output',
    properties: { ok: { kind: 'boolean', describe: 'ok' } },
    required: ['ok'],
  },
  requiredScopes: ['databases.read'],
  requiredOAuth: [],
  rationale: 'List pages from a Notion database.',
};

const VALID_TS = `
import { worker, j } from '@notion/workers-sdk';
import { Client as NotionClient } from '@notionhq/client';

const notion = new NotionClient({ auth: process.env['NOTION_API_KEY'] ?? '' });

worker.tool({
  name: 'sample',
  description: 'sample',
  input: j.object({ q: j.string().describe('query') }).required(['q']).describe('Input'),
  output: j.object({ ok: j.boolean().describe('ok') }).required(['ok']).describe('Output'),
  async handler(input) {
    try {
      const res = await notion.databases.query({ database_id: input.q, page_size: 10 });
      return { ok: true as const, results: res.results };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false as const, error: message };
    }
  },
});
`.trim();

const VALID_BODY = '```typescript\n' + VALID_TS + '\n```';

beforeEach(() => {
  vi.stubEnv('FORGE_PRIMARY_PROVIDER', 'anthropic');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function fakeAnthropic(
  responses: string[],
  usage = {
    input_tokens: 1500,
    output_tokens: 600,
    cache_read_input_tokens: 12000,
    cache_creation_input_tokens: 0,
  },
): AnthropicClientLike & {
  calls: Array<{ system: unknown; messages: Array<{ content: string }> }>;
} {
  const calls: Array<{ system: unknown; messages: Array<{ content: string }> }> = [];
  let idx = 0;
  const client: AnthropicClientLike = {
    complete: vi.fn(async (params) => {
      calls.push({ system: params.system, messages: params.messages });
      const body = responses[Math.min(idx, responses.length - 1)] ?? '';
      idx += 1;
      return {
        id: `msg_${idx}`,
        content: [{ type: 'text', text: body }],
        model: params.model,
        usage,
      };
    }),
  };
  return Object.assign(client, { calls });
}

function fakeOpenai(
  responses: string[],
): OpenaiClientLike & { calls: Array<{ messages: Array<{ content: string | null }> }> } {
  const calls: Array<{ messages: Array<{ content: string | null }> }> = [];
  let idx = 0;
  const client: OpenaiClientLike = {
    complete: vi.fn(async (params) => {
      calls.push({ messages: params.messages });
      const body = responses[Math.min(idx, responses.length - 1)] ?? '';
      idx += 1;
      return {
        id: `cmpl_${idx}`,
        model: params.model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: body },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
      };
    }),
  };
  return Object.assign(client, { calls });
}

describe('toolCoder — happy path', () => {
  it('defaults to OpenAI GPT-5.5 without requiring an Anthropic key', async () => {
    vi.unstubAllEnvs();
    const openaiClient = fakeOpenai([VALID_BODY]);
    const out = await toolCoder({
      description: 'List pages from a Notion database',
      schema: SAMPLE_SCHEMA,
      config: { openaiApiKey: 'sk-test', openaiClient },
    });
    expect(out.source).toContain('worker.tool({');
    expect(openaiClient.complete).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gpt-5.5' }),
      undefined,
    );
  });

  it('returns ToolCoderOutput with parseable source', async () => {
    const anthropicClient = fakeAnthropic([VALID_BODY]);
    const out = await toolCoder({
      description: 'List pages from a Notion database',
      schema: SAMPLE_SCHEMA,
      config: { anthropicApiKey: 'sk-test', anthropicClient },
    });
    expect(out.source).toContain('worker.tool({');
    expect(out.sourceLines).toBeGreaterThan(5);
    expect(out.workerName).toMatch(/^forge-.*-[a-f0-9]{6}$/u);
    expect(out.packageJsonPatch.dependencies['@notion/workers-sdk']).toBeDefined();
    expect(out.packageJsonPatch.dependencies['@notionhq/client']).toBeDefined();
  });

  it('emits tool-coder.complete with cost + tokens + workerName', async () => {
    const events: Array<{ msg: string; meta?: Record<string, unknown> }> = [];
    const anthropicClient = fakeAnthropic([VALID_BODY]);
    await toolCoder({
      description: 'List pages from a Notion database',
      schema: SAMPLE_SCHEMA,
      config: {
        anthropicApiKey: 'sk-test',
        anthropicClient,
        logger: {
          info: (msg, meta) => events.push({ msg, ...(meta ? { meta } : {}) }),
          error: () => {
            /* no-op */
          },
        },
      },
    });
    const complete = events.find((e) => e.msg === 'tool-coder.complete');
    expect(complete).toBeDefined();
    expect(complete!.meta!['attempt']).toBe(1);
    expect(complete!.meta!['costUsd']).toBeGreaterThan(0);
    expect(complete!.meta!['cacheReadTokens']).toBe(12000);
    expect(complete!.meta!['workerName']).toMatch(/^forge-/u);
  });

  it('sends the system prompt as a single ephemeral-cached block', async () => {
    const anthropicClient = fakeAnthropic([VALID_BODY]);
    await toolCoder({
      description: 'desc',
      schema: SAMPLE_SCHEMA,
      config: { anthropicApiKey: 'sk-test', anthropicClient },
    });
    // Tool Coder has no workspace-specific system content (unlike Schema
    // Smith), so the system array has exactly one block — wrapped in
    // cache_control: 'ephemeral'. The workspace-independent shape is what
    // gives Tool Coder its dominant cache hit rate.
    const captured = anthropicClient.calls[0]!.system;
    expect(captured).toEqual([
      {
        type: 'text',
        text: expect.any(String),
        cache_control: { type: 'ephemeral' },
      },
    ]);
    const blocks = captured as Array<{ text: string }>;
    // The few-shot catalog alone makes the prompt > 2KB.
    expect(blocks[0]!.text.length).toBeGreaterThan(2000);
    expect(blocks[0]!.text).toContain('Tool Coder');
  });
});

describe('toolCoder — parse retry path', () => {
  it('retries once on malformed TS, succeeds on attempt 2', async () => {
    const anthropicClient = fakeAnthropic(['```typescript\nthis is { not valid\n```', VALID_BODY]);
    const out = await toolCoder({
      description: 'desc',
      schema: SAMPLE_SCHEMA,
      config: { anthropicApiKey: 'sk-test', anthropicClient },
    });
    expect(out.source).toContain('worker.tool({');
    expect(anthropicClient.calls.length).toBe(2);
    // The retry user message should reference the previous parse error.
    const secondUser = anthropicClient.calls[1]!.messages[0]!.content;
    expect(secondUser).toContain('PREVIOUS_ATTEMPT_PARSE_ERROR');
  });

  it('throws ToolCoderError after both attempts fail to parse', async () => {
    const anthropicClient = fakeAnthropic([
      '```typescript\nstill not valid {\n```',
      '```typescript\nalso bad {\n```',
    ]);
    await expect(
      toolCoder({
        description: 'desc',
        schema: SAMPLE_SCHEMA,
        config: { anthropicApiKey: 'sk-test', anthropicClient },
      }),
    ).rejects.toBeInstanceOf(ToolCoderError);
    expect(anthropicClient.calls.length).toBe(2);
  });

  it('throws ToolCoderError when no code block extracted', async () => {
    const anthropicClient = fakeAnthropic([
      'I would write the code but I am tired',
      'I am still tired and have no code',
    ]);
    await expect(
      toolCoder({
        description: 'desc',
        schema: SAMPLE_SCHEMA,
        config: { anthropicApiKey: 'sk-test', anthropicClient },
      }),
    ).rejects.toBeInstanceOf(ToolCoderError);
  });
});

describe('toolCoder — OpenAI fallback path', () => {
  it('falls back to OpenAI on Anthropic RateLimitError', async () => {
    const anthropicClient: AnthropicClientLike = {
      complete: vi.fn(async () => {
        throw new RateLimitError('Rate limited', {
          status: 429,
          body: {},
          provider: 'anthropic',
          retryAfter: 1,
        });
      }),
    };
    const openaiClient = fakeOpenai([VALID_BODY]);
    const out = await toolCoder({
      description: 'desc',
      schema: SAMPLE_SCHEMA,
      config: {
        anthropicApiKey: 'k',
        openaiApiKey: 'k',
        anthropicClient,
        openaiClient,
      },
    });
    expect(out.source).toContain('worker.tool({');
    expect(openaiClient.complete).toHaveBeenCalledTimes(1);
  });

  it('falls back to OpenAI on Anthropic 5xx', async () => {
    const { ConnectorError } = await import('@forge/connectors');
    const anthropicClient: AnthropicClientLike = {
      complete: vi.fn(async () => {
        throw new ConnectorError('Boom', { status: 503, body: {}, provider: 'anthropic' });
      }),
    };
    const openaiClient = fakeOpenai([VALID_BODY]);
    await toolCoder({
      description: 'desc',
      schema: SAMPLE_SCHEMA,
      config: {
        anthropicApiKey: 'k',
        openaiApiKey: 'k',
        anthropicClient,
        openaiClient,
      },
    });
    expect(openaiClient.complete).toHaveBeenCalledTimes(1);
  });

  it('throws ProviderFallbackError when both providers fail', async () => {
    const { ConnectorError } = await import('@forge/connectors');
    const anthropicClient: AnthropicClientLike = {
      complete: vi.fn(async () => {
        throw new ConnectorError('Boom', { status: 503, body: {}, provider: 'anthropic' });
      }),
    };
    const openaiClient: OpenaiClientLike = {
      complete: vi.fn(async () => {
        throw new ConnectorError('Boom 2', { status: 500, body: {}, provider: 'openai' });
      }),
    };
    await expect(
      toolCoder({
        description: 'desc',
        schema: SAMPLE_SCHEMA,
        config: {
          anthropicApiKey: 'k',
          openaiApiKey: 'k',
          anthropicClient,
          openaiClient,
        },
      }),
    ).rejects.toBeInstanceOf(ProviderFallbackError);
  });

  it('throws ToolCoderError on a non-retryable 4xx', async () => {
    const { ConnectorError } = await import('@forge/connectors');
    const anthropicClient: AnthropicClientLike = {
      complete: vi.fn(async () => {
        throw new ConnectorError('Unauthorized', {
          status: 401,
          body: {},
          provider: 'anthropic',
        });
      }),
    };
    await expect(
      toolCoder({
        description: 'desc',
        schema: SAMPLE_SCHEMA,
        config: { anthropicApiKey: 'k', anthropicClient },
      }),
    ).rejects.toBeInstanceOf(ToolCoderError);
  });
});

describe('toolCoder — prevErrors surfacing', () => {
  it('passes prevErrors into the user message', async () => {
    const anthropicClient = fakeAnthropic([VALID_BODY]);
    await toolCoder({
      description: 'desc',
      schema: SAMPLE_SCHEMA,
      prevErrors: ['fs.writeFileSync target outside /tmp', 'Dependency `lodash` not on allowlist'],
      config: { anthropicApiKey: 'k', anthropicClient },
    });
    const userMessage = anthropicClient.calls[0]!.messages[0]!.content;
    expect(userMessage).toContain('PREVIOUS_INSPECTOR_ERRORS');
    expect(userMessage).toContain('fs.writeFileSync target outside /tmp');
    expect(userMessage).toContain('lodash');
  });
});

describe('toolCoder — worker name determinism', () => {
  it('produces the same worker name for the same input across runs', async () => {
    const anthropicClient1 = fakeAnthropic([VALID_BODY]);
    const anthropicClient2 = fakeAnthropic([VALID_BODY]);
    const out1 = await toolCoder({
      description: 'Pull my open Linear bugs and rank by severity',
      schema: SAMPLE_SCHEMA,
      config: { anthropicApiKey: 'k', anthropicClient: anthropicClient1 },
    });
    const out2 = await toolCoder({
      description: 'Pull my open Linear bugs and rank by severity',
      schema: SAMPLE_SCHEMA,
      config: { anthropicApiKey: 'k', anthropicClient: anthropicClient2 },
    });
    expect(out1.workerName).toBe(out2.workerName);
  });

  it('uses the derived worker name inside the user prompt', async () => {
    const anthropicClient = fakeAnthropic([VALID_BODY]);
    await toolCoder({
      description: 'Distinct description for naming',
      schema: SAMPLE_SCHEMA,
      config: { anthropicApiKey: 'k', anthropicClient },
    });
    const userMessage = anthropicClient.calls[0]!.messages[0]!.content;
    expect(userMessage).toMatch(/WORKER_NAME: forge-.*-[a-f0-9]{6}/u);
  });
});

describe('toolCoder — packageJsonPatch shape', () => {
  it('emits the expected dependency keys based on imports', async () => {
    const anthropicClient = fakeAnthropic([VALID_BODY]);
    const out = await toolCoder({
      description: 'desc',
      schema: SAMPLE_SCHEMA,
      config: { anthropicApiKey: 'k', anthropicClient },
    });
    const deps = out.packageJsonPatch.dependencies;
    expect(Object.keys(deps).sort()).toEqual(['@notion/workers-sdk', '@notionhq/client']);
    expect(deps['@notion/workers-sdk']).toMatch(/^\^/u);
  });

  it('emits @forge/connectors when the generated source imports a connector', async () => {
    const sourceWithConnector = `
import { worker, j } from '@notion/workers-sdk';
import { createGithubClient } from '@forge/connectors/github';

const gh = createGithubClient({ apiKey: process.env['GITHUB_TOKEN'] ?? '' });

worker.tool({
  name: 'x',
  description: 'x',
  input: j.object({}).describe('x'),
  output: j.object({}).describe('x'),
  async handler() {
    try {
      const r = await gh.getRepo({ owner: 'a', repo: 'b' });
      return { ok: true as const, r };
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
    }
  },
});
    `.trim();
    const anthropicClient = fakeAnthropic(['```typescript\n' + sourceWithConnector + '\n```']);
    const out = await toolCoder({
      description: 'desc',
      schema: SAMPLE_SCHEMA,
      config: { anthropicApiKey: 'k', anthropicClient },
    });
    expect(out.packageJsonPatch.dependencies['@forge/connectors']).toBe('workspace:*');
  });
});
