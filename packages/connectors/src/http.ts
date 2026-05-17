/**
 * Shared HTTP helper used by every connector.
 *
 * Responsibilities:
 *  - Inject auth header (caller supplies the scheme — Bearer / Basic / etc.)
 *  - Retry on 429 + 5xx with exponential backoff + optional jitter
 *  - Honour `Retry-After` headers on 429 when present
 *  - Map non-2xx → typed {@link ConnectorError} subclasses
 *  - Parse JSON when content-type is JSON; otherwise return text cast to T
 *
 * Pure function: no module-level state, no env reads.
 */

import { errorFromStatus, ConnectorError, RateLimitError } from './errors.js';
import { type ConnectorConfig, type FetchLike, type RetryOptions, DEFAULT_RETRY } from './types.js';

export interface MakeRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Plain object → JSON-encoded; string passed through; FormData passed through. */
  body?: unknown;
  /** Extra headers merged on top of the connector's defaults. */
  headers?: Record<string, string>;
  /** Search params appended to the URL. */
  query?: Record<string, string | number | boolean | undefined | null>;
  signal?: AbortSignal;
}

export interface HttpClientContext {
  /** Provider name used in error messages (e.g. "github"). */
  provider: string;
  /** Header name + value to inject for auth (e.g. {name:'Authorization', value:'Bearer …'}). */
  authHeader: { name: string; value: string };
  /** Additional headers applied to every request (e.g. Accept, User-Agent). */
  defaultHeaders?: Record<string, string>;
}

/**
 * Build the per-connector context once at factory time so the hot path stays cheap.
 */
export function buildContext(args: {
  provider: string;
  authHeaderName?: string;
  authScheme: 'Bearer' | 'Basic' | 'Raw' | 'Token';
  config: ConnectorConfig;
  defaultHeaders?: Record<string, string>;
}): HttpClientContext {
  const name = args.authHeaderName ?? 'Authorization';
  const value =
    args.authScheme === 'Raw' ? args.config.apiKey : `${args.authScheme} ${args.config.apiKey}`;
  return {
    provider: args.provider,
    authHeader: { name, value },
    ...(args.defaultHeaders === undefined ? {} : { defaultHeaders: args.defaultHeaders }),
  };
}

function resolveFetch(config: ConnectorConfig): FetchLike {
  if (config.fetch) return config.fetch;
  if (typeof fetch === 'function') return fetch as FetchLike;
  throw new ConnectorError('No fetch implementation available — pass `fetch` in config', {
    status: 0,
    body: null,
    provider: 'connectors',
  });
}

function buildUrl(base: string, path: string, query?: MakeRequestOptions['query']): string {
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

function backoffDelay(attempt: number, opts: RetryOptions, retryAfterSec?: number): number {
  if (retryAfterSec !== undefined && Number.isFinite(retryAfterSec)) {
    return Math.min(retryAfterSec * 1000, opts.maxDelayMs);
  }
  const base = Math.min(opts.initialDelayMs * 2 ** attempt, opts.maxDelayMs);
  if (!opts.jitter) return base;
  // Full jitter: random in [0, base]. Avoids retry storms.
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
  // Best-effort text fallback so error bodies are still inspectable.
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
 * Issue a request with auth + retry + typed error mapping.
 *
 * Returns the parsed JSON body cast to `T`. Callers may layer schema
 * validation on top by passing `{validate: true}` at the connector method
 * level — see each method's implementation.
 */
export async function makeRequest<T>(
  path: string,
  opts: MakeRequestOptions,
  config: ConnectorConfig,
  ctx: HttpClientContext,
  retryOverride?: Partial<RetryOptions>,
): Promise<T> {
  const fetchImpl = resolveFetch(config);
  const base = config.baseUrl ?? '';
  const url = buildUrl(base, path, opts.query);
  const retry: RetryOptions = { ...DEFAULT_RETRY, ...retryOverride };

  const headers: Record<string, string> = {
    ...ctx.defaultHeaders,
    [ctx.authHeader.name]: ctx.authHeader.value,
    ...opts.headers,
  };

  let body: BodyInit | undefined;
  if (opts.body !== undefined && opts.body !== null) {
    if (
      typeof opts.body === 'string' ||
      opts.body instanceof ArrayBuffer ||
      opts.body instanceof Uint8Array ||
      opts.body instanceof FormData ||
      opts.body instanceof URLSearchParams
    ) {
      body = opts.body as BodyInit;
    } else {
      body = JSON.stringify(opts.body);
      if (!('content-type' in headers) && !('Content-Type' in headers)) {
        headers['Content-Type'] = 'application/json';
      }
    }
  }

  const init: RequestInit = {
    method: opts.method ?? 'GET',
    headers,
    ...(body === undefined ? {} : { body }),
    ...(opts.signal === undefined ? {} : { signal: opts.signal }),
  };

  let lastError: ConnectorError | undefined;

  for (let attempt = 0; attempt <= retry.retries; attempt++) {
    let res: Response;
    try {
      res = await fetchImpl(url, init);
    } catch (error) {
      // Network error — treat as retryable up to the limit.
      lastError = new ConnectorError(`${ctx.provider} network error: ${(error as Error).message}`, {
        status: 0,
        body: null,
        provider: ctx.provider,
        cause: error,
      });
      if (attempt === retry.retries) throw lastError;
      await delay(backoffDelay(attempt, retry), opts.signal);
      continue;
    }

    if (res.ok) {
      // 204 No Content — return null cast to T (caller's type contract).
      if (res.status === 204) return null as T;
      return (await parseBody(res)) as T;
    }

    const parsed = await parseBody(res);
    const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
    const err = errorFromStatus({
      status: res.status,
      body: parsed,
      provider: ctx.provider,
      ...(retryAfter === undefined ? {} : { retryAfter }),
    });

    if (!isRetryableStatus(res.status) || attempt === retry.retries) {
      throw err;
    }

    lastError = err;
    const wait =
      err instanceof RateLimitError
        ? backoffDelay(attempt, retry, err.retryAfter)
        : backoffDelay(attempt, retry);
    await delay(wait, opts.signal);
  }

  // Unreachable in practice — the loop either returns or throws.
  throw (
    lastError ??
    new ConnectorError('Unknown retry-loop failure', {
      status: 0,
      body: null,
      provider: ctx.provider,
    })
  );
}
