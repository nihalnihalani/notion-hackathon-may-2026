/**
 * Auth-header verification — each connector must inject the right header.
 * One assertion per provider, hitting a single happy-path method per client.
 */

import { describe, expect, it } from 'vitest';
import { createAnthropicClient } from '../src/anthropic/index.js';
import { createGithubClient } from '../src/github/index.js';
import { createCalendarClient, createGmailClient } from '../src/google/index.js';
import { createLinearClient } from '../src/linear/index.js';
import { createMinimaxClient } from '../src/minimax/index.js';
import { createOpenaiClient } from '../src/openai/index.js';
import { createSentryClient } from '../src/sentry/index.js';
import { createSlackClient } from '../src/slack/index.js';
import { createStripeClient } from '../src/stripe/index.js';
import { createVercelClient } from '../src/vercel/index.js';
import { mockFetch } from './helpers.js';

describe('auth headers', () => {
  it('github uses Bearer + GitHub headers', async () => {
    const { fetch, calls } = mockFetch({ status: 200, body: [] });
    const c = createGithubClient({ apiKey: 'ghp_x', fetch });
    await c.listOpenPRs('o/r');
    expect(calls[0]!.headers['authorization']).toBe('Bearer ghp_x');
    expect(calls[0]!.headers['accept']).toContain('application/vnd.github+json');
    expect(calls[0]!.headers['x-github-api-version']).toBe('2022-11-28');
  });

  it('linear uses raw API key in Authorization (no Bearer prefix)', async () => {
    const { fetch, calls } = mockFetch({
      status: 200,
      body: { data: { issues: { nodes: [] } } },
    });
    const c = createLinearClient({ apiKey: 'lin_xxx', fetch });
    await c.listMyIssues();
    expect(calls[0]!.headers['authorization']).toBe('lin_xxx');
    expect(calls[0]!.method).toBe('POST');
  });

  it('stripe uses Bearer', async () => {
    const { fetch, calls } = mockFetch({
      status: 200,
      body: { object: 'list', data: [], has_more: false },
    });
    const c = createStripeClient({ apiKey: 'sk_test_x', fetch });
    await c.listRecentCharges();
    expect(calls[0]!.headers['authorization']).toBe('Bearer sk_test_x');
    expect(calls[0]!.headers['stripe-version']).toBeDefined();
  });

  it('slack uses Bearer bot token', async () => {
    const { fetch, calls } = mockFetch({
      status: 200,
      body: { ok: true, channels: [] },
    });
    const c = createSlackClient({ apiKey: 'xoxb-123', fetch });
    await c.listChannels();
    expect(calls[0]!.headers['authorization']).toBe('Bearer xoxb-123');
  });

  it('gmail uses Bearer OAuth token', async () => {
    const { fetch, calls } = mockFetch({ status: 200, body: { messages: [] } });
    const c = createGmailClient({ apiKey: 'ya29.access', fetch });
    await c.listMessages();
    expect(calls[0]!.headers['authorization']).toBe('Bearer ya29.access');
  });

  it('calendar uses Bearer OAuth token', async () => {
    const { fetch, calls } = mockFetch({ status: 200, body: { items: [] } });
    const c = createCalendarClient({ apiKey: 'ya29.cal', fetch });
    await c.listUpcomingEvents();
    expect(calls[0]!.headers['authorization']).toBe('Bearer ya29.cal');
  });

  it('sentry uses Bearer', async () => {
    const { fetch, calls } = mockFetch({ status: 200, body: [] });
    const c = createSentryClient({ apiKey: 'sntrys_x', fetch });
    await c.listIssues('org/proj');
    expect(calls[0]!.headers['authorization']).toBe('Bearer sntrys_x');
  });

  it('vercel uses Bearer', async () => {
    const { fetch, calls } = mockFetch({ status: 200, body: { deployments: [] } });
    const c = createVercelClient({ apiKey: 'vercel_x', fetch });
    await c.listDeployments('prj_1');
    expect(calls[0]!.headers['authorization']).toBe('Bearer vercel_x');
  });

  it('anthropic direct mode uses x-api-key (not Bearer)', async () => {
    const { fetch, calls } = mockFetch({
      status: 200,
      body: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude',
        content: [{ type: 'text', text: 'hi' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    });
    const c = createAnthropicClient({ apiKey: 'sk-ant-xxx', fetch });
    await c.complete({
      model: 'claude-opus-4-7',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 8,
    });
    expect(calls[0]!.headers['x-api-key']).toBe('sk-ant-xxx');
    expect(calls[0]!.headers['anthropic-version']).toBeDefined();
    expect(calls[0]!.headers['authorization']).toBeUndefined();
  });

  it('anthropic gateway mode switches to Bearer + custom base', async () => {
    const { fetch, calls } = mockFetch({
      status: 200,
      body: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude',
        content: [{ type: 'text', text: 'hi' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    });
    const c = createAnthropicClient({
      apiKey: 'gw_key',
      gatewayUrl: 'https://gw.example.com',
      fetch,
    });
    await c.complete({
      model: 'claude-opus-4-7',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 8,
    });
    expect(calls[0]!.headers['authorization']).toBe('Bearer gw_key');
    expect(calls[0]!.url).toBe('https://gw.example.com/v1/messages');
  });

  it('openai uses Bearer', async () => {
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
    const c = createOpenaiClient({ apiKey: 'sk-x', fetch });
    await c.complete({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(calls[0]!.headers['authorization']).toBe('Bearer sk-x');
  });

  it('minimax uses Bearer', async () => {
    const { fetch, calls } = mockFetch({
      status: 200,
      body: { base_resp: { status_code: 0, status_msg: 'ok' } },
    });
    const c = createMinimaxClient({ apiKey: 'mm_x', fetch });
    await c.speak({ text: 'hi' });
    expect(calls[0]!.headers['authorization']).toBe('Bearer mm_x');
  });
});
