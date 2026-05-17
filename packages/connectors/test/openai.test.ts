import { describe, expect, it } from 'vitest';
import { createOpenaiClient } from '../src/openai/index.js';
import { mockFetch } from './helpers.js';

describe('OpenaiClient', () => {
  it('complete forwards model + messages + max_tokens', async () => {
    const { fetch, calls } = mockFetch({
      status: 200,
      body: {
        id: 'c_1',
        object: 'chat.completion',
        created: 1,
        model: 'gpt-4o',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'hi' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      },
    });
    const c = createOpenaiClient({ apiKey: 'sk', fetch });
    const out = await c.complete({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 16,
    });
    expect(out.choices[0]!.message.content).toBe('hi');
    const body = JSON.parse(calls[0]!.body!);
    expect(body.max_tokens).toBe(16);
  });

  it('embed defaults to text-embedding-3-large and returns sorted vectors', async () => {
    const { fetch, calls } = mockFetch({
      status: 200,
      body: {
        object: 'list',
        model: 'text-embedding-3-large',
        data: [
          { object: 'embedding', index: 1, embedding: [0.1, 0.2] },
          { object: 'embedding', index: 0, embedding: [0.9, 0.8] },
        ],
      },
    });
    const c = createOpenaiClient({ apiKey: 'sk', fetch });
    const out = await c.embed({ input: ['a', 'b'] });
    expect(out).toEqual([
      [0.9, 0.8],
      [0.1, 0.2],
    ]);
    const body = JSON.parse(calls[0]!.body!);
    expect(body.model).toBe('text-embedding-3-large');
  });

  it('gatewayUrl flips the base URL', async () => {
    const { fetch, calls } = mockFetch({
      status: 200,
      body: {
        id: 'c_1',
        object: 'chat.completion',
        created: 1,
        model: 'gpt',
        choices: [
          { index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    });
    const c = createOpenaiClient({
      apiKey: 'sk',
      gatewayUrl: 'https://gw.example.com/openai/v1',
      fetch,
    });
    await c.complete({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(calls[0]!.url).toBe('https://gw.example.com/openai/v1/chat/completions');
  });
});
