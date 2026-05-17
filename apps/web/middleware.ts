import { clerkMiddleware } from '@clerk/nextjs/server';

/**
 * Forge edge middleware.
 *
 * Wraps every non-static, non-API-internal request with Clerk session resolution.
 * Workspace-binding logic (mapping Clerk user → Notion workspace_id) is layered on
 * by the route handlers that need it; this file intentionally stays thin so that
 * middleware cold-start latency stays minimal.
 */
export default clerkMiddleware();

export const config = {
  matcher: [
    // Skip Next.js internals and all static files unless found in search params.
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    // Always run for API routes.
    '/(api|trpc)(.*)',
  ],
};
