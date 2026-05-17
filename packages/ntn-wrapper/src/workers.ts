/**
 * Typed wrappers for `ntn workers ...` commands.
 *
 * Every function:
 *   - validates required arguments
 *   - delegates to `runNtn` / `runNtnJson` from `exec.ts`
 *   - returns a strongly-typed result
 *   - bubbles typed errors (`NtnExecError`, `NtnTimeoutError`, ...)
 *
 * Auth failures detected via the stderr heuristic in `parsers.ts` are
 * re-thrown as `NtnAuthError` to give callers a single matchable type.
 */

import { runNtn, runNtnJson } from './exec';
import {
  NtnAuthError,
  NtnExecError,
  NtnInvalidArgumentError,
} from './errors';
import {
  extractDeployUrl,
  extractWorkerId,
  looksLikeAuthFailure,
} from './parsers';
import type {
  DeployResult,
  NtnRunOptions,
  NtnRunResult,
  Worker,
  WorkerCapability,
  WorkerName,
} from './types';

// ============================================================================
// Helpers
// ============================================================================

const WORKER_NAME_REGEX = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;

function assertWorkerName(name: string): void {
  if (!WORKER_NAME_REGEX.test(name)) {
    throw new NtnInvalidArgumentError(
      `Invalid worker name: "${name}". Must match ${WORKER_NAME_REGEX.source}.`,
    );
  }
}

function assertEnvKey(key: string): void {
  if (!/^[A-Z][A-Z0-9_]*$/u.test(key)) {
    throw new NtnInvalidArgumentError(
      `Invalid env var key: "${key}". Must be UPPER_SNAKE_CASE.`,
    );
  }
}

/**
 * Run an `ntn workers ...` command and convert auth-failure exit codes into
 * `NtnAuthError`. All other typed errors bubble unchanged.
 */
async function runWorkerCmd(
  args: readonly string[],
  opts: NtnRunOptions,
): Promise<NtnRunResult> {
  try {
    return await runNtn(args, opts);
  } catch (err) {
    if (err instanceof NtnExecError && looksLikeAuthFailure(err.stderr, err.stdout)) {
      throw new NtnAuthError({
        args: err.args,
        stderr: err.stderr,
        stdout: err.stdout,
        exitCode: err.exitCode,
      });
    }
    throw err;
  }
}

async function runWorkerJson<T>(
  args: readonly string[],
  opts: NtnRunOptions,
): Promise<T> {
  try {
    const { data } = await runNtnJson<T>(args, opts);
    return data;
  } catch (err) {
    if (err instanceof NtnExecError && looksLikeAuthFailure(err.stderr, err.stdout)) {
      throw new NtnAuthError({
        args: err.args,
        stderr: err.stderr,
        stdout: err.stdout,
        exitCode: err.exitCode,
      });
    }
    throw err;
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Scaffold a new Worker project: `ntn workers new <name>`.
 *
 * The CLI writes a project skeleton into the current working directory. The
 * caller is responsible for setting `cwd` to a clean, per-generation dir
 * (e.g. `/tmp/forge/<generationId>` per PLAN.md §III).
 */
export async function scaffoldWorker(
  name: WorkerName,
  opts: NtnRunOptions = {},
): Promise<NtnRunResult> {
  assertWorkerName(name);
  return runWorkerCmd(['workers', 'new', name], opts);
}

/**
 * Deploy a Worker via `ntn workers deploy [--dry-run]`.
 *
 * Returns the parsed deploy URL and worker ID where extractable from stdout.
 * The `cwd` MUST be the worker project root (where the `ntn workers new`
 * scaffold lives) — `ntn workers deploy` does not take a name argument.
 */
export async function deployWorker(
  name: WorkerName,
  opts: NtnRunOptions & { dryRun?: boolean } = {},
): Promise<DeployResult> {
  assertWorkerName(name);
  const args = ['workers', 'deploy'];
  if (opts.dryRun === true) {
    args.push('--dry-run');
  }
  const { dryRun: _dryRun, ...runOpts } = opts;
  const result = await runWorkerCmd(args, runOpts);
  const deployUrl = extractDeployUrl(result.stdout);
  const workerId = extractWorkerId(result.stdout);
  return {
    workerName: name,
    ...(workerId !== undefined ? { workerId } : {}),
    ...(deployUrl !== undefined ? { deployUrl } : {}),
    dryRun: opts.dryRun === true,
    rawStdout: result.stdout,
  };
}

/**
 * Execute a Worker against synthetic input:
 *   `ntn workers exec <name> --input <json>`
 *
 * The input is JSON-stringified and passed via `--input`. Output is parsed
 * as JSON; if the CLI returns non-JSON output the raw stdout is surfaced as
 * the `raw` field of the typed result.
 */
export async function execWorker<TOut = unknown>(
  name: WorkerName,
  input: unknown,
  opts: NtnRunOptions = {},
): Promise<{ output: TOut | undefined; raw: string; durationMs: number }> {
  assertWorkerName(name);
  let inputJson: string;
  try {
    inputJson = JSON.stringify(input);
  } catch (err) {
    throw new NtnInvalidArgumentError(
      `execWorker input is not JSON-serialisable: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  const args = ['workers', 'exec', name, '--input', inputJson];
  const result = await runWorkerCmd(args, opts);
  // Try to parse stdout as JSON; if it isn't, surface raw text without throwing.
  // Worker exec output is user-controlled so we tolerate non-JSON.
  const trimmed = result.stdout.trim();
  let output: TOut | undefined;
  if (trimmed.length > 0) {
    try {
      output = JSON.parse(trimmed) as TOut;
    } catch {
      output = undefined;
    }
  }
  return { output, raw: result.stdout, durationMs: result.durationMs };
}

/** List deployed workers: `ntn workers list --json`. */
export async function listWorkers(
  opts: NtnRunOptions = {},
): Promise<Worker[]> {
  return runWorkerJson<Worker[]>(['workers', 'list', '--json'], opts);
}

/** Get a single worker: `ntn workers get <name> --json`. */
export async function getWorker(
  name: WorkerName,
  opts: NtnRunOptions = {},
): Promise<Worker> {
  assertWorkerName(name);
  return runWorkerJson<Worker>(['workers', 'get', name, '--json'], opts);
}

/** Delete a worker: `ntn workers delete <name>`. */
export async function deleteWorker(
  name: WorkerName,
  opts: NtnRunOptions = {},
): Promise<NtnRunResult> {
  assertWorkerName(name);
  return runWorkerCmd(['workers', 'delete', name], opts);
}

/**
 * List a worker's capabilities (tools/syncs/webhooks):
 *   `ntn workers capabilities list <name> --json`
 *
 * Used by Shipper to wire each capability into a Notion Custom Agent
 * (PLAN.md §IV.4 step 2).
 */
export async function listCapabilities(
  name: WorkerName,
  opts: NtnRunOptions = {},
): Promise<WorkerCapability[]> {
  assertWorkerName(name);
  return runWorkerJson<WorkerCapability[]>(
    ['workers', 'capabilities', 'list', name, '--json'],
    opts,
  );
}

// ============================================================================
// `ntn workers env ...`
// ============================================================================

/**
 * Set one or more env vars on a worker: `ntn workers env set <name> KEY=VAL`.
 *
 * Pass a record of `{ KEY: value }`. We invoke the CLI once per key — the
 * CLI's batch syntax differs across versions and per-key calls are safer.
 * Failures on any key abort the whole operation.
 *
 * Security: values are passed via argv, which is visible in `ps` on the
 * machine running this code. That's acceptable here because the wrapper
 * runs inside Vercel Sandbox (PLAN.md §IX) which has no other processes.
 */
export async function setEnv(
  name: WorkerName,
  kv: Readonly<Record<string, string>>,
  opts: NtnRunOptions = {},
): Promise<void> {
  assertWorkerName(name);
  const entries = Object.entries(kv);
  if (entries.length === 0) {
    throw new NtnInvalidArgumentError('setEnv requires at least one KEY/value pair.');
  }
  for (const [key, value] of entries) {
    assertEnvKey(key);
    if (typeof value !== 'string') {
      throw new NtnInvalidArgumentError(
        `setEnv value for ${key} must be a string, got ${typeof value}.`,
      );
    }
    await runWorkerCmd(
      ['workers', 'env', 'set', name, `${key}=${value}`],
      opts,
    );
  }
}

/** List env keys for a worker: `ntn workers env list <name> --json`. */
export async function listEnv(
  name: WorkerName,
  opts: NtnRunOptions = {},
): Promise<Record<string, string>> {
  assertWorkerName(name);
  return runWorkerJson<Record<string, string>>(
    ['workers', 'env', 'list', name, '--json'],
    opts,
  );
}

/** Unset an env key: `ntn workers env unset <name> <KEY>`. */
export async function unsetEnv(
  name: WorkerName,
  key: string,
  opts: NtnRunOptions = {},
): Promise<NtnRunResult> {
  assertWorkerName(name);
  assertEnvKey(key);
  return runWorkerCmd(['workers', 'env', 'unset', name, key], opts);
}

/** Pull a worker's env to local `.env`: `ntn workers env pull <name>`. */
export async function pullEnv(
  name: WorkerName,
  opts: NtnRunOptions = {},
): Promise<NtnRunResult> {
  assertWorkerName(name);
  return runWorkerCmd(['workers', 'env', 'pull', name], opts);
}

/**
 * Push a local env file to a worker:
 *   `ntn workers env push <name> --file <path>`
 *
 * `file` should be an absolute path that the CLI can read.
 */
export async function pushEnv(
  name: WorkerName,
  file: string,
  opts: NtnRunOptions = {},
): Promise<NtnRunResult> {
  assertWorkerName(name);
  if (file.trim().length === 0) {
    throw new NtnInvalidArgumentError('pushEnv requires a non-empty file path.');
  }
  return runWorkerCmd(
    ['workers', 'env', 'push', name, '--file', file],
    opts,
  );
}
