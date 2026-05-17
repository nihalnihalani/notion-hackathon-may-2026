/**
 * Default network allowlist for generated Notion Workers.
 *
 * This is the floor — the Inspector MAY further constrain it per-agent
 * based on which providers the user actually granted (e.g. drop GitHub
 * for a Linear-only agent). It is NOT extended per agent: every host any
 * supported connector might legitimately reach must already be listed
 * here, otherwise the safety scanner's `no-non-allowlisted-network` rule
 * blocks the generation.
 *
 * Wildcards: entries beginning with `*.` match any single-level subdomain.
 * Scanner implementations should treat that prefix as glob, not regex.
 *
 * Each entry is annotated with the connector or platform that needs it.
 * Adding to this list is a security-review item — every additional host
 * widens the data-exfiltration surface for a generated worker.
 */
export const DEFAULT_NETWORK_ALLOWLIST: readonly string[] = Object.freeze([
  // ── Notion (always implicit; the worker host) ─────────────────────────
  'api.notion.com', // Notion REST API
  'www.notion.so', // OAuth + public deep-links
  'file.notion.so', // hosted file downloads
  'files.notion.so', // hosted file uploads (newer endpoint)

  // ── First-party connectors (packages/connectors/*) ────────────────────
  'api.github.com', // @forge/connectors/github
  'api.linear.app', // @forge/connectors/linear
  'api.stripe.com', // @forge/connectors/stripe
  'slack.com', // @forge/connectors/slack (web API root)
  '*.slack.com', // @forge/connectors/slack (workspace subdomains)
  'googleapis.com', // @forge/connectors/google (catch-all)
  'gmail.googleapis.com', // @forge/connectors/google (gmail subhost)
  'calendar-pa.clients6.google.com', // @forge/connectors/google (calendar)
  'sentry.io', // @forge/connectors/sentry
  '*.sentry.io', // @forge/connectors/sentry (region/org subdomains)
  'api.vercel.com', // @forge/connectors/vercel
  'api.anthropic.com', // @forge/connectors/anthropic
  'api.openai.com', // @forge/connectors/openai
  'api.minimax.io', // @forge/connectors/minimax (intl)
  'api.minimax.chat', // @forge/connectors/minimax (legacy / CN)
]);

/**
 * Default dependency allowlist for generated Worker `package.json`.
 *
 * Anything outside this list rejected at scan time. The list mirrors
 * PLAN.md §IX — adding to it requires a security review.
 */
export const DEFAULT_DEP_ALLOWLIST: readonly string[] = Object.freeze([
  '@notionhq/client',
  '@notion/workers-sdk',
  'zod',
  'date-fns',
]);
