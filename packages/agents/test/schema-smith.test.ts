/**
 * Schema Smith unit tests.
 *
 * The Anthropic + OpenAI clients are injected via `SubAgentConfig.anthropicClient`
 * + `openaiClient` — no fetch interception needed. This matches the production
 * test pattern for sibling sub-agents.
 */

import { describe, expect, it, vi } from 'vitest';
import { schemaSmith } from '../src/schema-smith.js';
import { RateLimitError } from '@forge/connectors';
import { SchemaSmithError, ProviderFallbackError } from '../src/errors.js';
import type {
  AnthropicClientLike,
  OpenaiClientLike,
  SchemaSmithOutput,
  WorkspaceContext,
} from '../src/types.js';

const EMPTY_WORKSPACE: WorkspaceContext = {
  databases: [],
  existingAgents: [],
};

const SAMPLE_OUTPUT: SchemaSmithOutput = {
  pattern: 'database-query',
  inputSchema: {
    kind: 'object',
    describe: 'Input',
    properties: {
      severity: {
        kind: 'string',
        describe: 'Filter severity',
        enum: ['low', 'med', 'high'],
      },
    },
    required: ['severity'],
  },
  outputSchema: {
    kind: 'array',
    describe: 'Matching rows',
    items: {
      kind: 'object',
      describe: 'Row',
      properties: { id: { kind: 'uuid', describe: 'row id' } },
      required: ['id'],
    },
  },
  requiredScopes: ['databases.read'],
  requiredOAuth: [],
  rationale: 'Reads the existing bug database filtered by severity.',
};

function fakeAnthropicOk(
  body: string,
  usage = {
    input_tokens: 120,
    output_tokens: 80,
    cache_read_input_tokens: 2000,
    cache_creation_input_tokens: 0,
  },
): AnthropicClientLike {
  return {
    complete: vi.fn(async () => ({
      id: 'msg_1',
      content: [{ type: 'text', text: body }],
      model: 'claude-opus-4-7',
      usage,
    })),
  };
}

function fakeOpenaiOk(body: string): OpenaiClientLike {
  return {
    complete: vi.fn(async () => ({
      id: 'cmpl_1',
      model: 'gpt-5-thinking-mini',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: body },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 60, total_tokens: 160 },
    })),
  };
}

describe('schemaSmith — happy path', () => {
  it('parses a valid Anthropic response into SchemaSmithOutput', async () => {
    const anthropicClient = fakeAnthropicOk(JSON.stringify(SAMPLE_OUTPUT));
    const out = await schemaSmith({
      description: 'List me open bugs in my Bugs DB by severity',
      workspaceContext: EMPTY_WORKSPACE,
      config: {
        anthropicApiKey: 'sk-test',
        anthropicClient,
      },
    });
    expect(out).toEqual(SAMPLE_OUTPUT);
    expect(anthropicClient.complete).toHaveBeenCalledTimes(1);
  });

  it('emits a schema-smith.complete log event with cost + tokens', async () => {
    const events: Array<{ msg: string; meta?: Record<string, unknown> }> = [];
    const anthropicClient = fakeAnthropicOk(JSON.stringify(SAMPLE_OUTPUT));
    await schemaSmith({
      description: 'desc',
      workspaceContext: EMPTY_WORKSPACE,
      config: {
        anthropicApiKey: 'k',
        anthropicClient,
        logger: {
          info: (msg, meta) => events.push({ msg, ...(meta ? { meta } : {}) }),
          error: () => {
            /* no-op */
          },
        },
      },
    });
    const complete = events.find((e) => e.msg === 'schema-smith.complete');
    expect(complete).toBeDefined();
    expect(complete!.meta!['attempt']).toBe(1);
    expect(complete!.meta!['costUsd']).toBeGreaterThan(0);
    expect(complete!.meta!['cacheReadTokens']).toBe(2000);
  });

  it('extracts JSON from a fenced ```json block', async () => {
    const fenced = '```json\n' + JSON.stringify(SAMPLE_OUTPUT) + '\n```\n';
    const anthropicClient = fakeAnthropicOk(fenced);
    const out = await schemaSmith({
      description: 'd',
      workspaceContext: EMPTY_WORKSPACE,
      config: { anthropicApiKey: 'k', anthropicClient },
    });
    expect(out.pattern).toBe('database-query');
  });
});

describe('schemaSmith — pattern=null clarifying question', () => {
  it('returns the rationale as the clarifying question', async () => {
    const ambiguous: SchemaSmithOutput = {
      ...SAMPLE_OUTPUT,
      pattern: null,
      rationale: 'Which database should I query?',
    };
    const anthropicClient = fakeAnthropicOk(JSON.stringify(ambiguous));
    const out = await schemaSmith({
      description: 'do the thing with the stuff',
      workspaceContext: EMPTY_WORKSPACE,
      config: { anthropicApiKey: 'k', anthropicClient },
    });
    expect(out.pattern).toBeNull();
    expect(out.rationale).toContain('Which database');
  });
});

describe('schemaSmith — validation retry path', () => {
  it('retries once when first response is malformed JSON; succeeds on attempt 2', async () => {
    const calls: Array<{ messages: Array<{ content: string }> }> = [];
    const anthropicClient: AnthropicClientLike = {
      complete: vi.fn(async (params) => {
        calls.push({ messages: params.messages });
        const isFirst = calls.length === 1;
        return {
          id: 'msg_x',
          content: [
            {
              type: 'text',
              text: isFirst ? 'not even json' : JSON.stringify(SAMPLE_OUTPUT),
            },
          ],
          model: 'claude-opus-4-7',
          usage: { input_tokens: 10, output_tokens: 10 },
        };
      }),
    };
    const out = await schemaSmith({
      description: 'try me',
      workspaceContext: EMPTY_WORKSPACE,
      config: { anthropicApiKey: 'k', anthropicClient },
    });
    expect(out.pattern).toBe('database-query');
    expect(calls.length).toBe(2);
    // The retry user message should reference the previous error.
    const secondUser =
      typeof calls[1]!.messages[0]!.content === 'string' ? calls[1]!.messages[0]!.content : '';
    expect(secondUser).toContain('PREVIOUS_ATTEMPT_ERROR');
    expect(secondUser).toContain('not valid JSON');
  });

  it('retries once when JSchemaSpec round-trip fails', async () => {
    let call = 0;
    const bad: SchemaSmithOutput = {
      ...SAMPLE_OUTPUT,
      // Cast through unknown — we're deliberately producing an invalid spec
      // to drive the self-eval retry branch.
      inputSchema: {
        kind: 'string',
        describe: '',
      } as unknown as SchemaSmithOutput['inputSchema'],
    };
    const anthropicClient: AnthropicClientLike = {
      complete: vi.fn(async () => {
        call++;
        return {
          id: 'm',
          content: [
            {
              type: 'text',
              text: call === 1 ? JSON.stringify(bad) : JSON.stringify(SAMPLE_OUTPUT),
            },
          ],
          model: 'claude-opus-4-7',
          usage: { input_tokens: 10, output_tokens: 10 },
        };
      }),
    };
    const out = await schemaSmith({
      description: 'd',
      workspaceContext: EMPTY_WORKSPACE,
      config: { anthropicApiKey: 'k', anthropicClient },
    });
    expect(out).toEqual(SAMPLE_OUTPUT);
    expect(call).toBe(2);
  });
});

describe('schemaSmith — fallback path', () => {
  it('falls back to OpenAI on RateLimitError from Anthropic', async () => {
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
    const openaiClient = fakeOpenaiOk(JSON.stringify(SAMPLE_OUTPUT));
    const out = await schemaSmith({
      description: 'd',
      workspaceContext: EMPTY_WORKSPACE,
      config: {
        anthropicApiKey: 'k',
        openaiApiKey: 'k',
        anthropicClient,
        openaiClient,
      },
    });
    expect(out).toEqual(SAMPLE_OUTPUT);
    expect(openaiClient.complete).toHaveBeenCalledTimes(1);
  });

  it('throws SchemaSmithError when primary 4xx (non-retryable, non-fallback)', async () => {
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
      schemaSmith({
        description: 'd',
        workspaceContext: EMPTY_WORKSPACE,
        config: { anthropicApiKey: 'k', anthropicClient },
      }),
    ).rejects.toBeInstanceOf(SchemaSmithError);
  });

  it('throws ProviderFallbackError when both providers fail', async () => {
    const { ConnectorError } = await import('@forge/connectors');
    const anthropicClient: AnthropicClientLike = {
      complete: vi.fn(async () => {
        throw new ConnectorError('Boom', {
          status: 503,
          body: {},
          provider: 'anthropic',
        });
      }),
    };
    const openaiClient: OpenaiClientLike = {
      complete: vi.fn(async () => {
        throw new ConnectorError('Boom 2', {
          status: 500,
          body: {},
          provider: 'openai',
        });
      }),
    };
    await expect(
      schemaSmith({
        description: 'd',
        workspaceContext: EMPTY_WORKSPACE,
        config: {
          anthropicApiKey: 'k',
          openaiApiKey: 'k',
          anthropicClient,
          openaiClient,
        },
      }),
    ).rejects.toBeInstanceOf(ProviderFallbackError);
  });
});

describe('schemaSmith — retries exhausted', () => {
  it('throws SchemaSmithError when both attempts return invalid JSON', async () => {
    const anthropicClient: AnthropicClientLike = {
      complete: vi.fn(async () => ({
        id: 'm',
        content: [{ type: 'text', text: 'still not json' }],
        model: 'claude-opus-4-7',
        usage: { input_tokens: 1, output_tokens: 1 },
      })),
    };
    await expect(
      schemaSmith({
        description: 'd',
        workspaceContext: EMPTY_WORKSPACE,
        config: { anthropicApiKey: 'k', anthropicClient },
      }),
    ).rejects.toBeInstanceOf(SchemaSmithError);
    expect(anthropicClient.complete).toHaveBeenCalledTimes(2);
  });
});

describe('schemaSmith — workspace context renders into prompt', () => {
  it('puts workspace context in the SECOND (non-cached) system block', async () => {
    // The system prompt is sent as two blocks:
    //   [0] static, with cache_control: 'ephemeral'
    //   [1] workspace context, no cache_control
    // This is what makes the prompt cache hit across workspaces.
    let capturedSystem: unknown = undefined;
    const anthropicClient: AnthropicClientLike = {
      complete: vi.fn(async (params) => {
        capturedSystem = params.system;
        return {
          id: 'm',
          content: [{ type: 'text', text: JSON.stringify(SAMPLE_OUTPUT) }],
          model: 'claude-opus-4-7',
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      }),
    };
    await schemaSmith({
      description: 'd',
      workspaceContext: {
        databases: [
          {
            id: 'abc123-def-456',
            name: 'Bugs',
            properties: [
              { name: 'Title', type: 'title' },
              { name: 'Severity', type: 'select' },
            ],
          },
        ],
        existingAgents: [
          {
            name: 'bug-triager',
            pattern: 'database-query',
            description: 'Sorts bugs by severity',
          },
        ],
      },
      config: { anthropicApiKey: 'k', anthropicClient },
    });

    expect(capturedSystem).toEqual([
      {
        type: 'text',
        text: expect.any(String),
        cache_control: { type: 'ephemeral' },
      },
      { type: 'text', text: expect.any(String) },
    ]);
    const blocks = capturedSystem as Array<{ text: string; cache_control?: unknown }>;
    // Workspace ids and per-call data live in the SECOND block.
    expect(blocks[1]!.text).toContain('abc123-def-456');
    expect(blocks[1]!.text).toContain('Severity (select)');
    expect(blocks[1]!.text).toContain('bug-triager');
    // The static block is cacheable — and carries Schema Smith's role.
    expect(blocks[0]!.text).toContain('Schema Smith');
    expect(blocks[0]!.text).not.toContain('abc123-def-456');
  });
});
