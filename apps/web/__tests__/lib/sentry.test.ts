/**
 * Tests for the `withSentry` HOC.
 *
 * What we care about:
 *   - A handler that throws results in `Sentry.captureException` being called
 *     and the returned response is the structured 500 envelope.
 *   - A handler that returns normally sets the `route` tag on the active scope.
 *   - A handler that returns a 5xx response adds a Sentry breadcrumb but does
 *     NOT call `captureException` (we leave that to the caller).
 *
 * We mock `@sentry/nextjs` so the test runs without any DSN/network IO. The
 * mock mirrors the surface area `withSentry` actually uses; if `withSentry`
 * ever reaches for a new method, the mock fails loudly and we update both.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const setTag = vi.fn();
const addBreadcrumb = vi.fn();
const captureException = vi.fn();
const sentryAddBreadcrumb = vi.fn();

vi.mock('@sentry/nextjs', () => ({
  withScope: async (
    fn: (s: { setTag: typeof setTag; addBreadcrumb: typeof addBreadcrumb }) => unknown,
  ) => fn({ setTag, addBreadcrumb }),
  captureException,
  addBreadcrumb: sentryAddBreadcrumb,
}));

describe('withSentry', () => {
  beforeEach(() => {
    vi.resetModules();
    setTag.mockReset();
    addBreadcrumb.mockReset();
    captureException.mockReset();
    sentryAddBreadcrumb.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('tags the active scope with the route name + http method', async () => {
    const { withSentry } = await import('@/lib/sentry');
    const handler = withSentry(
      async () => new Response('ok', { status: 200 }),
      { routeName: 'forge.test' },
    );
    const res = await handler(
      new Request('http://localhost/api/test', { method: 'POST' }) as never,
      { params: Promise.resolve({}) },
    );
    expect(res.status).toBe(200);
    expect(setTag).toHaveBeenCalledWith('route', 'forge.test');
    expect(setTag).toHaveBeenCalledWith('http.method', 'POST');
    // Per-request breadcrumb logged.
    expect(addBreadcrumb).toHaveBeenCalled();
  });

  it('falls back to the pathname when no routeName is supplied', async () => {
    const { withSentry } = await import('@/lib/sentry');
    const handler = withSentry(async () => new Response('ok', { status: 200 }));
    await handler(
      new Request('http://localhost/api/agents/abc', { method: 'GET' }) as never,
      { params: Promise.resolve({}) },
    );
    expect(setTag).toHaveBeenCalledWith('route', '/api/agents/abc');
  });

  it('reports thrown errors to Sentry and returns the internal-error envelope', async () => {
    const { withSentry } = await import('@/lib/sentry');
    const boom = new Error('kaboom');
    const handler = withSentry(
      async () => {
        throw boom;
      },
      { routeName: 'forge.boom' },
    );
    const res = await handler(
      new Request('http://localhost/api/boom', { method: 'POST' }) as never,
      { params: Promise.resolve({}) },
    );
    expect(captureException).toHaveBeenCalledWith(boom);
    expect(res.status).toBe(500);
    const body = (await (res as Response).json()) as { error: string; message: string };
    expect(body.error).toBe('internal');
    expect(body.message).toBe('kaboom');
  });

  it('logs a Sentry breadcrumb (not a capture) for non-throwing 5xx responses', async () => {
    const { withSentry } = await import('@/lib/sentry');
    const handler = withSentry(
      async () => new Response('upstream blew up', { status: 502 }),
      { routeName: 'forge.upstream' },
    );
    const res = await handler(
      new Request('http://localhost/api/x', { method: 'GET' }) as never,
      { params: Promise.resolve({}) },
    );
    expect(res.status).toBe(502);
    // Breadcrumb logged at module level (not via the scope's addBreadcrumb).
    expect(sentryAddBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'api.response',
        level: 'error',
      }),
    );
    expect(captureException).not.toHaveBeenCalled();
  });

  it('does not log the response breadcrumb for 2xx', async () => {
    const { withSentry } = await import('@/lib/sentry');
    const handler = withSentry(
      async () => new Response('ok', { status: 200 }),
    );
    await handler(
      new Request('http://localhost/api/ok') as never,
      { params: Promise.resolve({}) },
    );
    expect(sentryAddBreadcrumb).not.toHaveBeenCalled();
  });
});
