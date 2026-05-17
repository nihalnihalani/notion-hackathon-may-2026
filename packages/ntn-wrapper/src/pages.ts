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
import type { NtnRunOptions, NtnRunResult, PageId } from './types';

const PAGE_ID_REGEX = /^[A-Za-z0-9-]{8,128}$/u;

function assertPageId(id: string): void {
  if (!PAGE_ID_REGEX.test(id)) {
    throw new NtnInvalidArgumentError(
      `Invalid page id: "${id}". Notion page IDs are alphanumeric with dashes.`,
    );
  }
}

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
