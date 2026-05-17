/**
 * Typed wrappers for `ntn pages ...` — used by the Installer to create the
 * Forge page + DBs in the user's workspace (PLAN.md §III, §VII), and by
 * `lib/build-log.ts` to update the Build Log block during runs.
 *
 * Payloads can get large; we route them via stdin (`--data -`) when the CLI
 * supports it and fall back to `--data <json>` otherwise. To keep the
 * wrapper version-agnostic we always pass via argv `--data` and rely on the
 * stdin escape hatch on `NtnRunOptions` for callers that need it.
 */

import { runNtn, runNtnJson } from './exec';
import { NtnInvalidArgumentError } from './errors';
import type { DatabaseId, NtnRunOptions, NtnRunResult, PageId } from './types';

// Page and database IDs share the same runtime shape (UUID-with-or-without
// dashes), so one regex covers both. Tightened bounds (8–128) match Notion's
// observed envelope without being so permissive that a typo passes.
const PAGE_ID_REGEX = /^[A-Za-z0-9-]{8,128}$/u;

function assertPageId(id: string): void {
  if (!PAGE_ID_REGEX.test(id)) {
    throw new NtnInvalidArgumentError(
      `Invalid page id: "${id}". Notion page IDs are alphanumeric with dashes.`,
    );
  }
}

function assertParentId(id: string, what: 'page' | 'database' | 'data-source'): void {
  if (!PAGE_ID_REGEX.test(id)) {
    throw new NtnInvalidArgumentError(
      `Invalid ${what} parent id: "${id}". Notion IDs are alphanumeric with dashes.`,
    );
  }
}

function assertNonEmptyContent(content: string, what: string): void {
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new NtnInvalidArgumentError(
      `${what}: \`content\` must be a non-empty Markdown string.`,
    );
  }
}

/**
 * Discriminated union for `ntn pages create --parent <type>:<id>`. Matches the
 * three parent kinds the CLI accepts (`ntn pages create --help` lists
 * `page:<id>`, `database:<id>`, and `data-source:<id>`). Notion's 2025-09 API
 * split databases and data sources, so both shapes are first-class here.
 */
export type PageParent =
  | { type: 'page'; id: PageId }
  | { type: 'database'; id: DatabaseId }
  | { type: 'data-source'; id: DatabaseId };

function safeStringify(payload: unknown, what: string): string {
  try {
    return JSON.stringify(payload);
  } catch (error) {
    throw new NtnInvalidArgumentError(
      `${what} payload is not JSON-serialisable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/** Get a page by ID: `ntn pages get <id> --json`. */
export async function getPage<T = unknown>(id: PageId, opts: NtnRunOptions = {}): Promise<T> {
  assertPageId(id);
  const { data } = await runNtnJson<T>(['pages', 'get', id, '--json'], opts);
  return data;
}

/**
 * Create a page: `ntn pages create --data <json>`. Returns the parsed page
 * (with `id`, `url`, etc.).
 */
export async function createPage<T = unknown>(
  payload: unknown,
  opts: NtnRunOptions = {},
): Promise<T> {
  const json = safeStringify(payload, 'createPage');
  const { data } = await runNtnJson<T>(['pages', 'create', '--data', json, '--json'], opts);
  return data;
}

/** Update a page: `ntn pages update <id> --data <json>`. */
export async function updatePage<T = unknown>(
  id: PageId,
  payload: unknown,
  opts: NtnRunOptions = {},
): Promise<T> {
  assertPageId(id);
  const json = safeStringify(payload, 'updatePage');
  const { data } = await runNtnJson<T>(['pages', 'update', id, '--data', json, '--json'], opts);
  return data;
}

/** Trash (archive) a page: `ntn pages trash <id>`. */
export async function trashPage(id: PageId, opts: NtnRunOptions = {}): Promise<NtnRunResult> {
  assertPageId(id);
  return runNtn(['pages', 'trash', id], opts);
}

/**
 * Create a page from Markdown content:
 * `ntn pages create --parent <type>:<id> --content <markdown>`.
 *
 * Per `.agents/skills/notion-cli/SKILL.md`, this is the preferred surface for
 * page body creation — only fall back to {@link createPage} (rich_text JSON)
 * when you need features Markdown cannot express (e.g. column layouts,
 * databases-as-pages, computed properties).
 *
 * `content` is passed via argv (`--content <value>`) — the CLI handles
 * shell-escaping. Returns the raw `NtnRunResult` because the underlying
 * command is human-readable by default; callers needing the structured page
 * object should use {@link createPage} with a hand-built payload, or extend
 * this wrapper with a `--json` overload once the contract is stable.
 */
export async function createPageMarkdown(
  parent: PageParent,
  content: string,
  opts: NtnRunOptions = {},
): Promise<NtnRunResult> {
  assertParentId(parent.id, parent.type);
  assertNonEmptyContent(content, 'createPageMarkdown');
  return runNtn(
    ['pages', 'create', '--parent', `${parent.type}:${parent.id}`, '--content', content],
    opts,
  );
}

/**
 * Replace a page's content from Markdown:
 * `ntn pages update <page-id> --content <markdown>`.
 *
 * See {@link createPageMarkdown} for the rationale on preferring Markdown.
 * Note the CLI's `--allow-deleting-content` flag is intentionally not exposed
 * here — destructive deletes should go through an explicit, narrower wrapper
 * if they're ever needed.
 */
export async function updatePageMarkdown(
  id: PageId,
  content: string,
  opts: NtnRunOptions = {},
): Promise<NtnRunResult> {
  assertPageId(id);
  assertNonEmptyContent(content, 'updatePageMarkdown');
  return runNtn(['pages', 'update', id, '--content', content], opts);
}
