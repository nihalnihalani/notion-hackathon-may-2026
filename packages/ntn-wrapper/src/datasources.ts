/**
 * Typed wrappers for `ntn datasources ...` — used by Schema Smith to discover
 * workspace context and resolve relations (PLAN.md §III, §IV.1).
 */

import { runNtnJson } from './exec';
import { NtnInvalidArgumentError } from './errors';
import type { DatabaseId, NtnRunOptions } from './types';

const DB_ID_REGEX = /^[A-Za-z0-9-]{8,128}$/u;

function assertDatasourceId(id: string): void {
  if (!DB_ID_REGEX.test(id)) {
    throw new NtnInvalidArgumentError(
      `Invalid datasource id: "${id}". Notion database IDs are alphanumeric with dashes.`,
    );
  }
}

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
 * Query a datasource: `ntn datasources query <id> --data <json> --json`.
 *
 * `query` is forwarded as the Notion database query payload (filter, sorts,
 * page_size, start_cursor). Results are parsed JSON.
 */
export async function queryDatasource<T = unknown>(
  id: DatabaseId,
  query: unknown,
  opts: NtnRunOptions = {},
): Promise<T> {
  assertDatasourceId(id);
  const json = safeStringify(query, 'queryDatasource');
  const { data } = await runNtnJson<T>(
    ['datasources', 'query', id, '--data', json, '--json'],
    opts,
  );
  return data;
}

/**
 * Resolve a datasource (returns schema + relation metadata):
 *   `ntn datasources resolve <id> --json`
 */
export async function resolveDatasource<T = unknown>(
  id: DatabaseId,
  opts: NtnRunOptions = {},
): Promise<T> {
  assertDatasourceId(id);
  const { data } = await runNtnJson<T>(
    ['datasources', 'resolve', id, '--json'],
    opts,
  );
  return data;
}
