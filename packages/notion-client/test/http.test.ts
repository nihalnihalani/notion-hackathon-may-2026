/**
 * Tests for the notion-client HTTP transport. Mirrors the matrix in
 * `packages/connectors/test/http.test.ts`. Each test pins a behaviour that
 * downstream resource methods rely on.
 */

import { describe, expect, it } from 'vitest';
import {
  NotionAuthError,
  NotionError,
  NotionNotFoundError,
  NotionRateLimitError,
  NotionValidationError,
} from '../src/errors.js';
import { notionRequest } from '../src/http.js';
import {
  DEFAULT_BASE_URL,
  DEFAULT_NOTION_VERSION,
  type NotionClientConfig,
} from '../src/types.js';
import { mockFetch } from './helpers.js';

const tinyRetry = {
  retries: 2,
  initialDelayMs: 1,
  maxDelayMs: 4,
  jitter: false,
};

function cfg(overrides: Partial<NotionClientConfig> = {}): NotionClientConfig {
  return { token: 'secret_x', ...overrides };
}

describe('notionRequest', () => {
  it('returns parsed JSON on 200, sets auth + Notion-Version headers', async () => {
    const { fetch, calls } = mockFetch({
      status: 200,
      body: { object: 'page', id: 'p1' },
    });
    const res = await notionRequest<{ object: string; id: string }>(
      '/v1/pages/p1',
      {},
      cfg({ fetch }),
    );
    expect(res).toEqual({ object: 'page', id: 'p1' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.headers['authorization']).toBe('Bearer secret_x');
    expect(calls[0]!.headers['notion-version']).toBe(DEFAULT_NOTION_VERSION);
    expect(calls[0]!.headers['accept']).toBe('application/json');
    // Default base URL is the public Notion API.
    expect(calls[0]!.url).toBe(`${DEFAULT_BASE_URL}/v1/pages/p1`);
  });

  it('returns null on 204', async () => {
    const { fetch } = mockFetch({ status: 204 });
    const res = await notionRequest<null>('/v1/blocks/x', {}, cfg({ fetch }));
    expect(res).toBeNull();
  });

  it('respects an overridden notionVersion', async () => {
    const { fetch, calls } = mockFetch({ status: 200, body: {} });
    await notionRequest('/v1/users/me', {}, cfg({ fetch, notionVersion: '2022-06-28' }));
    expect(calls[0]!.headers['notion-version']).toBe('2022-06-28');
  });

  it('respects an overridden baseUrl (no double slash)', async () => {
    const { fetch, calls } = mockFetch({ status: 200, body: {} });
    await notionRequest('/v1/users/me', {}, cfg({ fetch, baseUrl: 'https://proxy.test/' }));
    expect(calls[0]!.url).toBe('https://proxy.test/v1/users/me');
  });

  it('JSON-encodes plain object body + sets Content-Type', async () => {
    const { fetch, calls } = mockFetch({ status: 200, body: {} });
    await notionRequest(
      '/v1/pages',
      { method: 'POST', body: { foo: 'bar' } },
      cfg({ fetch }),
    );
    expect(calls[0]!.headers['content-type']).toBe('application/json');
    expect(calls[0]!.body).toBe(JSON.stringify({ foo: 'bar' }));
  });

  it('serialises query params and drops undefined/null', async () => {
    const { fetch, calls } = mockFetch({ status: 200, body: {} });
    await notionRequest(
      '/v1/users',
      { query: { page_size: 50, start_cursor: 'abc', drop: undefined, alsoDrop: null } },
      cfg({ fetch }),
    );
    expect(calls[0]!.url).toBe(
      `${DEFAULT_BASE_URL}/v1/users?page_size=50&start_cursor=abc`,
    );
  });

  it('retries 429 with Retry-After then succeeds', async () => {
    const { fetch, calls } = mockFetch([
      { status: 429, headers: { 'retry-after': '0' }, body: { code: 'rate_limited' } },
      { status: 200, body: { ok: true } },
    ]);
    const res = await notionRequest<{ ok: boolean }>(
      '/v1/x',
      {},
      cfg({ fetch }),
      tinyRetry,
    );
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('retries 5xx with backoff then succeeds', async () => {
    const { fetch, calls } = mockFetch([
      { status: 502, body: 'bad gateway' },
      { status: 503, body: 'try again' },
      { status: 200, body: { ok: true } },
    ]);
    const res = await notionRequest<{ ok: boolean }>(
      '/v1/x',
      {},
      cfg({ fetch }),
      tinyRetry,
    );
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(3);
  });

  it('exhausts retries on persistent 500 → throws NotionError', async () => {
    const { fetch, calls } = mockFetch({ status: 500, body: { code: 'internal_server_error' } });
    await expect(
      notionRequest('/v1/x', {}, cfg({ fetch }), tinyRetry),
    ).rejects.toBeInstanceOf(NotionError);
    expect(calls).toHaveLength(tinyRetry.retries + 1);
  });

  it('throws NotionAuthError immediately on 401 (no retry)', async () => {
    const { fetch, calls } = mockFetch({ status: 401, body: { code: 'unauthorized' } });
    await expect(
      notionRequest('/v1/x', {}, cfg({ fetch }), tinyRetry),
    ).rejects.toBeInstanceOf(NotionAuthError);
    expect(calls).toHaveLength(1);
  });

  it('throws NotionAuthError on 403', async () => {
    const { fetch } = mockFetch({ status: 403, body: { code: 'restricted_resource' } });
    await expect(
      notionRequest('/v1/x', {}, cfg({ fetch }), tinyRetry),
    ).rejects.toBeInstanceOf(NotionAuthError);
  });

  it('throws NotionNotFoundError on 404', async () => {
    const { fetch } = mockFetch({ status: 404, body: { code: 'object_not_found' } });
    await expect(
      notionRequest('/v1/x', {}, cfg({ fetch }), tinyRetry),
    ).rejects.toBeInstanceOf(NotionNotFoundError);
  });

  it('throws NotionValidationError on 400', async () => {
    const { fetch } = mockFetch({
      status: 400,
      body: { code: 'validation_error', message: 'bad input' },
    });
    await expect(
      notionRequest('/v1/x', {}, cfg({ fetch }), tinyRetry),
    ).rejects.toBeInstanceOf(NotionValidationError);
  });

  it('exposes parsed retryAfter on RateLimitError after exhaustion', async () => {
    const { fetch } = mockFetch({
      status: 429,
      headers: { 'retry-after': '7' },
      body: { code: 'rate_limited' },
    });
    try {
      await notionRequest('/v1/x', {}, cfg({ fetch }), { ...tinyRetry, retries: 0 });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(NotionRateLimitError);
      expect((err as NotionRateLimitError).retryAfter).toBe(7);
      // Notion error code surfaced on the typed error.
      expect((err as NotionRateLimitError).code).toBe('rate_limited');
    }
  });

  it('extracts the Notion `message` field into the thrown error message', async () => {
    const { fetch } = mockFetch({
      status: 400,
      body: { code: 'validation_error', message: 'title.length too long' },
    });
    try {
      await notionRequest('/v1/x', {}, cfg({ fetch }), tinyRetry);
    } catch (err) {
      expect((err as Error).message).toContain('validation_error');
      expect((err as Error).message).toContain('title.length too long');
    }
  });

  it('invokes the pacer before every attempt (including retries)', async () => {
    let acquires = 0;
    const pacer = { acquire: async () => void acquires++ };
    const { fetch } = mockFetch([
      { status: 503, body: 'x' },
      { status: 200, body: {} },
    ]);
    await notionRequest('/v1/x', {}, cfg({ fetch, pacer }), tinyRetry);
    // Initial attempt + 1 retry = 2 pacer waits.
    expect(acquires).toBe(2);
  });
});
