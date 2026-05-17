/**
 * Typed wrappers for `ntn oauth ...` (platform-managed OAuth flows for
 * third-party providers like GitHub, Linear, Stripe, Slack, Google).
 *
 * Solves the chicken-and-egg called out in PLAN.md §III note on `oauth start`.
 */

import { runNtn } from './exec';
import { NtnInvalidArgumentError } from './errors';
import { extractDeployUrl } from './parsers';
import type { NtnRunOptions, NtnRunResult, OAuthProvider } from './types';

const PROVIDER_REGEX = /^[a-z][a-z0-9_-]{0,63}$/u;

function assertProvider(provider: string): void {
  if (!PROVIDER_REGEX.test(provider)) {
    throw new NtnInvalidArgumentError(
      `Invalid OAuth provider: "${provider}". Must be lowercase a-z0-9_-.`,
    );
  }
}

/**
 * Start an OAuth flow: `ntn oauth start <provider>`.
 *
 * Returns the raw run result plus the redirect URL extracted from stdout
 * (the user follows that URL in a browser to grant access).
 */
export async function startProviderOAuth(
  provider: OAuthProvider,
  opts: NtnRunOptions = {},
): Promise<{ result: NtnRunResult; redirectUrl: string | undefined }> {
  assertProvider(provider);
  const result = await runNtn(['oauth', 'start', provider], opts);
  return {
    result,
    redirectUrl: extractDeployUrl(result.stdout),
  };
}

/**
 * Read the OAuth access token for a provider: `ntn oauth token <provider>`.
 *
 * Returns the bare token string (CLI prints the token on stdout). Tokens
 * MUST be treated as secrets — never log them, never send them to the
 * client. The caller forwards them into the Worker env via `setEnv`.
 */
export async function getProviderToken(
  provider: OAuthProvider,
  opts: NtnRunOptions = {},
): Promise<string> {
  assertProvider(provider);
  const result = await runNtn(['oauth', 'token', provider], opts);
  const token = result.stdout.trim();
  if (token.length === 0) {
    throw new NtnInvalidArgumentError(
      `ntn oauth token ${provider} returned empty output.`,
    );
  }
  return token;
}

/**
 * Get the redirect URL to display to the user when configuring an OAuth app
 * on the provider side: `ntn oauth show-redirect-url <provider>`.
 *
 * Surfaced as a callout block in the generated agent's Notion DB row
 * (PLAN.md §III).
 */
export async function getProviderRedirectUrl(
  provider: OAuthProvider,
  opts: NtnRunOptions = {},
): Promise<string> {
  assertProvider(provider);
  const result = await runNtn(
    ['oauth', 'show-redirect-url', provider],
    opts,
  );
  // The CLI typically prints just the URL; be tolerant of leading text.
  const trimmed = result.stdout.trim();
  const extracted = extractDeployUrl(trimmed);
  return extracted ?? trimmed;
}
