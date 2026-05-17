/**
 * Generic Notion API escape hatch via the `ntn api <endpoint>` command.
 *
 * Used by `lib/notion.ts: rawApi()` per PLAN.md §III for the rare cases
 * where the typed Notion SDK is overkill or doesn't cover a new endpoint.
 *
 * Prefer the typed wrappers (`pages`, `webhooks`, `datasources`, etc.) over
 * this — `callNotionApi` is intentionally untyped on the response so callers
 * are forced to validate.
 */

import { runNtn, runNtnJson } from './exec';
import { NtnInvalidArgumentError } from './errors';
import type { NtnRunOptions } from './types';

const ENDPOINT_REGEX = /^\/?[A-Za-z0-9/_.{}:-]{1,512}$/u;

function safeStringify(payload: unknown): string {
  try {
    return JSON.stringify(payload);
  } catch (error) {
    throw new NtnInvalidArgumentError(
      `callNotionApi data is not JSON-serialisable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export interface CallNotionApiOptions extends NtnRunOptions {
  /** HTTP method override; default is whatever the CLI infers from the endpoint. */
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** Request body. Forwarded via `--data <json>`. */
  data?: unknown;
  /** Force `--json` parse on the response. Default true. */
  parseJson?: boolean;
}

/**
 * Generic Notion API call: `ntn api <endpoint> [--method M] [--data <json>] [--json]`.
 *
 * Returns parsed JSON when `parseJson !== false`, else the raw stdout.
 */
export async function callNotionApi<T = unknown>(
  endpoint: string,
  opts: CallNotionApiOptions = {},
): Promise<T | string> {
  if (!ENDPOINT_REGEX.test(endpoint)) {
    throw new NtnInvalidArgumentError(
      `Invalid Notion API endpoint: "${endpoint}".`,
    );
  }
  const args: string[] = ['api', endpoint];
  if (opts.method !== undefined) {
    args.push('--method', opts.method);
  }
  if (opts.data !== undefined) {
    args.push('--data', safeStringify(opts.data));
  }
  const parseJson = opts.parseJson !== false;
  if (parseJson) {
    args.push('--json');
  }

  const {
    method: _method,
    data: _data,
    parseJson: _parseJson,
    ...runOpts
  } = opts;

  if (parseJson) {
    const { data } = await runNtnJson<T>(args, runOpts);
    return data;
  }
  const result = await runNtn(args, runOpts);
  return result.stdout;
}
