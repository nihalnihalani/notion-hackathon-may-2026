/**
 * Test helpers — mock fetch builder + assertion utilities for notion-client.
 *
 * Mirrors `packages/connectors/test/helpers.ts` so the test surface feels
 * familiar between packages. Kept local (rather than imported) so this
 * package has no test-time dep on connectors.
 */

import type { FetchLike } from '../src/types.js';

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

export interface MockResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/**
 * Build a mock fetch that returns the supplied responses in order. After the
 * queue is exhausted, the LAST response is reused (useful for retry-storm
 * tests where every attempt should see the same 5xx).
 */
export function mockFetch(responses: MockResponse | MockResponse[]): {
  fetch: FetchLike;
  calls: RecordedCall[];
} {
  const queue = Array.isArray(responses) ? [...responses] : [responses];
  const calls: RecordedCall[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const headerObj: Record<string, string> = {};
    const h = init?.headers;
    if (h) {
      if (h instanceof Headers) {
        h.forEach((v, k) => {
          headerObj[k.toLowerCase()] = v;
        });
      } else if (Array.isArray(h)) {
        for (const [k, v] of h) headerObj[k.toLowerCase()] = v;
      } else {
        for (const [k, v] of Object.entries(h as Record<string, string>)) {
          headerObj[k.toLowerCase()] = v;
        }
      }
    }
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      headers: headerObj,
      body:
        typeof init?.body === 'string'
          ? init.body
          : init?.body == null
            ? null
            : init.body instanceof URLSearchParams
              ? init.body.toString()
              : '<binary>',
    });
    const next: MockResponse =
      queue.length > 1 ? queue.shift()! : queue[0] ?? { status: 200 };
    const status = next.status ?? 200;
    const headers = new Headers(next.headers ?? {});
    let bodyInit: BodyInit | null = null;
    if (next.body !== undefined && next.body !== null) {
      if (typeof next.body === 'string') {
        bodyInit = next.body;
      } else {
        bodyInit = JSON.stringify(next.body);
        if (!headers.has('content-type')) {
          headers.set('content-type', 'application/json');
        }
      }
    }
    return new Response(bodyInit, { status, headers });
  };
  return { fetch: fetchImpl, calls };
}
