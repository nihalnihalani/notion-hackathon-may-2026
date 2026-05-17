import { describe, expect, it } from 'vitest';
import { ConnectorError } from '../src/errors.js';
import { createMinimaxClient } from '../src/minimax/index.js';
import { mockFetch } from './helpers.js';

describe('MinimaxClient', () => {
  it('speak posts t2a_v2 with voice + audio settings', async () => {
    const { fetch, calls } = mockFetch({
      status: 200,
      body: {
        data: { audio: 'abc' },
        extra_info: { audio_length: 1000 },
        trace_id: 'tr',
        base_resp: { status_code: 0, status_msg: 'success' },
      },
    });
    const c = createMinimaxClient({ apiKey: 'k', fetch });
    const out = await c.speak({ text: 'hello' });
    expect(out.data?.audio).toBe('abc');
    expect(calls[0]!.url).toContain('/v1/t2a_v2');
    const body = JSON.parse(calls[0]!.body!);
    expect(body.text).toBe('hello');
    expect(body.voice_setting.voice_id).toBe('male-qn-qingse');
  });

  it('translates base_resp.status_code != 0 into ConnectorError', async () => {
    const { fetch } = mockFetch({
      status: 200,
      body: {
        base_resp: { status_code: 1004, status_msg: 'invalid api key' },
      },
    });
    const c = createMinimaxClient({ apiKey: 'k', fetch });
    await expect(c.speak({ text: 'x' })).rejects.toBeInstanceOf(ConnectorError);
  });

  it('generateImage posts prompt + aspect_ratio + n', async () => {
    const { fetch, calls } = mockFetch({
      status: 200,
      body: {
        id: 'img_1',
        data: { image_urls: ['https://cdn/x.png'] },
        base_resp: { status_code: 0, status_msg: 'success' },
      },
    });
    const c = createMinimaxClient({ apiKey: 'k', fetch });
    const out = await c.generateImage({
      prompt: 'a cat',
      size: '16:9',
      count: 2,
    });
    expect(out.data?.image_urls).toEqual(['https://cdn/x.png']);
    const body = JSON.parse(calls[0]!.body!);
    expect(body.prompt).toBe('a cat');
    expect(body.aspect_ratio).toBe('16:9');
    expect(body.n).toBe(2);
  });
});
