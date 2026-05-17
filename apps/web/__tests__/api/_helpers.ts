/**
 * Shared helpers for API-route tests.
 *
 * The route handlers are plain `async (req, ctx) => Response` functions, so we
 * can call them directly with a stub Request — no need for next/test or a
 * running server.
 */

import { vi } from 'vitest';

export function makeRequest(
  url: string,
  init: RequestInit & { body?: unknown } = {},
): Request {
  const { body, ...rest } = init;
  return new Request(url, {
    ...rest,
    body: body !== undefined && typeof body !== 'string' ? JSON.stringify(body) : (body as BodyInit | undefined),
    headers: {
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

export function makeCtx<TParams extends Record<string, string> = Record<string, string>>(
  params: TParams,
): { params: Promise<TParams> } {
  return { params: Promise.resolve(params) };
}

/**
 * Stub the Sentry wrapper so the route handlers run inline. We import the
 * actual module path so vitest's module cache invalidation works.
 */
export function stubSentryWrapper(): void {
  vi.mock('@sentry/nextjs', () => ({
    withScope: (fn: (s: { setTag: () => void; addBreadcrumb: () => void }) => unknown) =>
      fn({ setTag: () => undefined, addBreadcrumb: () => undefined }),
    addBreadcrumb: () => undefined,
    captureException: () => undefined,
    captureMessage: () => undefined,
  }));
}

/** Decode a JSON body off a Response. */
export async function readJson<T = unknown>(res: Response | { json: () => Promise<T> }): Promise<T> {
  return (await (res as Response).json()) as T;
}
