/**
 * Worker name derivation + validation.
 *
 * The `worker-name` is the user-visible handle that `ntn workers deploy` uses
 * to address the Worker. PLAN.md §III pins the format `forge-<slug>-<hash6>`:
 *
 *  - `forge-` prefix scopes the namespace so Forge-generated Workers don't
 *    collide with hand-rolled ones in the same workspace.
 *  - `<slug>` is derived from the description so the name is human-greppable
 *    in the Notion Build Log.
 *  - `<hash6>` is the first 6 hex chars of `sha256(description)` so the same
 *    input deterministically maps to the same Worker name across retries.
 *    Two identical descriptions yield the same name — re-generation is
 *    therefore an idempotent upsert from the Shipper's point of view.
 *
 * Pure functions only — no IO, no module-level state. Safe in any runtime.
 */

import { createHash } from 'node:crypto';

const PREFIX = 'forge-';
const HASH_LENGTH = 6;
const MAX_TOTAL_LENGTH = 63; // matches ntn workers naming cap
// "forge-" (6) + slug + "-" (1) + 6-char hash → slug max
const MAX_SLUG_LENGTH = MAX_TOTAL_LENGTH - PREFIX.length - 1 - HASH_LENGTH;

/**
 * Strict format the Shipper enforces after the fact and the orchestrator
 * uses to recognize Forge-owned Workers.
 *
 * Slug portion: 1..40 chars of `[a-z0-9-]`. Trailing `-` is forbidden by
 * `slugify` so the regex can stay simple.
 */
const NAME_PATTERN = /^forge-[a-z0-9-]{1,40}-[a-f0-9]{6}$/u;

/**
 * Derive a deterministic, ntn-safe Worker name from the description.
 *
 * The slug step is deliberately conservative:
 *
 *  - Lowercase ASCII letters + digits survive.
 *  - All other characters collapse into a single `-`.
 *  - Leading/trailing hyphens are stripped.
 *  - Empty slugs fall back to `agent` (still deterministic via the hash).
 *
 * Hash uses sha256(description) — NOT the slug — so two descriptions that
 * happen to slugify identically still get distinct names.
 */
export function deriveWorkerName(description: string): string {
  const normalized = description.normalize('NFKD').toLowerCase();
  const slug = slugify(normalized).slice(0, MAX_SLUG_LENGTH) || 'agent';
  const hash = createHash('sha256').update(description, 'utf8').digest('hex').slice(0, HASH_LENGTH);
  return `${PREFIX}${slug}-${hash}`;
}

/**
 * Validate a Worker name matches the format produced by `deriveWorkerName`.
 *
 * The Shipper calls this before submitting to `ntn workers deploy` — if the
 * orchestrator hand-rewrites a name (e.g. for a manual override) and gets the
 * format wrong, we fail-fast at the Forge boundary instead of leaking a bad
 * name into the ntn CLI.
 */
export function validateWorkerName(name: string): boolean {
  return NAME_PATTERN.test(name);
}

/** Strip diacritics + collapse non-alphanumeric runs into hyphens. */
function slugify(input: string): string {
  // Remove combining marks left over from NFKD normalization.
  const stripped = input.replaceAll(/\p{M}+/gu, '');
  // Map any non-[a-z0-9] run to a single hyphen.
  const collapsed = stripped.replaceAll(/[^a-z0-9]+/gu, '-');
  // Trim leading/trailing hyphens — those would break NAME_PATTERN.
  return collapsed.replaceAll(/^-+|-+$/gu, '');
}
