/**
 * Tests for the shared HTTP helper. We exercise the retry + error-mapping
 * matrix here so each connector test can stay focused on its provider shape.
 */

import { describe, expect, it } from 'vitest';
import {
  AuthError,
  ConnectorError,
  NotFoundError,
  RateLimitError,
  ValidationError,
} from '../src/errors.js';
import { buildContext, makeRequest } from '../src/http.js';
import { mockFetch } from './helpers.js';

const baseCtx = buildContext({
  provider: 'test',
  authScheme: 'Bearer',
  config: { apiKey: 'k' },
});

const tinyRetry = { retries: 2, initialDelayMs: 1, maxDelayMs: 4, jitter: false };

describe('makeRequest', () => {
  it('returns parsed JSON on 200', async () => {
    const { fetch, calls } = mockFetch({ status: 200, body: { hello: 'world' } });
    const res = await makeRequest<{ hello: string }>(
      '/x',
      {},
      { apiKey: 'k', baseUrl: 'https://api.test', fetch },
      baseCtx,
    );
    expect(res).toEqual({ hello: 'world' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.headers['authorization']).toBe('Bearer k');
  });

  it('returns null on 204', async () => {
    const { fetch } = mockFetch({ status: 204 });
    const res = await makeRequest<null>(
      '/x',
      {},
      { apiKey: 'k', baseUrl: 'https://api.test', fetch },
      baseCtx,
    );
    expect(res).toBeNull();
  });

  it('retries on 429 with Retry-After then succeeds', async () => {
    const { fetch, calls } = mockFetch([
      { status: 429, headers: { 'retry-after': '0' }, body: { e: 'slow' } },
      { status: 200, body: { ok: true } },
    ]);
    const res = await makeRequest<{ ok: boolean }>(
      '/x',
      {},
      { apiKey: 'k', baseUrl: 'https://api.test', fetch },
      baseCtx,
      tinyRetry,
    );
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('retries on 5xx with backoff then succeeds', async () => {
    const { fetch, calls } = mockFetch([
      { status: 502, body: 'bad gateway' },
      { status: 503, body: 'try again' },
      { status: 200, body: { ok: true } },
    ]);
    const res = await makeRequest<{ ok: boolean }>(
      '/x',
      {},
      { apiKey: 'k', baseUrl: 'https://api.test', fetch },
      baseCtx,
      tinyRetry,
    );
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(3);
  });

  it('exhausts retries on persistent 5xx → throws ConnectorError', async () => {
    const { fetch, calls } = mockFetch({ status: 500, body: { err: 'boom' } });
    await expect(
      makeRequest(
        '/x',
        {},
        { apiKey: 'k', baseUrl: 'https://api.test', fetch },
        baseCtx,
        tinyRetry,
      ),
    ).rejects.toBeInstanceOf(ConnectorError);
    expect(calls).toHaveLength(tinyRetry.retries + 1);
  });

  it('throws AuthError immediately on 401 (no retry)', async () => {
    const { fetch, calls } = mockFetch({ status: 401, body: { error: 'nope' } });
    await expect(
      makeRequest(
        '/x',
        {},
        { apiKey: 'k', baseUrl: 'https://api.test', fetch },
        baseCtx,
        tinyRetry,
      ),
    ).rejects.toBeInstanceOf(AuthError);
    expect(calls).toHaveLength(1);
  });

  it('throws AuthError on 403 (no retry)', async () => {
    const { fetch, calls } = mockFetch({ status: 403, body: { error: 'forbidden' } });
    await expect(
      makeRequest(
        '/x',
        {},
        { apiKey: 'k', baseUrl: 'https://api.test', fetch },
        baseCtx,
        tinyRetry,
      ),
    ).rejects.toBeInstanceOf(AuthError);
    expect(calls).toHaveLength(1);
  });

  it('throws NotFoundError on 404', async () => {
    const { fetch } = mockFetch({ status: 404, body: { message: 'missing' } });
    await expect(
      makeRequest(
        '/x',
        {},
        { apiKey: 'k', baseUrl: 'https://api.test', fetch },
        baseCtx,
        tinyRetry,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('throws ValidationError on 422', async () => {
    const { fetch } = mockFetch({
      status: 422,
      body: { errors: ['name is required'] },
    });
    await expect(
      makeRequest(
        '/x',
        {},
        { apiKey: 'k', baseUrl: 'https://api.test', fetch },
        baseCtx,
        tinyRetry,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('throws RateLimitError with parsed retryAfter when retries exhausted', async () => {
    const { fetch } = mockFetch({
      status: 429,
      headers: { 'retry-after': '7' },
      body: { error: 'rate limited' },
    });
    try {
      await makeRequest(
        '/x',
        {},
        { apiKey: 'k', baseUrl: 'https://api.test', fetch },
        baseCtx,
        { ...tinyRetry, retries: 0 },
      );
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitError);
      expect((err as RateLimitError).retryAfter).toBe(7);
    }
  });

  it('sets Content-Type: application/json when body is a plain object', async () => {
    const { fetch, calls } = mockFetch({ status: 200, body: { ok: true } });
    await makeRequest(
      '/x',
      { method: 'POST', body: { foo: 'bar' } },
      { apiKey: 'k', baseUrl: 'https://api.test', fetch },
      baseCtx,
    );
    expect(calls[0]!.headers['content-type']).toBe('application/json');
    expect(calls[0]!.body).toBe(JSON.stringify({ foo: 'bar' }));
  });

  it('serialises query params correctly', async () => {
    const { fetch, calls } = mockFetch({ status: 200, body: {} });
    await makeRequest(
      '/x',
      { query: { a: 1, b: 'two', skip: undefined, also: null } },
      { apiKey: 'k', baseUrl: 'https://api.test', fetch },
      baseCtx,
    );
    expect(calls[0]!.url).toBe('https://api.test/x?a=1&b=two');
  });

  it('joins base + path without double-slashing', async () => {
    const { fetch, calls } = mockFetch({ status: 200, body: {} });
    await makeRequest(
      '/x',
      {},
      { apiKey: 'k', baseUrl: 'https://api.test/', fetch },
      baseCtx,
    );
    expect(calls[0]!.url).toBe('https://api.test/x');
  });
});
