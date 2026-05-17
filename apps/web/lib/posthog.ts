/**
 * Server-side PostHog client wrapper.
 *
 * Single PostHog client per Node instance — `posthog-node` flushes events in
 * batches, so re-creating it per-request would lose events on cold start.
 *
 * Callers should use the named helpers (`capture`, `captureWorkspaceEvent`)
 * rather than reaching at the raw client; this keeps PII filtering centralized
 * and makes it trivial to stub in tests.
 *
 * We never call `posthog.identify` for end users — analytics IDs are the Clerk
 * userId only, and we attach `$set` properties (workspace id) on each event.
 */

import { PostHog } from 'posthog-node';

let client: PostHog | null = null;

function getClient(): PostHog | null {
  if (client) return client;
  const key = process.env['POSTHOG_KEY'];
  if (!key) return null;
  client = new PostHog(key, {
    host: process.env['POSTHOG_HOST'] ?? 'https://us.i.posthog.com',
    // Flush quickly — serverless workers may be killed within a few seconds of
    // returning. flushAt=1 ensures every event hits the wire immediately.
    flushAt: 1,
    flushInterval: 0,
  });
  return client;
}

export interface CaptureParams {
  /** Stable identifier — Clerk userId or workspace id. */
  distinctId: string;
  event: string;
  properties?: Record<string, unknown>;
  /** Optional workspace id; attached as `workspace_id` group identifier. */
  workspaceId?: string;
}

/**
 * Capture a single event. Swallows errors — analytics must never fail a
 * user-facing request. The error still surfaces via Sentry breadcrumbs.
 */
export async function capture(params: CaptureParams): Promise<void> {
  const ph = getClient();
  if (!ph) return;
  try {
    ph.capture({
      distinctId: params.distinctId,
      event: params.event,
      properties: params.properties ?? {},
      ...(params.workspaceId && {
        groups: { workspace: params.workspaceId },
      }),
    });
  } catch {
    // Intentionally silent — see module doc comment.
  }
}

/**
 * Convenience wrapper that always uses the workspace id as the distinct id.
 * Use this for system events (e.g. `workflow.completed`) where there's no
 * human acting on the request.
 */
export async function captureWorkspaceEvent(
  workspaceId: string,
  event: string,
  properties?: Record<string, unknown>,
): Promise<void> {
  await capture({
    distinctId: workspaceId,
    event,
    workspaceId,
    ...(properties ? { properties } : {}),
  });
}
