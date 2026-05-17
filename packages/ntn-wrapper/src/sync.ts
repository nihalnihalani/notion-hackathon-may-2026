/**
 * Typed wrappers for `ntn workers sync ...` (state cursors for sync-source
 * agents). Used by `lib/registry.ts` per PLAN.md §III.
 */

import { runNtn, runNtnJson } from './exec';
import { NtnInvalidArgumentError } from './errors';
import type { NtnRunOptions, NtnRunResult, SyncState, WorkerName } from './types';

const WORKER_NAME_REGEX = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;

function assertWorkerName(name: string): void {
  if (!WORKER_NAME_REGEX.test(name)) {
    throw new NtnInvalidArgumentError(
      `Invalid worker name: "${name}". Must match ${WORKER_NAME_REGEX.source}.`,
    );
  }
}

/** Trigger an on-demand sync run: `ntn workers sync trigger <name>`. */
export async function triggerSync(
  name: WorkerName,
  opts: NtnRunOptions = {},
): Promise<NtnRunResult> {
  assertWorkerName(name);
  return runNtn(['workers', 'sync', 'trigger', name], opts);
}

/** Pause a sync source (idempotent): `ntn workers sync pause <name>`. */
export async function pauseSync(name: WorkerName, opts: NtnRunOptions = {}): Promise<NtnRunResult> {
  assertWorkerName(name);
  return runNtn(['workers', 'sync', 'pause', name], opts);
}

/** Resume a paused sync (idempotent): `ntn workers sync resume <name>`. */
export async function resumeSync(
  name: WorkerName,
  opts: NtnRunOptions = {},
): Promise<NtnRunResult> {
  assertWorkerName(name);
  return runNtn(['workers', 'sync', 'resume', name], opts);
}

/**
 * Get the current sync state: `ntn workers sync state get <name> --json`.
 *
 * Returns the cursor + last-run metadata. Used by the recovery UI when
 * cursor corruption is suspected (PLAN.md sharp-edges §III).
 */
export async function getSyncState(name: WorkerName, opts: NtnRunOptions = {}): Promise<SyncState> {
  assertWorkerName(name);
  const { data } = await runNtnJson<SyncState>(
    ['workers', 'sync', 'state', 'get', name, '--json'],
    opts,
  );
  // Ensure the workerName field is populated even if the CLI omits it.
  return { ...data, workerName: name };
}

/**
 * Reset the sync state cursor (destructive — next run starts from scratch):
 *   `ntn workers sync state reset <name>`.
 *
 * Callers must confirm with the user before invoking; the wrapper does not
 * gate this beyond the `confirm` flag below.
 */
export async function resetSyncState(
  name: WorkerName,
  opts?: NtnRunOptions & { confirm: true },
): Promise<NtnRunResult> {
  assertWorkerName(name);
  if (opts?.confirm !== true) {
    throw new NtnInvalidArgumentError(
      'resetSyncState requires { confirm: true } to acknowledge the destructive operation.',
    );
  }
  const { confirm: _confirm, ...runOpts } = opts;
  return runNtn(['workers', 'sync', 'state', 'reset', name], runOpts);
}
