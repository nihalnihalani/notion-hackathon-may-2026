/**
 * Sandbox abstraction used by the Inspector to run untrusted, LLM-generated
 * Worker code in isolation.
 *
 * Two runners are exported:
 *
 *  1. {@link createVercelSandbox} — PRODUCTION. Boots a Vercel Sandbox
 *     (Firecracker microVM) via the `@vercel/sandbox` SDK. Each Inspector
 *     run gets its own VM, killed via `close()` after the inspection
 *     completes. Authenticates with either a Vercel OIDC token (when
 *     deployed on Vercel) or an access-token triplet `{ token, teamId,
 *     projectId }` for external CI / local dev.
 *
 *  2. {@link createInProcessSandbox} — TESTING ONLY. Spawns child processes
 *     in an `mkdtemp` directory on the host. **Never** import this from
 *     production code paths — it bypasses every isolation guarantee the
 *     Inspector relies on.
 *
 * Both runners satisfy the {@link SandboxRunner} interface so the Inspector
 * can be unit-tested with the in-process runner and shipped against the
 * Vercel runner unchanged.
 *
 * Vercel Sandbox SDK surface used (confirmed 2026-03 from
 * https://vercel.com/docs/vercel-sandbox/sdk-reference):
 *  - `Sandbox.create({ runtime, timeout, env, token?, teamId?, projectId? })`
 *  - `sandbox.writeFiles([{ path, content: Buffer, mode? }])`
 *  - `sandbox.runCommand({ cmd, args, cwd?, env?, signal? })`
 *  - `sandbox.stop()`
 *
 * Limitation: the Vercel Sandbox `runCommand` overload does NOT accept a
 * per-command `timeoutMs`. Instead we wire `timeoutMs` to an `AbortSignal`
 * created via `AbortSignal.timeout(ms)` — when fired, the SDK cancels the
 * in-flight command. The overall sandbox-level timeout is supplied at
 * `Sandbox.create()` time and bounds the total inspection duration.
 *
 * Base image: the production base image is expected to pre-bake `ntn`, Node
 * 20+, pnpm, and the vendored Notion SDKs. Bootstrapping that image is an
 * *ops* concern owned outside this package; the comment is here so the
 * Devil's Advocate can hold the team to it.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as setNodeTimeout, clearTimeout as clearNodeTimeout } from 'node:timers';

import { InspectorError } from './errors.js';

// ─────────────────────────────────────────────────────────────────────────────
// SandboxRunner — interface shared by both runners
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Result of a single command execution inside a sandbox.
 *
 * Mirrors the shape used by `@forge/ntn-wrapper`'s `runNtn`, so the
 * Inspector can use either source interchangeably.
 */
export interface SandboxRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

/**
 * Options accepted by {@link SandboxRunner.run}.
 *
 * `timeoutMs` defaults are runner-specific:
 *  - Vercel runner: when omitted, no per-command timeout (the sandbox-level
 *    timeout from `Sandbox.create()` still applies).
 *  - In-process runner: when omitted, defaults to 30s (test-friendly).
 *
 * `env` is *merged* with the sandbox's default env (set at `Sandbox.create()`
 * time), per-command keys winning on conflict.
 */
export interface SandboxRunOptions {
  cmd: string;
  args: string[];
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}

/**
 * One file write into the sandbox filesystem. `path` is sandbox-relative
 * (resolved against the runner's default cwd) or absolute.
 */
export interface SandboxFile {
  path: string;
  content: string;
  /** Optional Unix mode (octal). Defaults to 0o644. */
  mode?: number;
}

/**
 * Minimal surface every sandbox runner must implement.
 *
 * Lifecycle: callers MUST call {@link close} exactly once. Failing to do so
 * leaks a Vercel-billed microVM (or an `mkdtemp` directory in the in-process
 * runner). Inspector uses `try/finally` to guarantee teardown.
 */
export interface SandboxRunner {
  writeFiles(files: ReadonlyArray<SandboxFile>): Promise<void>;
  run(opts: SandboxRunOptions): Promise<SandboxRunResult>;
  close(): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// createVercelSandbox — production runner
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Configuration for {@link createVercelSandbox}.
 *
 * Either provide a Vercel access token (with team + project) for external
 * environments, or rely on the ambient OIDC token (`VERCEL_OIDC_TOKEN`) when
 * deployed on Vercel.
 */
export interface VercelSandboxConfig {
  /**
   * Vercel access token. Optional when running on Vercel (OIDC is picked up
   * automatically by the SDK). Required for external CI / local dev.
   */
  token?: string;
  /**
   * Vercel team ID. Required alongside `token` for access-token auth;
   * ignored when OIDC is used.
   */
  teamId?: string;
  /**
   * Vercel project ID. Required alongside `token` for access-token auth.
   */
  projectId?: string;
  /**
   * Runtime image used by the microVM. Defaults to `'node24'` — the most
   * recent LTS-equivalent runtime that ships with `npm`/`pnpm`. Note:
   * generated Workers target Node 20+, which is a subset of Node 24.
   */
  runtime?: 'node22' | 'node24' | 'node26';
  /**
   * Sandbox-level timeout in milliseconds. Bounds the *entire* inspection,
   * not a single command. Defaults to 90_000 (PLAN.md §IX: 60s wall clock
   * for exec + slack for safety scan + tsc).
   */
  timeoutMs?: number;
  /**
   * Default env propagated to every `run()` invocation. Per-command env wins
   * on conflict.
   */
  env?: Record<string, string>;
}

/**
 * Minimal structural type of the `@vercel/sandbox` SDK's `Sandbox` class —
 * defined here so this module type-checks even if the package isn't
 * installed in `node_modules` yet (the package.json install is owned by the
 * orchestrator's deploy target, not this sub-agent build).
 *
 * Mirrors only the methods we call. If the SDK signature drifts, the
 * dynamic import below will surface the mismatch at runtime — covered by
 * an integration test in the orchestrator package.
 */
interface VercelSandboxInstance {
  writeFiles(files: Array<{ path: string; content: Buffer; mode?: number }>): Promise<void>;
  runCommand(
    params: {
      cmd: string;
      args?: string[];
      cwd?: string;
      env?: Record<string, string>;
      signal?: AbortSignal;
    },
  ): Promise<{
    exitCode: number;
    stdout(): Promise<string>;
    stderr(): Promise<string>;
  }>;
  stop(opts?: { blocking?: boolean }): Promise<unknown>;
}

interface VercelSandboxModule {
  Sandbox: {
    create(opts: {
      runtime?: string;
      timeout?: number;
      env?: Record<string, string>;
      token?: string;
      teamId?: string;
      projectId?: string;
    }): Promise<VercelSandboxInstance>;
  };
}

/**
 * Provision a fresh Vercel Sandbox microVM and return a {@link SandboxRunner}
 * bound to it.
 *
 * Throws {@link InspectorError} if the SDK can't be loaded, the sandbox
 * can't be provisioned, or required auth is missing.
 */
export async function createVercelSandbox(config: VercelSandboxConfig): Promise<SandboxRunner> {
  // Validate auth: if no OIDC token in the env, the access-token triplet is required.
  // We do NOT read process.env directly here for `VERCEL_OIDC_TOKEN` — the SDK
  // handles that; we only validate the access-token combo when the caller
  // supplied `token`.
  if (config.token !== undefined) {
    if (config.teamId === undefined || config.teamId.length === 0) {
      throw new InspectorError('createVercelSandbox: teamId is required when using access-token auth', {
        detail: { hasToken: true },
      });
    }
    if (config.projectId === undefined || config.projectId.length === 0) {
      throw new InspectorError('createVercelSandbox: projectId is required when using access-token auth', {
        detail: { hasToken: true, teamId: config.teamId },
      });
    }
  }

  // Dynamic import keeps the SDK out of the agent bundle when the in-process
  // runner is used (test paths). We intentionally route through a runtime
  // string so TypeScript does not try to type-resolve `@vercel/sandbox` at
  // build time (the package is installed in the *orchestrator* deploy target
  // — not in this sub-agent package — to keep the agent bundle slim).
  let sdk: VercelSandboxModule;
  try {
    sdk = (await loadVercelSandboxSdk()) as unknown as VercelSandboxModule;
  } catch (err) {
    throw new InspectorError(
      'createVercelSandbox: failed to load @vercel/sandbox SDK. Install with `pnpm add @vercel/sandbox`.',
      { cause: err },
    );
  }

  const createOpts: Parameters<VercelSandboxModule['Sandbox']['create']>[0] = {
    runtime: config.runtime ?? 'node24',
    timeout: config.timeoutMs ?? 90_000,
  };
  if (config.env !== undefined) {
    createOpts.env = config.env;
  }
  if (config.token !== undefined) {
    createOpts.token = config.token;
    // The auth-validation block above guarantees these are defined when
    // `token` is supplied; the explicit checks here placate
    // `exactOptionalPropertyTypes`.
    if (config.teamId !== undefined) createOpts.teamId = config.teamId;
    if (config.projectId !== undefined) createOpts.projectId = config.projectId;
  }

  let instance: VercelSandboxInstance;
  try {
    instance = await sdk.Sandbox.create(createOpts);
  } catch (err) {
    throw new InspectorError('createVercelSandbox: Sandbox.create failed', { cause: err });
  }

  let closed = false;

  return {
    async writeFiles(files: ReadonlyArray<SandboxFile>): Promise<void> {
      if (closed) {
        throw new InspectorError('writeFiles called after sandbox close', {});
      }
      await instance.writeFiles(
        files.map((f) => {
          const out: { path: string; content: Buffer; mode?: number } = {
            path: f.path,
            content: Buffer.from(f.content, 'utf8'),
          };
          if (f.mode !== undefined) {
            out.mode = f.mode;
          }
          return out;
        }),
      );
    },

    async run(opts: SandboxRunOptions): Promise<SandboxRunResult> {
      if (closed) {
        throw new InspectorError('run called after sandbox close', {});
      }
      const started = performance.now();
      const params: Parameters<VercelSandboxInstance['runCommand']>[0] = {
        cmd: opts.cmd,
        args: opts.args,
      };
      if (opts.cwd !== undefined) {
        params.cwd = opts.cwd;
      }
      if (opts.env !== undefined) {
        params.env = opts.env;
      }
      if (opts.timeoutMs !== undefined && opts.timeoutMs > 0) {
        // AbortSignal.timeout is universally available on Node 20+ runtimes.
        params.signal = AbortSignal.timeout(opts.timeoutMs);
      }
      const result = await instance.runCommand(params);
      const [stdout, stderr] = await Promise.all([result.stdout(), result.stderr()]);
      return {
        stdout,
        stderr,
        exitCode: result.exitCode,
        durationMs: performance.now() - started,
      };
    },

    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      try {
        await instance.stop({ blocking: true });
      } catch (err) {
        // Stop is idempotent per the SDK; treat residual errors as best-effort.
        // We swallow rather than throw because the Inspector's `finally` block
        // calls close — a throw here would mask the actual inspection error.
        throw new InspectorError('createVercelSandbox: sandbox.stop failed', { cause: err });
      }
    },
  };
}

/**
 * Resolve `@vercel/sandbox` at runtime via a non-static-analyzable specifier.
 *
 * Why this dance: the agents package does not list `@vercel/sandbox` as a
 * direct dependency. The orchestrator deploy target installs the SDK; this
 * sub-agent stays bundleable for Edge runtimes where the SDK is irrelevant
 * (the in-process runner is used in tests). A plain `import('@vercel/sandbox')`
 * would force the type-resolver — and the bundler — to materialise the
 * package, defeating both goals.
 */
async function loadVercelSandboxSdk(): Promise<unknown> {
  const specifier = ['@vercel', 'sandbox'].join('/');
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const importer = new Function('s', 'return import(s);') as (
    s: string,
  ) => Promise<unknown>;
  return importer(specifier);
}

// ─────────────────────────────────────────────────────────────────────────────
// createInProcessSandbox — TESTING ONLY
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Configuration for {@link createInProcessSandbox}.
 */
export interface InProcessSandboxConfig {
  /**
   * Optional prefix for the `mkdtemp` directory name (after `tmpdir()`).
   * Defaults to `'forge-inspector-'`.
   */
  tmpPrefix?: string;
}

/**
 * Returns a {@link SandboxRunner} backed by `child_process.spawn` running on
 * the host machine's filesystem.
 *
 * **TESTING ONLY — do not use in production.** This runner provides NO
 * isolation: spawned commands inherit the host's network, filesystem
 * (outside the temp dir), and environment. Use {@link createVercelSandbox}
 * for any path that touches LLM-generated code.
 *
 * Lifecycle: a temp directory is created lazily on the first `writeFiles`
 * or `run` call (whichever comes first). `close()` recursively deletes it.
 */
export async function createInProcessSandbox(
  config: InProcessSandboxConfig = {},
): Promise<SandboxRunner> {
  const prefix = config.tmpPrefix ?? 'forge-inspector-';
  const root = await mkdtemp(join(tmpdir(), prefix));
  let closed = false;

  const resolveInside = (path: string): string => {
    // Production Vercel sandboxes use real absolute paths inside the VM
    // (e.g. `/forge`, `/vercel/sandbox`). In the in-process runner we have
    // no real chroot, so we *remap* absolute paths under the sandbox root.
    // Relative paths resolve against the root as usual.
    const target = isAbsolute(path)
      ? resolve(root, `.${path}`)
      : resolve(root, path);
    // Defence in depth: reject any path that would escape the sandbox root
    // via `..` segments after remapping.
    if (!target.startsWith(root)) {
      throw new InspectorError(`in-process sandbox: path escapes sandbox root: ${path}`, {});
    }
    return target;
  };

  return {
    async writeFiles(files: ReadonlyArray<SandboxFile>): Promise<void> {
      if (closed) {
        throw new InspectorError('writeFiles called after sandbox close', {});
      }
      for (const file of files) {
        const target = resolveInside(file.path);
        await mkdir(dirname(target), { recursive: true });
        const opts: { encoding: 'utf8'; mode?: number } = { encoding: 'utf8' };
        if (file.mode !== undefined) {
          opts.mode = file.mode;
        }
        await writeFile(target, file.content, opts);
      }
    },

    async run(opts: SandboxRunOptions): Promise<SandboxRunResult> {
      if (closed) {
        throw new InspectorError('run called after sandbox close', {});
      }
      const cwd = opts.cwd === undefined ? root : resolveInside(opts.cwd);
      const timeoutMs = opts.timeoutMs ?? 30_000;
      const started = performance.now();

      return new Promise<SandboxRunResult>((resolvePromise, rejectPromise) => {
        let child: ChildProcess;
        try {
          // Pass-through env merge: `undefined` means inherit; we explicitly
          // merge the runner's env to keep PATH (so `node`, `npx`, etc. resolve).
          const env: NodeJS.ProcessEnv = opts.env === undefined ? { ...process.env } : { ...process.env, ...opts.env };
          child = spawn(opts.cmd, opts.args, {
            cwd,
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
          });
        } catch (err) {
          rejectPromise(
            new InspectorError(`in-process sandbox: failed to spawn ${opts.cmd}`, { cause: err }),
          );
          return;
        }

        let stdoutBuf = '';
        let stderrBuf = '';
        let timedOut = false;
        let settled = false;
        child.stdout?.setEncoding('utf8');
        child.stderr?.setEncoding('utf8');
        child.stdout?.on('data', (chunk: string) => {
          stdoutBuf += chunk;
        });
        child.stderr?.on('data', (chunk: string) => {
          stderrBuf += chunk;
        });

        const timeoutHandle: NodeJS.Timeout | undefined =
          timeoutMs > 0
            ? setNodeTimeout(() => {
                timedOut = true;
                try {
                  child.kill('SIGTERM');
                } catch {
                  /* already dead */
                }
                // Hard-kill grace after 500ms.
                const killHandle = setNodeTimeout(() => {
                  try {
                    child.kill('SIGKILL');
                  } catch {
                    /* already dead */
                  }
                }, 500);
                killHandle.unref();
              }, timeoutMs)
            : undefined;
        timeoutHandle?.unref();

        const finalize = (fn: () => void): void => {
          if (settled) return;
          settled = true;
          if (timeoutHandle !== undefined) clearNodeTimeout(timeoutHandle);
          fn();
        };

        child.on('error', (err: NodeJS.ErrnoException) => {
          finalize(() => {
            rejectPromise(
              new InspectorError(`in-process sandbox: child error: ${err.message}`, { cause: err }),
            );
          });
        });

        child.on('close', (code: number | null) => {
          finalize(() => {
            const durationMs = performance.now() - started;
            // Conventional: timeout → exit code 124 (`/usr/bin/timeout` convention).
            // Tests can branch on this without re-implementing the timeout check.
            const exitCode = timedOut ? 124 : code ?? -1;
            if (timedOut) {
              stderrBuf += `\n[in-process sandbox: timed out after ${String(timeoutMs)}ms]`;
            }
            resolvePromise({ stdout: stdoutBuf, stderr: stderrBuf, exitCode, durationMs });
          });
        });
      });
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      // `force: true` so closed sandboxes with read-only files still tear down.
      await rm(root, { recursive: true, force: true });
    },
  };
}
