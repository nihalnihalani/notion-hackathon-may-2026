/**
 * Typed error hierarchy for the `@forge/ntn-wrapper` package.
 *
 * Every wrapper failure surfaces as one of these classes — never a bare
 * `Error`. Callers (Inspector, Shipper, the dashboard error handler) match on
 * `instanceof` to decide whether to retry, surface to the user, or bubble.
 */

/** Base class for all `ntn` wrapper errors. */
export class NtnError extends Error {
  /** Argv (excluding the binary) that triggered the failure. */
  public readonly args: readonly string[];
  /** stderr captured up to the point of failure (may be truncated). */
  public readonly stderr: string;
  /** stdout captured up to the point of failure (may be truncated). */
  public readonly stdout: string;
  /** Process exit code if the child exited; `undefined` if it never did. */
  public readonly exitCode: number | undefined;

  public constructor(
    message: string,
    init: {
      args: readonly string[];
      stderr?: string | undefined;
      stdout?: string | undefined;
      exitCode?: number | undefined;
      cause?: unknown;
    },
  ) {
    // `cause` is part of the standard ErrorOptions in ES2022; pass through.
    super(message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = new.target.name;
    this.args = init.args;
    this.stderr = init.stderr ?? '';
    this.stdout = init.stdout ?? '';
    this.exitCode = init.exitCode;
  }
}

/** Raised when the `ntn` binary is not on PATH (ENOENT from spawn). */
export class NtnNotInstalledError extends NtnError {
  public constructor(init: {
    args: readonly string[];
    binary: string;
    cause?: unknown;
  }) {
    super(
      `ntn binary not found on PATH (looked for "${init.binary}"). ` +
        `Install via https://developers.notion.com/docs/install-ntn-cli and ensure it is on PATH.`,
      { args: init.args, cause: init.cause },
    );
  }
}

/** Raised when the wrapper-enforced timeout fires before the child exits. */
export class NtnTimeoutError extends NtnError {
  public readonly timeoutMs: number;

  public constructor(init: {
    args: readonly string[];
    timeoutMs: number;
    stdout?: string | undefined;
    stderr?: string | undefined;
  }) {
    super(
      `ntn ${init.args.join(' ')} timed out after ${String(init.timeoutMs)}ms`,
      { args: init.args, stdout: init.stdout, stderr: init.stderr },
    );
    this.timeoutMs = init.timeoutMs;
  }
}

/** Raised when the child exits with a non-zero status code. */
export class NtnExecError extends NtnError {
  public constructor(init: {
    args: readonly string[];
    exitCode: number;
    stdout?: string | undefined;
    stderr?: string | undefined;
  }) {
    super(
      `ntn ${init.args.join(' ')} exited with code ${String(init.exitCode)}: ${truncate(
        init.stderr ?? init.stdout ?? '',
      )}`,
      {
        args: init.args,
        stdout: init.stdout,
        stderr: init.stderr,
        exitCode: init.exitCode,
      },
    );
  }
}

/** Raised when `--json` output cannot be parsed. */
export class NtnJsonParseError extends NtnError {
  public constructor(init: {
    args: readonly string[];
    stdout: string;
    cause: unknown;
  }) {
    super(
      `ntn ${init.args.join(' ')} produced unparseable JSON: ${
        init.cause instanceof Error ? init.cause.message : String(init.cause)
      }`,
      { args: init.args, stdout: init.stdout, cause: init.cause },
    );
  }
}

/**
 * Raised when an `ntn` call fails in a way that indicates the user is no
 * longer authenticated (token expired, revoked, etc.). The wrapper detects
 * this by inspecting stderr — see `auth.ts` for the heuristics.
 */
export class NtnAuthError extends NtnError {
  public constructor(init: {
    args: readonly string[];
    stderr?: string | undefined;
    stdout?: string | undefined;
    exitCode?: number | undefined;
  }) {
    super(
      `ntn ${init.args.join(' ')} reports an authentication failure. Run \`ntn login\` and retry.`,
      init,
    );
  }
}

/**
 * Raised when the user passes invalid arguments to a wrapper function (e.g.
 * an empty worker name, malformed JSON payload).
 */
export class NtnInvalidArgumentError extends NtnError {
  public constructor(message: string, args: readonly string[] = []) {
    super(message, { args });
  }
}

/** Truncate long error bodies so error messages stay readable in logs. */
function truncate(s: string, max = 500): string {
  const trimmed = s.trim();
  if (trimmed.length <= max) {
    return trimmed;
  }
  return `${trimmed.slice(0, max)}… [${String(trimmed.length - max)} more chars]`;
}
