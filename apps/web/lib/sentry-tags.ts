/**
 * Small, dependency-light Sentry tag helpers.
 *
 * These exist so route handlers / server actions can attach the canonical
 * `route` + `workspace` tags without re-importing `@sentry/nextjs` directly
 * everywhere. Keeping the helpers in one place also means PII rules
 * (e.g., "never tag with the raw email") have a single enforcement point.
 *
 * The helpers are pure: no IO, no env reads. They're safe in Node, Edge,
 * and even the browser bundle (the Sentry SDK is itself isomorphic).
 */

import * as Sentry from '@sentry/nextjs';

import type { ApiHandler } from './sentry';

/**
 * Wrap a route handler so every Sentry event captured inside it (whether
 * via thrown exception or explicit `captureException`) carries
 * `route=<routeName>`. Use this **in addition to** `withSentry` only when
 * you need tagging without the full breadcrumb/error envelope (e.g., from
 * a server action that already handles its own errors).
 *
 * `withSentry` already sets the `route` tag, so wrapping a handler with
 * both is redundant but harmless — the tag is the same value.
 */
export function withRouteTag<TParams = Record<string, string>>(
  handler: ApiHandler<TParams>,
  routeName: string,
): ApiHandler<TParams> {
  return async (req, ctx) => {
    return Sentry.withScope(async (scope) => {
      scope.setTag('route', routeName);
      return handler(req, ctx);
    });
  };
}

/**
 * Set the active Sentry scope's user + workspace tag. Call this from
 * inside a route handler after you've resolved the workspace context so
 * subsequent breadcrumbs and any uncaught exception are tagged with the
 * tenant they happened to.
 *
 * We do NOT pass the user's email here — only the Clerk userId, which is
 * the same identifier we use in PostHog. Emails would force us to enable
 * Sentry's PII handling globally, which we explicitly opt out of in
 * `instrumentation.ts`.
 */
export function addWorkspaceTag(workspaceId: string, userId?: string): void {
  Sentry.getCurrentScope().setTag('workspace', workspaceId);
  if (userId) {
    Sentry.setUser({ id: userId });
  }
}
