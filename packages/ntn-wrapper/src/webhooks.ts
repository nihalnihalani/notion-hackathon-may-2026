/**
 * Typed wrapper for `ntn webhooks list --json`. Used by Shipper to surface
 * the webhook URL of a newly-deployed Worker (PLAN.md §III).
 */

import { runNtnJson } from './exec';
import type { NtnRunOptions, WebhookEndpoint } from './types';

/**
 * List all webhook endpoints registered for the authenticated user/workspace.
 *
 * Pass `filter.workerName` to narrow client-side — the CLI itself does not
 * always support server-side filtering across versions, so we filter here.
 */
export async function listWebhooks(
  opts: NtnRunOptions & { filter?: { workerName?: string } } = {},
): Promise<WebhookEndpoint[]> {
  const { filter, ...runOpts } = opts;
  const { data } = await runNtnJson<WebhookEndpoint[]>(
    ['webhooks', 'list', '--json'],
    runOpts,
  );
  const workerName = filter?.workerName;
  if (workerName !== undefined) {
    return data.filter((w) => w.workerName === workerName);
  }
  return data;
}
