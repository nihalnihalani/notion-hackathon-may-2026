/**
 * Tests for the in-process sandbox runner.
 *
 * The Vercel runner is NOT tested here — it requires a live Vercel account.
 * The orchestrator package owns the integration test for the Vercel SDK.
 */

import { describe, expect, it } from 'vitest';
import { readFile, stat } from 'node:fs/promises';
import { createInProcessSandbox } from '../src/sandbox.js';

describe('createInProcessSandbox — writeFiles', () => {
  it('persists files into the mkdtemp directory', async () => {
    const sandbox = await createInProcessSandbox();
    try {
      await sandbox.writeFiles([
        { path: 'src/index.ts', content: 'console.log(1);' },
        { path: 'package.json', content: '{"name":"x"}' },
      ]);
      // Use the runner's own `run` to verify the writes are visible.
      const result = await sandbox.run({
        cmd: 'cat',
        args: ['src/index.ts'],
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('console.log(1)');
    } finally {
      await sandbox.close();
    }
  });

  it('respects optional file mode', async () => {
    const sandbox = await createInProcessSandbox();
    try {
      await sandbox.writeFiles([
        { path: 'script.sh', content: '#!/bin/sh\necho hi\n', mode: 0o755 },
      ]);
      // Inspect the mode via stat — we re-discover the path through `run`.
      const pwd = await sandbox.run({ cmd: 'pwd', args: [] });
      const root = pwd.stdout.trim();
      const stats = await stat(`${root}/script.sh`);
      // Last 3 octal digits encode mode bits.
      expect(stats.mode & 0o777).toBe(0o755);
    } finally {
      await sandbox.close();
    }
  });

  it('creates intermediate directories implicitly', async () => {
    const sandbox = await createInProcessSandbox();
    try {
      await sandbox.writeFiles([
        { path: 'a/b/c/deep.txt', content: 'hi' },
      ]);
      const pwd = await sandbox.run({ cmd: 'pwd', args: [] });
      const root = pwd.stdout.trim();
      const contents = await readFile(`${root}/a/b/c/deep.txt`, 'utf8');
      expect(contents).toBe('hi');
    } finally {
      await sandbox.close();
    }
  });
});

describe('createInProcessSandbox — run', () => {
  it('captures stdout and exit 0', async () => {
    const sandbox = await createInProcessSandbox();
    try {
      const result = await sandbox.run({
        cmd: 'node',
        args: ['-e', 'process.stdout.write("hello")'],
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('hello');
      expect(result.stderr).toBe('');
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    } finally {
      await sandbox.close();
    }
  });

  it('captures stderr and non-zero exit code', async () => {
    const sandbox = await createInProcessSandbox();
    try {
      const result = await sandbox.run({
        cmd: 'node',
        args: ['-e', 'process.stderr.write("oops"); process.exit(3)'],
      });
      expect(result.exitCode).toBe(3);
      expect(result.stderr).toBe('oops');
    } finally {
      await sandbox.close();
    }
  });

  it('kills hanging processes via timeoutMs', async () => {
    const sandbox = await createInProcessSandbox();
    try {
      const started = Date.now();
      const result = await sandbox.run({
        cmd: 'node',
        args: ['-e', 'setInterval(() => {}, 1000)'],
        timeoutMs: 250,
      });
      const elapsed = Date.now() - started;
      // 124 is the in-process runner's timeout sentinel (matches `/usr/bin/timeout`).
      expect(result.exitCode).toBe(124);
      expect(result.stderr).toContain('timed out');
      // Should not run anywhere near the full setInterval duration.
      expect(elapsed).toBeLessThan(3000);
    } finally {
      await sandbox.close();
    }
  });

  it('merges per-command env onto the inherited env', async () => {
    const sandbox = await createInProcessSandbox();
    try {
      const result = await sandbox.run({
        cmd: 'node',
        args: ['-e', 'process.stdout.write(process.env.FORGE_TEST_KEY || "missing")'],
        env: { FORGE_TEST_KEY: 'forge-value' },
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('forge-value');
    } finally {
      await sandbox.close();
    }
  });
});

describe('createInProcessSandbox — close', () => {
  it('removes the temp directory', async () => {
    const sandbox = await createInProcessSandbox();
    await sandbox.writeFiles([{ path: 'a.txt', content: 'x' }]);
    const pwd = await sandbox.run({ cmd: 'pwd', args: [] });
    const root = pwd.stdout.trim();
    await sandbox.close();
    await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('is idempotent', async () => {
    const sandbox = await createInProcessSandbox();
    await sandbox.close();
    await expect(sandbox.close()).resolves.toBeUndefined();
  });

  it('rejects writeFiles after close', async () => {
    const sandbox = await createInProcessSandbox();
    await sandbox.close();
    await expect(sandbox.writeFiles([{ path: 'x', content: 'y' }])).rejects.toThrow(
      /after sandbox close/,
    );
  });

  it('rejects run after close', async () => {
    const sandbox = await createInProcessSandbox();
    await sandbox.close();
    await expect(sandbox.run({ cmd: 'echo', args: ['hi'] })).rejects.toThrow(/after sandbox close/);
  });
});
