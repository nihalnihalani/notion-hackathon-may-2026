/**
 * Shared types for the `@forge/ntn-wrapper` package.
 *
 * These describe the surface of the typed wrapper around the `ntn` CLI.
 * Library code never reads `process.env` directly; callers pass everything via
 * {@link NtnRunOptions} so wrappers stay deterministic and unit-testable.
 */

/**
 * A minimal logger interface. The wrapper does not `console.log`; callers can
 * pass a structured logger (pino, bunyan, etc.) by adapting it to this shape.
 * Default is a silent no-op (see `exec.ts`).
 */
export interface NtnLogger {
  debug: (msg: string, meta?: Record<string, unknown>) => void;
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
}

/**
 * Options accepted by every wrapper function and forwarded to `runNtn`.
 *
 * The defaults documented here are applied inside `exec.ts` when a field is
 * omitted, but the wrapper itself never injects environment variables — the
 * caller controls the entire env block.
 */
export interface NtnRunOptions {
  /** Working directory for the spawned process. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Timeout in milliseconds. Default is 60_000 (60s). 0 disables the timer. */
  timeoutMs?: number;
  /**
   * Environment variables passed to the child process. When omitted, the
   * child inherits the parent's env unchanged. Pass `{}` to fully isolate.
   */
  env?: Record<string, string>;
  /** Optional `AbortSignal` to cancel an in-flight run. */
  signal?: AbortSignal;
  /** Optional logger. Defaults to a silent no-op. */
  logger?: NtnLogger;
  /**
   * Absolute path to the `ntn` binary. Defaults to `"ntn"` (resolved via
   * `PATH`). Useful for tests that swap in a fake binary.
   */
  binary?: string;
  /**
   * Optional string written to stdin and then closed. Used for commands that
   * accept large JSON payloads, where putting them on argv would be brittle.
   */
  stdin?: string;
  /** Max bytes to capture from stdout. Default 10 MiB. */
  maxStdoutBytes?: number;
  /** Max bytes to capture from stderr. Default 1 MiB. */
  maxStderrBytes?: number;
}

/**
 * The result of a successful (exit code 0) `ntn` invocation. Non-zero exits
 * surface as `NtnExecError` via `exec.ts`.
 */
export interface NtnRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
  /** The exact argv (excluding the binary) that was executed. */
  args: readonly string[];
}

/** Subset of fields parsed from `ntn workers list --json`. */
export interface Worker {
  name: string;
  id?: string;
  url?: string;
  status?: string;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

/** Subset of fields parsed from `ntn workers capabilities list <name> --json`. */
export interface WorkerCapability {
  kind: 'tool' | 'sync' | 'webhook' | string;
  key: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  [key: string]: unknown;
}

/** Subset of fields parsed from `ntn workers runs list <name> --json`. */
export interface WorkerRun {
  id: string;
  workerName?: string;
  status?: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled' | string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  trigger?: string;
  [key: string]: unknown;
}

/** Subset of fields parsed from `ntn workers sync state get <name>`. */
export interface SyncState {
  workerName: string;
  status: 'idle' | 'running' | 'paused' | 'errored' | string;
  cursor?: string;
  lastRunAt?: string;
  lastError?: string;
  [key: string]: unknown;
}

/** Subset of fields parsed from `ntn webhooks list --json`. */
export interface WebhookEndpoint {
  id: string;
  url: string;
  workerName?: string;
  capabilityKey?: string;
  createdAt?: string;
  [key: string]: unknown;
}

/** Names of supported OAuth providers per the integrations catalog (Part XI). */
export type OAuthProvider =
  | 'github'
  | 'linear'
  | 'stripe'
  | 'slack'
  | 'google'
  | (string & {});

/** Newtype-flavoured aliases — same runtime shape, clearer call sites. */
export type PageId = string;
export type DatabaseId = string;
export type WorkerName = string;
export type RunId = string;
export type FileId = string;

/** Result of `deployWorker` — parsed from the CLI's stdout. */
export interface DeployResult {
  workerName: string;
  workerId?: string;
  deployUrl?: string;
  /** True when invoked with `dryRun: true`. */
  dryRun: boolean;
  rawStdout: string;
}

/** Health report returned by `ntn doctor --json`. */
export interface DoctorReport {
  ok: boolean;
  loggedIn?: boolean;
  cliVersion?: string;
  checks: Array<{
    name: string;
    ok: boolean;
    message?: string;
  }>;
  raw: unknown;
}
