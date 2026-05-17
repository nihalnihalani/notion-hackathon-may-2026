import { describe, expect, it } from 'vitest';
import { ConnectorError } from '../src/errors.js';
import { createSlackClient } from '../src/slack/index.js';
import { mockFetch } from './helpers.js';

describe('SlackClient', () => {
  it('postMessage sends channel + text and returns ts', async () => {
    const { fetch, calls } = mockFetch({
      status: 200,
      body: { ok: true, channel: 'C123', ts: '1.0' },
    });
    const c = createSlackClient({ apiKey: 'xoxb', fetch });
    const out = await c.postMessage('C123', 'hello');
    expect(out.ok).toBe(true);
    const body = JSON.parse(calls[0]!.body!);
    expect(body).toEqual({ channel: 'C123', text: 'hello' });
  });

  it('translates ok=false into a ConnectorError', async () => {
    const { fetch } = mockFetch({
      status: 200,
      body: { ok: false, error: 'channel_not_found' },
    });
    const c = createSlackClient({ apiKey: 'xoxb', fetch });
    await expect(c.postMessage('C999', 'x')).rejects.toBeInstanceOf(ConnectorError);
  });

  it('listChannels returns channels[]', async () => {
    const { fetch } = mockFetch({
      status: 200,
      body: {
        ok: true,
        channels: [{ id: 'C1', name: 'general' }],
      },
    });
    const c = createSlackClient({ apiKey: 'xoxb', fetch });
    const out = await c.listChannels();
    expect(out).toEqual([{ id: 'C1', name: 'general' }]);
  });
});
