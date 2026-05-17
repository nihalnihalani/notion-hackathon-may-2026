import { describe, expect, it } from 'vitest';
import { createAnthropicClient } from '../src/anthropic/index.js';
import { mockFetch } from './helpers.js';

const okBody = {
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-4-7',
  content: [{ type: 'text', text: 'hi' }],
  stop_reason: 'end_turn',
  usage: {
    input_tokens: 12,
    output_tokens: 3,
    cache_read_input_tokens: 8,
    cache_creation_input_tokens: 0,
  },
};

describe('AnthropicClient', () => {
  it('complete posts messages + max_tokens and returns usage', async () => {
    const { fetch, calls } = mockFetch({ status: 200, body: okBody });
    const c = createAnthropicClient({ apiKey: 'sk-ant', fetch });
    const out = await c.complete({
      model: 'claude-opus-4-7',
      maxTokens: 1024,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(out.usage.cache_read_input_tokens).toBe(8);
    const body = JSON.parse(calls[0]!.body!);
    expect(body.max_tokens).toBe(1024);
    expect(body.model).toBe('claude-opus-4-7');
  });

  it('cacheControl=true wraps string system in ephemeral block', async () => {
    const { fetch, calls } = mockFetch({ status: 200, body: okBody });
    const c = createAnthropicClient({ apiKey: 'sk-ant', fetch });
    await c.complete({
      model: 'claude-opus-4-7',
      maxTokens: 16,
      system: 'You are helpful.',
      cacheControl: true,
      messages: [{ role: 'user', content: 'hi' }],
    });
    const body = JSON.parse(calls[0]!.body!);
    expect(body.system).toEqual([
      { type: 'text', text: 'You are helpful.', cache_control: { type: 'ephemeral' } },
    ]);
  });
});
