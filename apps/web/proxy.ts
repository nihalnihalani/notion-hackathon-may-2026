import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';

/**
 * Forge edge proxy.
 *
 * Wraps every non-static request with Clerk session resolution, but explicitly
 * lets the following route classes through *without* a Clerk session check
 * because they enforce their own authentication scheme:
 *
 *   - /api/webhooks/notion-button     → Notion HMAC signature (NOTION_WEBHOOK_SECRET)
 *   - /api/webhooks/notion-page-edit  → Notion HMAC signature (NOTION_WEBHOOK_SECRET)
 *   - /api/forge/log                  → internal bearer token (FORGE_INTERNAL_TOKEN)
 *   - /api/healthz                    → public liveness probe
 *   - /api/mcp/*                      → API-key auth (per-workspace MCP key)
 *   - /api/billing/usage              → metered-billing webhook signed by Stripe
 *   - /api/monitoring                 → Sentry tunnel (outbound proxy, DSN-validated)
 *
 * Everything else under /api/* and every page route is protected: an
 * unauthenticated request will be redirected to Clerk's sign-in page (pages)
 * or rejected with 401 (API routes).
 *
 * Workspace-binding logic (mapping Clerk user → Notion workspace_id) is layered
 * on by the individual route handlers; this proxy intentionally stays thin so
 * that edge cold-start latency stays minimal.
 *
 * Filename note: this file is `proxy.ts` (not `middleware.ts`). Next.js 16
 * deprecated `middleware.ts` and renamed the file convention to `proxy.ts`
 * (https://nextjs.org/docs/app/api-reference/file-conventions/proxy). The
 * function exported here is still the Clerk middleware adapter — Clerk's
 * adapter API hasn't changed, only the Next file name.
 */
const isPublicRoute = createRouteMatcher([
  '/api/webhooks/notion-button(.*)',
  '/api/webhooks/notion-page-edit(.*)',
  '/api/forge/log(.*)',
  '/api/healthz',
  '/api/mcp(.*)',
  '/api/billing/usage(.*)',
  '/api/monitoring(.*)',
  // Clerk's own sign-in/sign-up routes also need to be public so unauthenticated
  // users can actually reach them.
  '/sign-in(.*)',
  '/sign-up(.*)',
  // Marketing landing page — must be reachable for logged-out visitors.
  '/',
]);

/**
 * Authed onboarding surfaces — explicitly enumerated for clarity even though
 * the catch-all below already protects them. Keeping this list documents the
 * intent so a future "make /onboarding public" PR has to consciously remove
 * the route from here rather than silently flipping behavior.
 *
 * Routes:
 *   - /onboarding/pick-parent  → the page-picker UI
 *   - /api/onboarding/pages    → Notion search proxy used by the picker
 *   - /api/onboarding/install  → installer trigger
 */
const isAuthedOnboardingRoute = createRouteMatcher([
  '/onboarding/(.*)',
  '/api/onboarding/(.*)',
]);

export default clerkMiddleware(async (auth, req) => {
  if (isPublicRoute(req)) {
    return;
  }
  // Onboarding routes must NEVER be matched by `isPublicRoute` — they require
  // a Clerk session to bind the user to their workspace. The check below is
  // a no-op if the route is unrelated; for onboarding routes it forces auth
  // up front so the route handler can safely call `requireWorkspace`.
  if (isAuthedOnboardingRoute(req)) {
    await auth.protect();
    return;
  }
  await auth.protect();
});

export const config = {
  matcher: [
    // Skip Next.js internals and all static files unless found in search params.
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    // Always run for API routes.
    '/(api|trpc)(.*)',
  ],
};
