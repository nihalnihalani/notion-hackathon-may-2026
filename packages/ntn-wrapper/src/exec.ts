/**
 * Internal subprocess runner. Every typed wrapper goes through `runNtn`.
 *
 * Design notes
 * ------------
 * - We use `spawn` (not `exec`) for every call. Reasoning: `exec` buffers the
 *   whole stdout in a fixed-size buffer (1 MiB default) and throws an opaque
 *   error on overflow. `spawn` lets us stream + cap our own buffer + cancel
 *   cleanly via `kill()`. Worker deploys, run logs, and `--json` capability
 *   dumps can all exceed 1 MiB.
 * - The timeout uses `setTimeout` + `kill('SIGTERM')` then `SIGKILL` after a
 *   grace period. We do not rely on Node's built-in `timeout` option because
 *   it doesn't differentiate timeout vs other terminations.
 * - AbortSignal cancellation: when fired, we send SIGTERM and surface as the
 *   AbortError pattern (`signal.aborted` -> throw `signal.reason ?? Error`).
 * - We never read `process.env` inside this module. The caller controls env.
 * - stdout/stderr are capped (default 10 MiB / 1 MiB) to bound memory under
 *   pathological worker output. Overflow truncates and tags the buffer.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { performance } from 'node:perf_hooks';

import {
  NtnError,
  NtnExecError,
  NtnNotInstalledError,
  NtnTimeoutError,
} from './errors';
import { parseNtnJson } from './parsers';
import type { NtnLogger, NtnRunOptions, NtnRunResult } from './types';

/** Default timeout: 60s, per the wrapper contract. */
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_STDOUT_BYTES = 10 * 1024 * 1024; // 10 MiB
const DEFAULT_MAX_STDERR_BYTES = 1 * 1024 * 1024; // 1 MiB
/** Grace period between SIGTERM and SIGKILL when killing a runaway child. */
const KILL_GRACE_MS = 1500;

function noopLog(): void {
  // Intentionally empty default logger.
}

/** No-op logger used when the caller does not supply one. */
const NOOP_LOGGER: NtnLogger = {
  debug: noopLog,
  info: noopLog,
  warn: noopLog,
  error: noopLog,
};

/**
 * Spawn `ntn` with the given args and capture stdout/stderr. Throws typed
 * errors on timeout, missing binary, or non-zero exit.
 */
export async function runNtn(
  args: readonly string[],
  opts: NtnRunOptions = {},
): Promise<NtnRunResult> {
  const binary = opts.binary ?? 'ntn';
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxStdoutBytes = opts.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES;
  const maxStderrBytes = opts.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES;
  const logger = opts.logger ?? NOOP_LOGGER;

  // Fast path: caller pre-cancelled the AbortSignal.
  if (opts.signal?.aborted) {
    throw abortReason(opts.signal, args);
  }

  const startedAt = performance.now();

  logger.debug('ntn-wrapper.spawn', {
    binary,
    args,
    cwd: opts.cwd,
    timeoutMs,
  });

  return new Promise<NtnRunResult>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(binary, [...args], {
        cwd: opts.cwd,
        // When `env` is omitted we let the child inherit (undefined = inherit).
        env: opts.env,
        // stdin/stdout/stderr as pipes so we can capture + write.
        stdio: ['pipe', 'pipe', 'pipe'],
        // Detach=false so signals propagate. windowsHide for cleanliness.
        windowsHide: true,
      });
    } catch (error) {
      // Synchronous spawn errors (e.g. invalid args) are rare; treat as exec error.
      reject(
        new NtnError('Failed to spawn ntn process', {
          args,
          cause: error,
        }),
      );
      return;
    }

    let stdoutBuf = '';
    let stderrBuf = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const finalize = (run: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      run();
    };

    // ---------------- Output capture ----------------
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');

    child.stdout?.on('data', (chunk: string) => {
      if (stdoutTruncated) {
        return;
      }
      const remaining = maxStdoutBytes - Buffer.byteLength(stdoutBuf, 'utf8');
      if (Buffer.byteLength(chunk, 'utf8') <= remaining) {
        stdoutBuf += chunk;
      } else {
        stdoutBuf += chunk.slice(0, Math.max(0, remaining));
        stdoutBuf += `\n[stdout truncated at ${String(maxStdoutBytes)} bytes]`;
        stdoutTruncated = true;
      }
    });

    child.stderr?.on('data', (chunk: string) => {
      if (stderrTruncated) {
        return;
      }
      const remaining = maxStderrBytes - Buffer.byteLength(stderrBuf, 'utf8');
      if (Buffer.byteLength(chunk, 'utf8') <= remaining) {
        stderrBuf += chunk;
      } else {
        stderrBuf += chunk.slice(0, Math.max(0, remaining));
        stderrBuf += `\n[stderr truncated at ${String(maxStderrBytes)} bytes]`;
        stderrTruncated = true;
      }
    });

    // ---------------- stdin ----------------
    if (opts.stdin !== undefined && child.stdin) {
      child.stdin.on('error', (err: NodeJS.ErrnoException) => {
        // EPIPE happens when the child closes stdin before we finish writing.
        // It is not fatal — the child may have already produced its output.
        if (err.code !== 'EPIPE') {
          logger.warn('ntn-wrapper.stdin-error', { error: err.message });
        }
      });
      child.stdin.end(opts.stdin, 'utf8');
    } else if (child.stdin) {
      child.stdin.end();
    }

    // ---------------- Timeout ----------------
    let timeoutHandle: NodeJS.Timeout | undefined;
    let killTimeoutHandle: NodeJS.Timeout | undefined;
    if (timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        logger.warn('ntn-wrapper.timeout', { args, timeoutMs });
        // Try SIGTERM first; escalate to SIGKILL after grace period.
        try {
          child.kill('SIGTERM');
        } catch {
          /* already dead */
        }
        killTimeoutHandle = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            /* already dead */
          }
        }, KILL_GRACE_MS);
        killTimeoutHandle.unref();
      }, timeoutMs);
      timeoutHandle.unref();
    }

    // ---------------- AbortSignal ----------------
    const onAbort = (): void => {
      aborted = true;
      logger.debug('ntn-wrapper.abort', { args });
      try {
        child.kill('SIGTERM');
      } catch {
        /* already dead */
      }
      // Escalate if the child ignores SIGTERM.
      const escalate = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already dead */
        }
      }, KILL_GRACE_MS);
      escalate.unref();
    };

    if (opts.signal) {
      // `addEventListener` is the documented surface for AbortSignal.
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    // ---------------- Cleanup ----------------
    const cleanup = (): void => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      if (killTimeoutHandle) {
        clearTimeout(killTimeoutHandle);
      }
      if (opts.signal) {
        opts.signal.removeEventListener('abort', onAbort);
      }
    };

    // ---------------- Lifecycle ----------------
    child.on('error', (err: NodeJS.ErrnoException) => {
      finalize(() => {
        const durationMs = performance.now() - startedAt;
        logger.debug('ntn-wrapper.error', {
          code: err.code,
          message: err.message,
          durationMs,
        });
        if (err.code === 'ENOENT') {
          reject(
            new NtnNotInstalledError({ args, binary, cause: err }),
          );
          return;
        }
        reject(
          new NtnError(`ntn process error: ${err.message}`, {
            args,
            cause: err,
            stderr: stderrBuf,
            stdout: stdoutBuf,
          }),
        );
      });
    });

    child.on('close', (code, signal) => {
      finalize(() => {
        const durationMs = performance.now() - startedAt;
        logger.debug('ntn-wrapper.exit', {
          code,
          signal,
          durationMs,
          timedOut,
          aborted,
        });

        if (aborted) {
          reject(abortReason(opts.signal, args, stdoutBuf, stderrBuf));
          return;
        }

        if (timedOut) {
          reject(
            new NtnTimeoutError({
              args,
              timeoutMs,
              stdout: stdoutBuf,
              stderr: stderrBuf,
            }),
          );
          return;
        }

        // Node reports `code === null` when the process was killed by a signal.
        const exitCode = code ?? -1;
        if (exitCode !== 0) {
          reject(
            new NtnExecError({
              args,
              exitCode,
              stdout: stdoutBuf,
              stderr: stderrBuf,
            }),
          );
          return;
        }

        resolve({
          stdout: stdoutBuf,
          stderr: stderrBuf,
          exitCode,
          durationMs,
          args,
        });
      });
    });
  });
}

/**
 * Convert an aborted AbortSignal into a thrown error. The standard says
 * `signal.reason` is the rejection value; we wrap unknown reasons in `NtnError`
 * so callers always have a typed surface.
 */
function abortReason(
  signal: AbortSignal | undefined,
  args: readonly string[],
  stdout = '',
  stderr = '',
): Error {
  const reason: unknown = signal?.reason;
  if (reason instanceof Error) {
    return reason;
  }
  return new NtnError(
    `ntn ${args.join(' ')} was aborted via AbortSignal`,
    { args, stdout, stderr, cause: reason },
  );
}

/**
 * Convenience: invoke an `ntn` command that returns JSON on stdout, parse it,
 * and surface parse failures as `NtnJsonParseError`. Used by `--json`-aware
 * wrappers (workers list, capabilities, runs, doctor, webhooks, ...).
 */
// Generic T is the typed wrapper contract for callers that validate by command.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
export async function runNtnJson<T>(
  args: readonly string[],
  opts: NtnRunOptions = {},
): Promise<{ data: T; result: NtnRunResult }> {
  const result = await runNtn(args, opts);
  const data = parseNtnJson<T>(result.stdout, args);
  return { data, result };
}
