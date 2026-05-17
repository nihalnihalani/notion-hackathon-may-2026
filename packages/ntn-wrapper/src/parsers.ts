/**
 * Tolerant parsers for `ntn` CLI output.
 *
 * The CLI mixes human-friendly banners with structured payloads. For
 * `--json` calls we try strict parse first, then fall back to extracting
 * the first balanced JSON object/array in stdout (the CLI sometimes prints
 * a "Logged in as ..." preamble even with `--json`).
 */

import { NtnJsonParseError } from './errors';

/**
 * Parse JSON output from a `--json` ntn call. Throws `NtnJsonParseError` on
 * failure, including the original args + stdout for debugging.
 *
 * Implementation:
 *   1. Try `JSON.parse(stdout.trim())`.
 *   2. Fallback: locate the first `{` or `[`, scan to its matching close,
 *      parse that slice. Handles leading banners/preambles.
 */
// Generic T is a caller-owned decode shape; JSON parsing itself returns unknown.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
export function parseNtnJson<T>(stdout: string, args: readonly string[]): T {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    throw new NtnJsonParseError({
      args,
      stdout,
      cause: new Error('stdout is empty'),
    });
  }

  // Fast path.
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    // fall through to slice-and-retry
  }

  const slice = findJsonSlice(trimmed);
  if (slice === null) {
    throw new NtnJsonParseError({
      args,
      stdout,
      cause: new Error('no JSON object or array found in stdout'),
    });
  }

  try {
    return JSON.parse(slice) as T;
  } catch (error) {
    throw new NtnJsonParseError({ args, stdout, cause: error });
  }
}

/**
 * Find the first balanced `{...}` or `[...]` slice in `text`.
 *
 * This is a small character-state scanner that respects string literals so
 * braces inside strings don't break balance counting. Returns `null` if
 * nothing balanced is found.
 *
 * Not a full JSON validator — `JSON.parse` does the final validation. This
 * just locates a candidate substring.
 */
export function findJsonSlice(text: string): string | null {
  const openIdx = findFirstOf(text, ['{', '[']);
  if (openIdx === -1) {
    return null;
  }
  const open = text[openIdx];
  const close = open === '{' ? '}' : ']';

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (ch === open) {
      depth++;
    } else if (ch === close) {
      depth--;
      if (depth === 0) {
        return text.slice(openIdx, i + 1);
      }
    }
  }
  return null;
}

function findFirstOf(text: string, chars: readonly string[]): number {
  let earliest = -1;
  for (const c of chars) {
    const idx = text.indexOf(c);
    if (idx !== -1 && (earliest === -1 || idx < earliest)) {
      earliest = idx;
    }
  }
  return earliest;
}

/**
 * Extract the first deploy URL printed by `ntn workers deploy`. The CLI
 * format is not perfectly stable; we look for the first `https://` token,
 * matching the conservative "best-effort" approach in PLAN.md §III.
 */
export function extractDeployUrl(stdout: string): string | undefined {
  // Matches an https URL stopping at whitespace, quotes, or angle brackets.
  const match = /https:\/\/[^\s"'<>)]+/u.exec(stdout);
  return match?.[0];
}

/**
 * Extract a worker ID from `ntn workers deploy` stdout. The CLI commonly
 * prints lines like `Worker ID: wk_abc123` or `id=wk_abc123`. We try both.
 */
export function extractWorkerId(stdout: string): string | undefined {
  const labeled = /(?:Worker\s*ID|worker[_ ]?id)\s*[:=]\s*([A-Za-z0-9_-]+)/iu.exec(
    stdout,
  );
  if (labeled?.[1]) {
    return labeled[1];
  }
  // Some versions print the slug as `wk_...` on its own line.
  const slug = /\b(wk_[A-Za-z0-9_-]{6,})\b/u.exec(stdout);
  return slug?.[1];
}

/**
 * Heuristic: detect whether a non-zero exit was caused by an expired/missing
 * auth token. The CLI's exact wording varies across versions, so we match
 * several known phrasings.
 */
export function looksLikeAuthFailure(stderr: string, stdout = ''): boolean {
  const combined = `${stderr}\n${stdout}`.toLowerCase();
  return (
    combined.includes('not logged in') ||
    combined.includes('please run `ntn login`') ||
    combined.includes('please run ntn login') ||
    combined.includes('authentication failed') ||
    combined.includes('token expired') ||
    combined.includes('unauthorized') ||
    combined.includes('401 unauthorized') ||
    combined.includes('invalid credentials')
  );
}
