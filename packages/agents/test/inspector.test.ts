/**
 * Inspector tests.
 *
 * Strategy: use the {@link createInProcessSandbox} runner for the FS + spawn
 * surface (real `node` / `npx tsc` subprocesses for the happy path), and
 * mock `@forge/ntn-wrapper`'s `deployWorker` / `execWorker` per test to
 * cover the dry-run / exec failure modes.
 *
 * The `ntn` CLI is NOT available in CI, so we always mock the wrapper
 * functions — the in-process runner is only exercised for FS writes + tsc.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Hoist the mock so it runs before the module under test resolves the import.
vi.mock('@forge/ntn-wrapper', async () => {
  const actual = await vi.importActual<typeof import('@forge/ntn-wrapper')>('@forge/ntn-wrapper');
  return {
    ...actual,
    deployWorker: vi.fn(),
    execWorker: vi.fn(),
  };
});

import { deployWorker, execWorker, NtnExecError } from '@forge/ntn-wrapper';
import { inspector } from '../src/inspector.js';
import { createInProcessSandbox, type SandboxRunner } from '../src/sandbox.js';
import type {
  InspectionResult,
  SchemaSmithOutput,
  ToolCoderOutput,
  SubAgentLogger,
} from '../src/types.js';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const SAFE_SOURCE = `
import { z } from 'zod';
export const inputSchema = z.object({ severity: z.string() });
export const handler = async (input: { severity: string }) => ({ ok: true });
`;

const EVAL_SOURCE = `
export const handler = async () => {
  return eval('1 + 1');
};
`;

const TSC_BROKEN_SOURCE = `
const x: string = 1;
export const handler = async () => x;
`;

const SAMPLE_SCHEMA: SchemaSmithOutput = {
  pattern: 'database-query',
  inputSchema: {
    kind: 'object',
    describe: 'In',
    properties: { severity: { kind: 'string', describe: 'sev' } },
    required: ['severity'],
  },
  outputSchema: {
    kind: 'object',
    describe: 'Out',
    properties: { ok: { kind: 'boolean', describe: 'ok' } },
    required: ['ok'],
  },
  requiredScopes: [],
  requiredOAuth: [],
  rationale: 'fixture',
};

function buildCode(source: string): ToolCoderOutput {
  return {
    source,
    sourceLines: source.split('\n').length,
    packageJsonPatch: { dependencies: { zod: '3.23.8' } },
    workerName: 'forge-test-worker',
  };
}

function captureLogger(): { logger: SubAgentLogger; events: Array<{ msg: string; meta?: Record<string, unknown> }> } {
  const events: Array<{ msg: string; meta?: Record<string, unknown> }> = [];
  return {
    events,
    logger: {
      info: (msg, meta) => events.push({ msg, ...(meta ? { meta } : {}) }),
      error: () => {
        /* no-op */
      },
    },
  };
}

// ─── Lifecycle helpers ──────────────────────────────────────────────────────

let sandbox: SandboxRunner;

beforeEach(async () => {
  sandbox = await createInProcessSandbox();
  vi.mocked(deployWorker).mockReset();
  vi.mocked(execWorker).mockReset();
});

afterEach(async () => {
  await sandbox.close();
});

// ─── Stage 1: safety ────────────────────────────────────────────────────────

describe('inspector — safety stage', () => {
  it('returns pass=false / stage=safety when the source contains eval', async () => {
    const result = await inspector({
      generationId: 'gen-1',
      code: buildCode(EVAL_SOURCE),
      schema: SAMPLE_SCHEMA,
      config: { anthropicApiKey: 'x', sandbox },
    });
    expect(result.pass).toBe(false);
    expect(result.stage).toBe('safety');
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.join('\n')).toMatch(/eval/i);
    expect(vi.mocked(deployWorker)).not.toHaveBeenCalled();
  });

  it('rejects a package.json with non-allowlisted dependencies', async () => {
    const code: ToolCoderOutput = {
      ...buildCode(SAFE_SOURCE),
      packageJsonPatch: { dependencies: { lodash: '4.17.21' } },
    };
    const result = await inspector({
      generationId: 'gen-2',
      code,
      schema: SAMPLE_SCHEMA,
      config: { anthropicApiKey: 'x', sandbox },
    });
    expect(result.pass).toBe(false);
    expect(result.stage).toBe('safety');
    expect(result.errors.join('\n')).toMatch(/lodash/);
  });

  it('does not throw on a syntactically invalid source', async () => {
    const result = await inspector({
      generationId: 'gen-3',
      code: buildCode('this is not valid typescript {{{{'),
      schema: SAMPLE_SCHEMA,
      config: { anthropicApiKey: 'x', sandbox },
    });
    expect(result.pass).toBe(false);
    expect(result.stage).toBe('safety');
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

// ─── Stage 3: tsc ────────────────────────────────────────────────────────────

describe('inspector — tsc stage', () => {
  // tsc requires `npx tsc` to be resolvable on PATH; skip if it isn't.
  // Most dev environments have it via the workspace install.
  it('returns pass=false / stage=tsc on a type mismatch', async () => {
    const result = await inspector({
      generationId: 'gen-tsc',
      code: buildCode(TSC_BROKEN_SOURCE),
      schema: SAMPLE_SCHEMA,
      config: { anthropicApiKey: 'x', sandbox },
    });
    expect(result.pass).toBe(false);
    // npx might fail to resolve tsc in a barebones CI; both 'tsc' and a
    // generic spawn error live under the same `tsc` stage classification.
    expect(result.stage).toBe('tsc');
    expect(result.errors.length).toBeGreaterThan(0);
    expect(vi.mocked(deployWorker)).not.toHaveBeenCalled();
  }, 60_000);
});

// ─── Stage 4: dryrun ────────────────────────────────────────────────────────

describe('inspector — dryrun stage', () => {
  it('returns pass=false / stage=dryrun when deployWorker rejects', async () => {
    // Need to bypass tsc — use a runner that fakes tsc success.
    const fakeSandbox: SandboxRunner = {
      writeFiles: async () => {
        /* no-op */
      },
      run: async () => ({ stdout: '', stderr: '', exitCode: 0, durationMs: 1 }),
      close: async () => {
        /* no-op */
      },
    };
    vi.mocked(deployWorker).mockRejectedValueOnce(
      new NtnExecError({
        args: ['workers', 'deploy', '--dry-run'],
        exitCode: 1,
        stderr: 'invalid worker config',
        stdout: '',
      }),
    );
    const result = await inspector({
      generationId: 'gen-dr',
      code: buildCode(SAFE_SOURCE),
      schema: SAMPLE_SCHEMA,
      config: { anthropicApiKey: 'x', sandbox: fakeSandbox },
    });
    expect(result.pass).toBe(false);
    expect(result.stage).toBe('dryrun');
    expect(result.errors.join('\n')).toContain('invalid worker config');
    expect(vi.mocked(execWorker)).not.toHaveBeenCalled();
  });
});

// ─── Stage 5: exec ──────────────────────────────────────────────────────────

describe('inspector — exec stage', () => {
  const fakeSandbox = (): SandboxRunner => ({
    writeFiles: async () => {
      /* no-op */
    },
    run: async () => ({ stdout: '', stderr: '', exitCode: 0, durationMs: 1 }),
    close: async () => {
      /* no-op */
    },
  });

  it('returns pass=false / stage=exec when execWorker rejects with NtnExecError', async () => {
    vi.mocked(deployWorker).mockResolvedValueOnce({
      workerName: 'forge-test-worker',
      dryRun: true,
      rawStdout: '',
    });
    vi.mocked(execWorker).mockRejectedValueOnce(
      new NtnExecError({
        args: ['workers', 'exec'],
        exitCode: 5,
        stderr: 'runtime error',
        stdout: '',
      }),
    );
    const result = await inspector({
      generationId: 'gen-exec',
      code: buildCode(SAFE_SOURCE),
      schema: SAMPLE_SCHEMA,
      config: { anthropicApiKey: 'x', sandbox: fakeSandbox() },
    });
    expect(result.pass).toBe(false);
    expect(result.stage).toBe('exec');
    expect(result.errors.join('\n')).toContain('runtime error');
  });

  it('returns pass=false / stage=exec when Worker output fails outputSchema validation', async () => {
    vi.mocked(deployWorker).mockResolvedValueOnce({
      workerName: 'forge-test-worker',
      dryRun: true,
      rawStdout: '',
    });
    // Output { ok: 'yes' } violates outputSchema (ok: boolean).
    vi.mocked(execWorker).mockResolvedValueOnce({
      output: { ok: 'yes' },
      raw: '{"ok":"yes"}',
      durationMs: 100,
    });
    const result = await inspector({
      generationId: 'gen-exec-schema',
      code: buildCode(SAFE_SOURCE),
      schema: SAMPLE_SCHEMA,
      config: { anthropicApiKey: 'x', sandbox: fakeSandbox() },
    });
    expect(result.pass).toBe(false);
    expect(result.stage).toBe('exec');
    expect(result.errors.join('\n')).toMatch(/schema validation/);
  });

  it('returns pass=false / stage=exec when Worker produces no parseable output', async () => {
    vi.mocked(deployWorker).mockResolvedValueOnce({
      workerName: 'forge-test-worker',
      dryRun: true,
      rawStdout: '',
    });
    vi.mocked(execWorker).mockResolvedValueOnce({
      output: undefined,
      raw: 'not json',
      durationMs: 100,
    });
    const result = await inspector({
      generationId: 'gen-exec-noout',
      code: buildCode(SAFE_SOURCE),
      schema: SAMPLE_SCHEMA,
      config: { anthropicApiKey: 'x', sandbox: fakeSandbox() },
    });
    expect(result.pass).toBe(false);
    expect(result.stage).toBe('exec');
    expect(result.errors.join('\n')).toMatch(/no parseable JSON/);
  });

  it('returns pass=true on a fully clean run', async () => {
    vi.mocked(deployWorker).mockResolvedValueOnce({
      workerName: 'forge-test-worker',
      dryRun: true,
      rawStdout: '',
    });
    vi.mocked(execWorker).mockResolvedValueOnce({
      output: { ok: true },
      raw: '{"ok":true}',
      durationMs: 200,
    });
    const result = await inspector({
      generationId: 'gen-ok',
      code: buildCode(SAFE_SOURCE),
      schema: SAMPLE_SCHEMA,
      config: { anthropicApiKey: 'x', sandbox: fakeSandbox() },
    });
    expect(result.pass).toBe(true);
    expect(result.stage).toBe('exec');
    expect(result.errors).toEqual([]);
    expect(result.output).toEqual({ ok: true });
    expect(result.durationMs).toBeGreaterThan(0);
  });
});

// ─── Cross-cutting: durations, logger, no-throw guarantees ─────────────────

describe('inspector — cross-cutting behavior', () => {
  const fakeSandbox = (): SandboxRunner => ({
    writeFiles: async () => {
      /* no-op */
    },
    run: async () => ({ stdout: '', stderr: '', exitCode: 0, durationMs: 1 }),
    close: async () => {
      /* no-op */
    },
  });

  it('tracks durationMs across all stages', async () => {
    vi.mocked(deployWorker).mockResolvedValueOnce({
      workerName: 'forge-test-worker',
      dryRun: true,
      rawStdout: '',
    });
    vi.mocked(execWorker).mockResolvedValueOnce({
      output: { ok: true },
      raw: '{"ok":true}',
      durationMs: 50,
    });
    const result = await inspector({
      generationId: 'gen-dur',
      code: buildCode(SAFE_SOURCE),
      schema: SAMPLE_SCHEMA,
      config: { anthropicApiKey: 'x', sandbox: fakeSandbox() },
    });
    expect(result.durationMs).toBeGreaterThan(0);
    // Sanity bound — clean fast path should complete in under a few seconds.
    expect(result.durationMs).toBeLessThan(60_000);
  });

  it('emits inspector.stage log events for each stage reached', async () => {
    vi.mocked(deployWorker).mockResolvedValueOnce({
      workerName: 'forge-test-worker',
      dryRun: true,
      rawStdout: '',
    });
    vi.mocked(execWorker).mockResolvedValueOnce({
      output: { ok: true },
      raw: '{"ok":true}',
      durationMs: 50,
    });
    const { logger, events } = captureLogger();
    await inspector({
      generationId: 'gen-log',
      code: buildCode(SAFE_SOURCE),
      schema: SAMPLE_SCHEMA,
      config: { anthropicApiKey: 'x', sandbox: fakeSandbox(), logger },
    });
    const stageEvents = events.filter((e) => e.msg === 'inspector.stage');
    // safety + tsc + dryrun + exec
    expect(stageEvents.length).toBe(4);
    const stages = stageEvents.map((e) => e.meta?.['stage']);
    expect(stages).toEqual(['safety', 'tsc', 'dryrun', 'exec']);
  });

  it('never throws on a validation failure (returns InspectionResult)', async () => {
    // Force a failure cascade: eval source → safety fails. No throw expected.
    const promise = inspector({
      generationId: 'gen-nothrow',
      code: buildCode(EVAL_SOURCE),
      schema: SAMPLE_SCHEMA,
      config: { anthropicApiKey: 'x', sandbox: fakeSandbox() },
    });
    await expect(promise).resolves.toBeDefined();
    const result: InspectionResult = await promise;
    expect(result.pass).toBe(false);
  });

  it('throws InspectorError when the sandbox itself fails to writeFiles', async () => {
    const brokenSandbox: SandboxRunner = {
      writeFiles: async () => {
        throw new Error('disk full');
      },
      run: async () => ({ stdout: '', stderr: '', exitCode: 0, durationMs: 0 }),
      close: async () => {
        /* no-op */
      },
    };
    await expect(
      inspector({
        generationId: 'gen-infra',
        code: buildCode(SAFE_SOURCE),
        schema: SAMPLE_SCHEMA,
        config: { anthropicApiKey: 'x', sandbox: brokenSandbox },
      }),
    ).rejects.toThrow(/failed to write files into sandbox/);
  });
});
