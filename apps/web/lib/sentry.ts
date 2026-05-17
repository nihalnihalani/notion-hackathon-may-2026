/**
 * Sentry wrapper for Next.js route handlers.
 *
 * Every API route is wrapped with {@link withSentry} so that uncaught errors
 * surface as Sentry events with the request method/path attached. The wrapper
 * also captures a structured `api.request` breadcrumb on every invocation,
 * giving us a low-cardinality trail in Sentry's "Crumb Trail" for the failing
 * request even when no exception is thrown (useful when a route returns 500
 * via {@link apiError}).
 *
 * Why `withScope` instead of `runWithAsyncContext`? Route handlers in Next.js
 * 16 already run inside a per-request async context (the App Router boundary),
 * so we only need a scoped enrichment for tags + breadcrumbs. The scope is
 * popped when the wrapper returns, leaving no leakage between concurrent
 * requests on the same worker.
 *
 * On thrown errors we re-throw after capturing so Next.js's default handler
 * still produces a 500. Callers that want to customize the user-facing body
 * should catch internally and use {@link apiError}.
 */

import * as Sentry from '@sentry/nextjs';
import type { NextRequest, NextResponse } from 'next/server';

import { apiError } from './errors';

export interface ApiRouteContext<TParams = Record<string, string>> {
  params: Promise<TParams>;
}

export type ApiHandler<TParams = Record<string, string>> = (
  req: NextRequest,
  ctx: ApiRouteContext<TParams>,
) => Promise<NextResponse | Response>;

interface WithSentryOptions {
  /**
   * Logical route name for Sentry transactions / breadcrumbs. Defaults to the
   * request pathname; pass this when the path contains an `[id]` segment so
   * Sentry aggregates them as one operation.
   */
  routeName?: string;
}

/**
 * Wrap a Next.js App Router handler with Sentry scope + breadcrumb + uniform
 * error fallback. The wrapped function preserves the original handler's type
 * signature so `params` typing flows through to the caller.
 *
 * @example
 *   export const POST = withSentry(async (req) => {
 *     // …
 *     return NextResponse.json({ ok: true });
 *   }, { routeName: 'forge.trigger' });
 */
export function withSentry<TParams = Record<string, string>>(
  handler: ApiHandler<TParams>,
  options: WithSentryOptions = {},
): ApiHandler<TParams> {
  return async (req, ctx) => {
    let response: NextResponse | Response;
    try {
      response = await Sentry.withScope(async (scope) => {
        const url = new URL(req.url);
        const routeName = options.routeName ?? url.pathname;
        scope.setTag('route', routeName);
        scope.setTag('http.method', req.method);
        scope.addBreadcrumb({
          category: 'api.request',
          level: 'info',
          message: `${req.method} ${routeName}`,
          data: { query: url.search },
        });
        return handler(req, ctx);
      });
    } catch (error) {
      Sentry.captureException(error);
      const message = error instanceof Error ? error.message : 'unexpected_internal_error';
      return apiError('internal', message);
    }

    // 5xx responses produced without throwing still get a Sentry breadcrumb so
    // the next captureException upstream has full context.
    if (response.status >= 500) {
      Sentry.addBreadcrumb({
        category: 'api.response',
        level: 'error',
        message: `status=${response.status}`,
      });
    }
    return response;
  };
}

/** Helper so route handlers can re-export the error body type without two imports. */

export { type ApiErrorBody } from './errors';
