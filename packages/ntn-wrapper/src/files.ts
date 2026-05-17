/**
 * Typed wrappers for `ntn files ...` — used by Shipper to attach the generated
 * TS file to the generated-agent DB row as a downloadable artifact
 * (PLAN.md §III, §IV.4 step 6).
 */

import { runNtn, runNtnJson } from './exec';
import { NtnInvalidArgumentError } from './errors';
import type { FileId, NtnRunOptions, NtnRunResult } from './types';

const FILE_ID_REGEX = /^[A-Za-z0-9-]{8,128}$/u;

function safeStringify(payload: unknown, what: string): string {
  try {
    return JSON.stringify(payload);
  } catch (err) {
    throw new NtnInvalidArgumentError(
      `${what} payload is not JSON-serialisable: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * Create a file: `ntn files create --data <json> --json`.
 *
 * `payload` is the file-upload descriptor (Notion file upload contract).
 * The CLI handles multipart upload internally; we just pass the JSON body.
 */
export async function createFile<T = unknown>(
  payload: unknown,
  opts: NtnRunOptions = {},
): Promise<T> {
  const json = safeStringify(payload, 'createFile');
  const { data } = await runNtnJson<T>(
    ['files', 'create', '--data', json, '--json'],
    opts,
  );
  return data;
}

/** Get a single file's metadata: `ntn files get <id> --json`. */
export async function getFile<T = unknown>(
  id: FileId,
  opts: NtnRunOptions = {},
): Promise<T> {
  if (!FILE_ID_REGEX.test(id)) {
    throw new NtnInvalidArgumentError(`Invalid file id: "${id}".`);
  }
  const { data } = await runNtnJson<T>(['files', 'get', id, '--json'], opts);
  return data;
}

/** List uploaded files: `ntn files list --json`. */
export async function listFiles<T = unknown>(
  opts: NtnRunOptions = {},
): Promise<T[]> {
  const { data } = await runNtnJson<T[]>(['files', 'list', '--json'], opts);
  return data;
}

/**
 * Escape hatch for callers that need the raw `NtnRunResult` from a files
 * call (e.g. to capture stderr for diagnostics).
 */
export async function runFilesCommand(
  args: readonly string[],
  opts: NtnRunOptions = {},
): Promise<NtnRunResult> {
  return runNtn(['files', ...args], opts);
}
