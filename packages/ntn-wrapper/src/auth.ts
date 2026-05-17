/**
 * Best-effort auth helpers around `ntn doctor` and the `NOTION_API_TOKEN`
 * environment variable.
 *
 * The CLI does not expose a dedicated "am I logged in?" subcommand, so we
 * derive it from doctor output. This is the same approach `scripts/setup.sh`
 * uses (PLAN.md §III). When `NOTION_API_TOKEN` is set in the caller-supplied
 * env we short-circuit — the skill at `.agents/skills/notion-cli/SKILL.md`
 * says to prefer the env-var path because the CLI uses it automatically and
 * it works in non-interactive contexts (CI, Vercel Sandbox).
 */

import { runDoctor } from './doctor';
import type { NtnRunOptions } from './types';

/**
 * Returns `true` when `env.NOTION_API_TOKEN` is a non-empty string.
 *
 * Library code never reads `process.env` directly — callers pass the env via
 * {@link NtnRunOptions.env} (or build their own subset) so wrappers stay
 * deterministic and unit-testable.
 */
export function hasApiToken(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  const token = env['NOTION_API_TOKEN'];
  return typeof token === 'string' && token.trim().length > 0;
}

/**
 * Returns `true` when the CLI considers itself authenticated.
 *
 * Fast path: when `opts.env?.NOTION_API_TOKEN` is non-empty, return `true`
 * immediately without spawning `ntn doctor`. The skill documents that the
 * CLI uses the env var automatically, and this avoids a doctor round-trip in
 * CI / Vercel Sandbox where interactive login is impossible anyway.
 *
 * Resolves with `false` (never throws) on any other doctor failure mode —
 * callers that need richer signal should call `runDoctor` directly.
 */
export async function isLoggedIn(opts: NtnRunOptions = {}): Promise<boolean> {
  if (opts.env !== undefined && hasApiToken(opts.env)) {
    return true;
  }
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
 *
 * Mentions both auth surfaces — the `NOTION_API_TOKEN` env var (preferred for
 * CI / Vercel Sandbox / any non-interactive context) and the interactive
 * `ntn login` OAuth flow — per `.agents/skills/notion-cli/SKILL.md`.
 */
export function loginInstructions(): string {
  return [
    'You are not logged in to the Notion CLI.',
    '',
    'Option A — set NOTION_API_TOKEN (recommended for CI, Vercel Sandbox,',
    'and any non-interactive environment):',
    '',
    '  1. Create an integration at https://www.notion.so/profile/integrations',
    '  2. Copy the internal integration token (`secret_…`)',
    '  3. Export it as `NOTION_API_TOKEN` in your environment and retry',
    '',
    'Option B — interactive OAuth via `ntn login`:',
    '',
    '  1. Run `ntn login` in your terminal',
    '  2. Complete the OAuth flow in your browser',
    '  3. Return here and retry',
    '',
    'Docs: https://developers.notion.com/docs/install-ntn-cli',
  ].join('\n');
}
