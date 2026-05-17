/**
 * Server-side PostHog client used by the workflow finalize step + every
 * sub-agent (Schema Smith, Tool Coder, Inspector, Shipper) when they need
 * to emit a tenant-scoped analytics event from Node.
 *
 * Design notes
 * ─────────────
 *   - Singleton per Node process: `posthog-node` batches events on a
 *     background timer; constructing a new client per request would lose
 *     the buffer between invocations on a serverless function.
 *   - `flushAt: 1` + `flushInterval: 0`: serverless workers can be killed
 *     within a couple of seconds of returning, so we flush every event
 *     immediately. This trades a bit of throughput for delivery guarantees.
 *   - `captureEvent` always swallows errors. Analytics is **never** allowed
 *     to fail a user-facing request — Sentry is the place for errors.
 *   - We listen on `beforeExit` so that long-running Node processes
 *     (workflow workers, MCP server) drain the buffer before exiting.
 *
 * The event-name registry is documented in `apps/web/lib/posthog.ts`. New
 * events MUST be added there before they're emitted from anywhere.
 */

import { PostHog } from 'posthog-node';

let client: PostHog | null = null;
let shutdownHooked = false;

/**
 * Lazily construct the PostHog client. Returns `null` if `POSTHOG_KEY` is
 * unset so dev environments without analytics configured work transparently.
 */
function getClient(): PostHog | null {
  if (client) return client;
  const key = process.env['POSTHOG_KEY'];
  if (!key) return null;

  client = new PostHog(key, {
    host: process.env['POSTHOG_HOST'] ?? 'https://us.i.posthog.com',
    flushAt: 1,
    flushInterval: 0,
  });

  if (!shutdownHooked) {
    shutdownHooked = true;
    // `beforeExit` fires when the event loop is empty — perfect window to
    // drain queued events before the process is recycled. We don't await
    // here; `process.on` callbacks can be async but Node won't keep the
    // loop alive waiting for them.
    process.on('beforeExit', () => {
      // `shutdown()` is idempotent and resolves once the queue is drained.
      void client?.shutdown().catch(() => {
        // Drain failures are unrecoverable at this point; swallow so we
        // don't crash the process on the way out.
      });
    });
  }

  return client;
}

export interface CaptureEventParams {
  /**
   * Who the event belongs to. Required.
   *   - User-initiated events  → Clerk userId
   *   - System / workflow events → workspaceId (also pass as `workspaceId`)
   */
  userId: string;
  /**
   * Workspace this event belongs to. Always attached as the
   * `workspace` group identifier so PostHog funnels can be sliced per
   * tenant. Optional only for global / pre-workspace events (rare).
   */
  workspaceId?: string;
  /** Canonical event name; see `posthog.ts` for the registry. */
  event: string;
  /** Arbitrary structured properties. Must be JSON-serialisable. */
  properties?: Record<string, unknown>;
}

/**
 * Capture a single PostHog event. Swallows all errors — analytics must
 * never break the request path.
 */
export function captureEvent(params: CaptureEventParams): void {
  const ph = getClient();
  if (!ph) return;
  try {
    ph.capture({
      distinctId: params.userId,
      event: params.event,
      properties: params.properties ?? {},
      ...(params.workspaceId && {
        groups: { workspace: params.workspaceId },
      }),
    });
  } catch {
    // See module doc comment.
  }
}

/**
 * Flush the in-memory queue. Call from request handlers that are about to
 * return on serverless platforms where `beforeExit` won't fire reliably
 * (e.g., Vercel cuts the function the moment a Response resolves).
 *
 * Safe to call when PostHog isn't configured — it's a no-op.
 */
export async function flushEvents(): Promise<void> {
  const ph = getClient();
  if (!ph) return;
  try {
    await ph.flush();
  } catch {
    // See module doc comment.
  }
}

/**
 * Test-only hook: reset the singleton so `vi.resetModules()` produces a
 * fresh client. Not exported through the package's public surface.
 */
export function __resetForTests(): void {
  client = null;
  shutdownHooked = false;
}
