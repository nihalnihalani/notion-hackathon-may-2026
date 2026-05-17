/**
 * Default network allowlist for generated Notion Workers.
 *
 * This is the floor — the Inspector MAY extend it per generated agent based
 * on the OAuth providers the user has connected (e.g. add `api.github.com`
 * when a GitHub-reading agent is being generated).
 *
 * Notion API hosts are the only universal entries.
 */
export const DEFAULT_NETWORK_ALLOWLIST: readonly string[] = Object.freeze([
  'api.notion.com',
  'www.notion.so',
  'file.notion.so',
  'files.notion.so',
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
