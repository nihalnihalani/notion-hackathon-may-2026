/**
 * Typed wrappers for `ntn workers runs ...` (per-worker run history + logs).
 * Powers the "Run history" tab in the Notion DB per PLAN.md §III.
 */

import { runNtn, runNtnJson } from './exec';
import { NtnInvalidArgumentError } from './errors';
import type {
  NtnRunOptions,
  RunId,
  WorkerName,
  WorkerRun,
} from './types';

const WORKER_NAME_REGEX = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const RUN_ID_REGEX = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

/** List recent runs for a worker: `ntn workers runs list <name> --json`. */
export async function listRuns(
  name: WorkerName,
  opts: NtnRunOptions & { limit?: number } = {},
): Promise<WorkerRun[]> {
  if (!WORKER_NAME_REGEX.test(name)) {
    throw new NtnInvalidArgumentError(`Invalid worker name: "${name}".`);
  }
  const args = ['workers', 'runs', 'list', name, '--json'];
  if (opts.limit !== undefined) {
    if (!Number.isInteger(opts.limit) || opts.limit <= 0) {
      throw new NtnInvalidArgumentError(
        `listRuns limit must be a positive integer, got ${String(opts.limit)}`,
      );
    }
    args.push('--limit', String(opts.limit));
  }
  const { limit: _limit, ...runOpts } = opts;
  const { data } = await runNtnJson<WorkerRun[]>(args, runOpts);
  return data;
}

/**
 * Fetch logs for a specific run: `ntn workers runs logs <runId>`.
 *
 * The CLI streams the post-execution logs as plain text (see PLAN.md §III
 * note on "logs are post-execution, not streaming"). We capture the full
 * body and return it as a string; callers can split on `\n` if they want
 * structured lines.
 *
 * Note: the `name` argument is accepted for API consistency with the rest
 * of the wrapper, but is not currently required by the CLI invocation —
 * runIds are globally unique.
 */
export async function getRunLogs(
  name: WorkerName,
  runId: RunId,
  opts: NtnRunOptions = {},
): Promise<{ logs: string; lines: string[] }> {
  if (!WORKER_NAME_REGEX.test(name)) {
    throw new NtnInvalidArgumentError(`Invalid worker name: "${name}".`);
  }
  if (!RUN_ID_REGEX.test(runId)) {
    throw new NtnInvalidArgumentError(`Invalid run id: "${runId}".`);
  }
  const result = await runNtn(['workers', 'runs', 'logs', runId], opts);
  const logs = result.stdout;
  const lines = logs.split(/\r?\n/u).filter((l) => l.length > 0);
  return { logs, lines };
}
