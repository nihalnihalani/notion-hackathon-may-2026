/**
 * Best-effort auth helpers around `ntn doctor`.
 *
 * The CLI does not expose a dedicated "am I logged in?" subcommand, so we
 * derive it from doctor output. This is the same approach `scripts/setup.sh`
 * uses (PLAN.md §III).
 */

import { runDoctor } from './doctor';
import type { NtnRunOptions } from './types';

/**
 * Returns `true` when the CLI considers itself authenticated.
 *
 * Resolves with `false` (never throws) on any other doctor failure mode —
 * callers that need richer signal should call `runDoctor` directly.
 */
export async function isLoggedIn(opts: NtnRunOptions = {}): Promise<boolean> {
  try {
    const report = await runDoctor(opts);
    if (typeof report.loggedIn === 'boolean') {
      return report.loggedIn;
    }
    // Fallback: infer from a check whose name mentions "login" / "auth".
    const authCheck = report.checks.find((c) =>
      /login|auth|token/iu.test(c.name),
    );
    if (authCheck) {
      return authCheck.ok;
    }
    return report.ok;
  } catch {
    return false;
  }
}

/**
 * A user-facing string describing how to log in. Designed to be shown
 * verbatim in the dashboard / Notion Build Log when `isLoggedIn` returns
 * `false`. Intentionally framework-free so it works in CLI, web, and email.
 */
export function loginInstructions(): string {
  return [
    'You are not logged in to the Notion CLI.',
    '',
    '  1. Run `ntn login` in your terminal',
    '  2. Complete the OAuth flow in your browser',
    '  3. Return here and retry',
    '',
    'Docs: https://developers.notion.com/docs/install-ntn-cli',
  ].join('\n');
}
