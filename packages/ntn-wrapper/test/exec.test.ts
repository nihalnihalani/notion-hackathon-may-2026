/**
 * Tests for `runNtn`. We avoid requiring a real `ntn` binary by passing
 * `binary: process.execPath` (the current Node) and constructing args
 * around `-e '<inline script>'`. This keeps the tests hermetic and fast.
 */

import { describe, expect, it } from 'vitest';

import {
  runNtn,
  NtnExecError,
  NtnNotInstalledError,
  NtnTimeoutError,
  NtnError,
} from '../src/index';

const NODE = process.execPath;

/** Build args that make Node print/exit on our behalf. */
const args = (script: string): string[] => ['-e', script];

describe('runNtn', () => {
  it('captures stdout, stderr, and exit code on success', async () => {
    const result = await runNtn(
      args(
        `process.stdout.write("hello-out"); process.stderr.write("hello-err"); process.exit(0);`,
      ),
      { binary: NODE, timeoutMs: 10_000 },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hello-out');
    expect(result.stderr).toBe('hello-err');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.args[0]).toBe('-e');
    expect(typeof result.args[1]).toBe('string');
  });

  it('throws NtnExecError on non-zero exit and preserves stderr/exitCode', async () => {
    await expect(
      runNtn(
        args(`process.stderr.write("boom"); process.exit(7);`),
        { binary: NODE, timeoutMs: 10_000 },
      ),
    ).rejects.toMatchObject({
      name: 'NtnExecError',
      exitCode: 7,
      stderr: 'boom',
    });

    // Confirm the type is NtnExecError specifically (and a subclass of NtnError).
    try {
      await runNtn(
        args(`process.exit(2);`),
        { binary: NODE, timeoutMs: 10_000 },
      );
      throw new Error('should have rejected');
    } catch (err) {
      expect(err).toBeInstanceOf(NtnExecError);
      expect(err).toBeInstanceOf(NtnError);
    }
  });

  it('throws NtnTimeoutError when the child outlives the timeout', async () => {
    // Sleep ~2s but time out at 100ms.
    const promise = runNtn(
      args(`setTimeout(() => process.exit(0), 2000);`),
      { binary: NODE, timeoutMs: 100 },
    );

    await expect(promise).rejects.toBeInstanceOf(NtnTimeoutError);
    await expect(promise).rejects.toMatchObject({ timeoutMs: 100 });
  });

  it('throws NtnNotInstalledError when binary is missing (ENOENT)', async () => {
    await expect(
      runNtn(['workers', 'list'], {
        binary: '/nonexistent/path/to/ntn-binary-xyz',
        timeoutMs: 5_000,
      }),
    ).rejects.toBeInstanceOf(NtnNotInstalledError);
  });

  it('honours AbortSignal cancellation', async () => {
    const controller = new AbortController();
    const promise = runNtn(
      args(`setTimeout(() => process.exit(0), 5000);`),
      { binary: NODE, timeoutMs: 10_000, signal: controller.signal },
    );

    // Abort after a microtask so the child has started.
    setTimeout(() => controller.abort(), 50);

    await expect(promise).rejects.toBeDefined();
  });

  it('throws synchronously when AbortSignal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      runNtn(args(`process.exit(0);`), {
        binary: NODE,
        signal: controller.signal,
      }),
    ).rejects.toBeDefined();
  });

  it('disables the timeout when timeoutMs is 0', async () => {
    // A short script that exits quickly — should complete without a timer.
    const result = await runNtn(
      args(`process.stdout.write("ok"); process.exit(0);`),
      { binary: NODE, timeoutMs: 0 },
    );
    expect(result.stdout).toBe('ok');
  });

  it('passes stdin to the child', async () => {
    const result = await runNtn(
      args(
        `let chunks = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", c => chunks += c); process.stdin.on("end", () => { process.stdout.write(chunks); process.exit(0); });`,
      ),
      { binary: NODE, timeoutMs: 10_000, stdin: 'piped-input' },
    );
    expect(result.stdout).toBe('piped-input');
  });

  it('truncates stdout when it exceeds maxStdoutBytes', async () => {
    // Print 5000 bytes but cap at 100.
    const result = await runNtn(
      args(
        `process.stdout.write("x".repeat(5000)); process.exit(0);`,
      ),
      { binary: NODE, timeoutMs: 10_000, maxStdoutBytes: 100 },
    );
    expect(result.stdout.length).toBeGreaterThanOrEqual(100);
    expect(result.stdout).toContain('truncated');
  });

  it('respects cwd', async () => {
    const result = await runNtn(
      args(`process.stdout.write(process.cwd()); process.exit(0);`),
      { binary: NODE, timeoutMs: 10_000, cwd: '/' },
    );
    expect(result.stdout).toBe('/');
  });

  it('respects env overrides', async () => {
    const result = await runNtn(
      args(
        `process.stdout.write(process.env.FORGE_TEST_VAR || "missing"); process.exit(0);`,
      ),
      {
        binary: NODE,
        timeoutMs: 10_000,
        env: { ...process.env, FORGE_TEST_VAR: 'present' } as Record<string, string>,
      },
    );
    expect(result.stdout).toBe('present');
  });

  it('invokes the logger when supplied', async () => {
    const events: string[] = [];
    const logger = {
      debug: (msg: string) => events.push(`debug:${msg}`),
      info: (msg: string) => events.push(`info:${msg}`),
      warn: (msg: string) => events.push(`warn:${msg}`),
      error: (msg: string) => events.push(`error:${msg}`),
    };
    await runNtn(args(`process.exit(0);`), {
      binary: NODE,
      timeoutMs: 10_000,
      logger,
    });
    expect(events.some((e) => e.startsWith('debug:ntn-wrapper.spawn'))).toBe(true);
    expect(events.some((e) => e.startsWith('debug:ntn-wrapper.exit'))).toBe(true);
  });
});
