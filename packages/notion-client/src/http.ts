/**
 * Shared HTTP transport for `@forge/notion-client`.
 *
 * Mirrors the responsibilities of `@forge/connectors/http`:
 *  - Injects `Authorization: Bearer <token>`, `Notion-Version`, `Accept: json`
 *  - Retries on 429 + 5xx with exponential backoff + full jitter
 *  - Honours `Retry-After` headers on 429 (both numeric and HTTP-date)
 *  - Maps status codes to {@link NotionError} subclasses
 *  - Awaits the optional {@link Pacer} before each request so we stay under
 *    Notion's 3 req/sec sustained limit
 *
 * Pure function: no module-level state, no env reads.
 */

import {
  NotionError,
  NotionRateLimitError,
  errorFromNotionStatus,
} from './errors.js';
import {
  DEFAULT_BASE_URL,
  DEFAULT_NOTION_VERSION,
  DEFAULT_RETRY,
  type FetchLike,
  type NotionClientConfig,
  type RetryOptions,
} from './types.js';

export interface NotionRequestInit {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Plain object → JSON-encoded; string passed through. */
  body?: unknown;
  /** Extra headers merged on top of the client defaults. */
  headers?: Record<string, string>;
  /** Search params appended to the URL. */
  query?: Record<string, string | number | boolean | undefined | null>;
  signal?: AbortSignal;
}

function resolveFetch(config: NotionClientConfig): FetchLike {
  if (config.fetch) return config.fetch;
  if (typeof fetch === 'function') return fetch as FetchLike;
  throw new NotionError(
    'No fetch implementation available — pass `fetch` in NotionClientConfig',
    { status: 0, body: null },
  );
}

function buildUrl(
  base: string,
  path: string,
  query?: NotionRequestInit['query'],
): string {
  const joined = path.startsWith('http')
    ? path
    : `${base.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
  if (!query) return joined;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    params.append(k, String(v));
  }
  const qs = params.toString();
  if (!qs) return joined;
  return joined.includes('?') ? `${joined}&${qs}` : `${joined}?${qs}`;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function backoffDelay(
  attempt: number,
  opts: RetryOptions,
  retryAfterSec?: number,
): number {
  if (retryAfterSec !== undefined && Number.isFinite(retryAfterSec)) {
    return Math.min(retryAfterSec * 1000, opts.maxDelayMs);
  }
  const base = Math.min(opts.initialDelayMs * 2 ** attempt, opts.maxDelayMs);
  if (!opts.jitter) return base;
  return Math.floor(Math.random() * base);
}

async function parseBody(res: Response): Promise<unknown> {
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) {
    try {
      return await res.json();
    } catch {
      return null;
    }
  }
  try {
    const text = await res.text();
    return text || null;
  } catch {
    return null;
  }
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const asNum = Number(header);
  if (Number.isFinite(asNum)) return asNum;
  const date = Date.parse(header);
  if (Number.isFinite(date)) {
    return Math.max(0, (date - Date.now()) / 1000);
  }
  return undefined;
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/**
 * Issue a single Notion REST request with auth + retry + typed error mapping.
 *
 * Returns the parsed JSON body cast to `T`. Schema validation (when desired)
 * is layered on at the resource level — this transport stays untyped against
 * the wire format so it can serve every endpoint uniformly.
 */
export async function notionRequest<T>(
  path: string,
  init: NotionRequestInit,
  config: NotionClientConfig,
  retryOverride?: Partial<RetryOptions>,
): Promise<T> {
  const fetchImpl = resolveFetch(config);
  const base = config.baseUrl ?? DEFAULT_BASE_URL;
  const url = buildUrl(base, path, init.query);
  const retry: RetryOptions = { ...DEFAULT_RETRY, ...retryOverride };

  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.token}`,
    'Notion-Version': config.notionVersion ?? DEFAULT_NOTION_VERSION,
    Accept: 'application/json',
    ...init.headers,
  };

  let body: BodyInit | undefined;
  if (init.body !== undefined && init.body !== null) {
    if (
      typeof init.body === 'string' ||
      init.body instanceof ArrayBuffer ||
      init.body instanceof Uint8Array ||
      init.body instanceof FormData ||
      init.body instanceof URLSearchParams
    ) {
      body = init.body as BodyInit;
    } else {
      body = JSON.stringify(init.body);
      if (!('content-type' in headers) && !('Content-Type' in headers)) {
        headers['Content-Type'] = 'application/json';
      }
    }
  }

  const requestInit: RequestInit = {
    method: init.method ?? 'GET',
    headers,
    ...(body === undefined ? {} : { body }),
    ...(init.signal === undefined ? {} : { signal: init.signal }),
  };

  let lastError: NotionError | undefined;

  for (let attempt = 0; attempt <= retry.retries; attempt++) {
    // Pace **before** every attempt — retries count against the rate budget
    // too, otherwise a burst of 429s would punch through the limiter.
    if (config.pacer) {
      await config.pacer.acquire();
    }

    let res: Response;
    try {
      res = await fetchImpl(url, requestInit);
    } catch (error) {
      lastError = new NotionError(
        `notion network error: ${(error as Error).message}`,
        { status: 0, body: null, cause: error },
      );
      if (attempt === retry.retries) throw lastError;
      await delay(backoffDelay(attempt, retry), init.signal);
      continue;
    }

    if (res.ok) {
      if (res.status === 204) return null as T;
      return (await parseBody(res)) as T;
    }

    const parsed = await parseBody(res);
    const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
    const err = errorFromNotionStatus({
      status: res.status,
      body: parsed,
      ...(retryAfter === undefined ? {} : { retryAfter }),
    });

    config.logger?.warn?.('notion request failed', {
      status: res.status,
      url,
      attempt,
      code: err.code,
    });

    if (!isRetryableStatus(res.status) || attempt === retry.retries) {
      throw err;
    }

    lastError = err;
    const wait =
      err instanceof NotionRateLimitError
        ? backoffDelay(attempt, retry, err.retryAfter)
        : backoffDelay(attempt, retry);
    await delay(wait, init.signal);
  }

  throw (
    lastError ??
    new NotionError('Unknown retry-loop failure', { status: 0, body: null })
  );
}
