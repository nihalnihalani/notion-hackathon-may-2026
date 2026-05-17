/**
 * Inspector — the third Forge sub-agent.
 *
 * Job (PLAN.md §IV.3):
 *
 *   Prove the Tool-Coder-generated Worker (a) is safe, (b) compiles, (c) deploys
 *   end-to-end in a `--dry-run`, and (d) actually runs against synthetic input.
 *
 * No model call. This is pure orchestration of the safety scanner +
 * `tsc --noEmit` + `ntn workers deploy --dry-run` + `ntn workers exec`, all
 * executed inside an isolated sandbox via the {@link SandboxRunner}
 * interface.
 *
 * Production behavior:
 *
 *  1. **Safety scan** (`@forge/safety/scan` + `scanPackageJson`).
 *     Combines the rule violations from the source AST and the package.json
 *     dep allowlist. Any `block`-severity violation fails the stage.
 *
 *  2. **Write to sandbox FS**. The Worker source lands at `src/index.ts`,
 *     the merged package.json lands at `package.json`, and a minimal tsconfig
 *     lands at `tsconfig.json` so `tsc --noEmit` has a config to read.
 *
 *  3. **tsc --noEmit**. Runs inside the sandbox via `npx tsc --noEmit`.
 *     A non-zero exit code is a stage failure — we parse the tsc diagnostics
 *     so Tool Coder can retry with structured errors.
 *
 *  4. **ntn workers deploy --dry-run**. Validates against the Notion Workers
 *     control plane without publishing. The wrapper from `@forge/ntn-wrapper`
 *     is invoked *inside* the sandbox (the base image pre-bakes `ntn`).
 *
 *  5. **ntn workers exec**. Generates a synthetic input from
 *     `schema.inputSchema`, executes the Worker, and validates the captured
 *     output against `schema.outputSchema`.
 *
 * Fail-fast: the function returns AS SOON AS a stage reports failure. The
 * orchestrator interprets `{ pass: false, stage }` as "feed back to Tool
 * Coder for retry" — we never need to run the later stages once an earlier
 * one fails.
 *
 * Failure surface:
 *  - "Validation failed" → `{ pass: false, stage, errors }` (never throws).
 *  - "Infrastructure broke" (sandbox unreachable, OOM) → throws
 *    {@link InspectorError}. The Workflow's outer retry loop will re-create
 *    the sandbox; only the orchestrator sees these.
 */

import { performance } from 'node:perf_hooks';

import {
  DEFAULT_DEP_ALLOWLIST,
  DEFAULT_NETWORK_ALLOWLIST,
  scan,
  scanPackageJson,
  type ScanOptions,
  type Violation,
} from '@forge/safety';
import { deployWorker, execWorker, NtnExecError } from '@forge/ntn-wrapper';

import { InspectorError } from './errors.js';
import type { SandboxRunner } from './sandbox.js';
import { generateSynthetic, validateAgainstOutputSchema } from './synthetic.js';
import { parseTscErrors } from './tsc-error-parser.js';
import {
  noopLogger,
  type InspectionResult,
  type SchemaSmithOutput,
  type SubAgentConfig,
  type SubAgentLogger,
  type ToolCoderOutput,
} from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Public input
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Per-generation context layered on top of {@link SubAgentConfig}.
 *
 * `sandbox` is REQUIRED in production — the orchestrator calls
 * {@link import('./sandbox.js').createVercelSandbox} before invoking the
 * Inspector. Tests can pass {@link import('./sandbox.js').createInProcessSandbox}.
 */
export interface InspectorInput {
  /** Stable generation id — used in log lines and error details for tracing. */
  generationId: string;
  /** Tool Coder's structured output (source + package.json patch + worker name). */
  code: ToolCoderOutput;
  /** Schema Smith's structured output (input + output schemas). */
  schema: SchemaSmithOutput;
  /**
   * Sub-agent config + the per-generation sandbox. The runner is owned by
   * the orchestrator; Inspector never calls `close()` on it (the orchestrator
   * does so in its `finally`).
   */
  config: SubAgentConfig & { sandbox: SandboxRunner };
}

// Canonical filenames inside the sandbox. Kept here (not inlined) so callers
// hunting for "what does the sandbox look like" find one source of truth.
const SANDBOX_CWD = '/forge';
const SOURCE_FILENAME = 'src/index.ts';
const PACKAGE_JSON_FILENAME = 'package.json';
const TSCONFIG_FILENAME = 'tsconfig.json';

// Timeouts (ms). Conservative defaults that match the §IX budget of 60s wall
// clock for exec + slack for the prior stages.
const TSC_TIMEOUT_MS = 30_000;
const DRYRUN_TIMEOUT_MS = 60_000;
const EXEC_TIMEOUT_MS = 60_000;

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run Inspector on `input` and return an {@link InspectionResult}.
 *
 * Guarantees:
 *  - NEVER throws on a validation failure — returns
 *    `{ pass: false, stage, errors }` instead.
 *  - Throws {@link InspectorError} ONLY on infrastructure failures (the
 *    sandbox runner itself rejecting in a way we can't classify).
 *  - Emits `logger.info('inspector.stage', { stage, pass, durationMs })`
 *    after every stage.
 *  - Tracks the total wall-clock duration on `result.durationMs`.
 */
export async function inspector(input: InspectorInput): Promise<InspectionResult> {
  const totalStart = performance.now();
  const logger: SubAgentLogger = input.config.logger ?? noopLogger;
  const { sandbox } = input.config;

  // ─── Stage 1: safety scan ───────────────────────────────────────────────
  const safetyStart = performance.now();
  try {
    const safetyOpts: ScanOptions = {
      networkAllowlist: [...DEFAULT_NETWORK_ALLOWLIST],
      depAllowlist: [...DEFAULT_DEP_ALLOWLIST],
    };
    const sourceScan = scan(input.code.source, safetyOpts);
    const pkgViolations = scanPackageJson(input.code.packageJsonPatch, safetyOpts);
    const blockingViolations = [
      ...sourceScan.violations.filter((v) => v.severity === 'block'),
      ...pkgViolations.filter((v) => v.severity === 'block'),
    ];
    const safetyDurationMs = performance.now() - safetyStart;
    logger.info('inspector.stage', {
      stage: 'safety',
      pass: blockingViolations.length === 0,
      durationMs: safetyDurationMs,
      generationId: input.generationId,
    });
    if (blockingViolations.length > 0) {
      return finalize(totalStart, {
        pass: false,
        stage: 'safety',
        errors: blockingViolations.map((violation) => formatViolation(violation)),
      });
    }
  } catch (error) {
    const safetyDurationMs = performance.now() - safetyStart;
    logger.info('inspector.stage', {
      stage: 'safety',
      pass: false,
      durationMs: safetyDurationMs,
      generationId: input.generationId,
      error: errMessage(error),
    });
    return finalize(totalStart, {
      pass: false,
      stage: 'safety',
      errors: [errMessage(error)],
    });
  }

  // ─── Stage 2: write to sandbox FS ───────────────────────────────────────
  // Failures here are stage='tsc' because they prevent the next stage (tsc)
  // from running — there is no separate "write" stage in the public surface.
  // We surface the FS error as a tsc-stage error so the retry loop knows it's
  // a code/structure problem.
  try {
    const mergedPackageJson = buildPackageJsonContent(input.code);
    const tsconfig = buildTsconfigContent();
    await sandbox.writeFiles([
      { path: `${SANDBOX_CWD}/${SOURCE_FILENAME}`, content: input.code.source },
      { path: `${SANDBOX_CWD}/${PACKAGE_JSON_FILENAME}`, content: mergedPackageJson },
      { path: `${SANDBOX_CWD}/${TSCONFIG_FILENAME}`, content: tsconfig },
    ]);
  } catch (error) {
    // Sandbox FS failures are infrastructure — surface as InspectorError so
    // the Workflow can retry the *whole* generation step with a fresh sandbox.
    throw new InspectorError('Inspector: failed to write files into sandbox', {
      cause: error,
      detail: { generationId: input.generationId },
    });
  }

  // ─── Stage 3: tsc --noEmit ──────────────────────────────────────────────
  const tscStart = performance.now();
  try {
    const tscResult = await sandbox.run({
      cmd: 'npx',
      args: ['tsc', '--noEmit'],
      cwd: SANDBOX_CWD,
      timeoutMs: TSC_TIMEOUT_MS,
    });
    const tscDurationMs = performance.now() - tscStart;
    if (tscResult.exitCode !== 0) {
      // Parse stdout AND stderr — tsc writes diagnostics to stdout when run
      // from the CLI even though "error" output is colloquially "stderr".
      const diagnostics = [
        ...parseTscErrors(tscResult.stdout),
        ...parseTscErrors(tscResult.stderr),
      ];
      const errors =
        diagnostics.length > 0
          ? diagnostics.map(
              (d) => `${d.file}(${String(d.line)},${String(d.column)}): ${d.code}: ${d.message}`,
            )
          : [
              `tsc exited with code ${String(tscResult.exitCode)}: ${(tscResult.stderr || tscResult.stdout).slice(0, 2048)}`,
            ];
      logger.info('inspector.stage', {
        stage: 'tsc',
        pass: false,
        durationMs: tscDurationMs,
        generationId: input.generationId,
        diagnostics: diagnostics.length,
      });
      return finalize(totalStart, { pass: false, stage: 'tsc', errors });
    }
    logger.info('inspector.stage', {
      stage: 'tsc',
      pass: true,
      durationMs: tscDurationMs,
      generationId: input.generationId,
    });
  } catch (error) {
    const tscDurationMs = performance.now() - tscStart;
    logger.info('inspector.stage', {
      stage: 'tsc',
      pass: false,
      durationMs: tscDurationMs,
      generationId: input.generationId,
      error: errMessage(error),
    });
    return finalize(totalStart, {
      pass: false,
      stage: 'tsc',
      errors: [errMessage(error)],
    });
  }

  // ─── Stage 4: ntn workers deploy --dry-run ──────────────────────────────
  const dryrunStart = performance.now();
  try {
    await deployWorker(input.code.workerName, {
      dryRun: true,
      cwd: SANDBOX_CWD,
      timeoutMs: DRYRUN_TIMEOUT_MS,
    });
    const dryrunDurationMs = performance.now() - dryrunStart;
    logger.info('inspector.stage', {
      stage: 'dryrun',
      pass: true,
      durationMs: dryrunDurationMs,
      generationId: input.generationId,
    });
  } catch (error) {
    const dryrunDurationMs = performance.now() - dryrunStart;
    logger.info('inspector.stage', {
      stage: 'dryrun',
      pass: false,
      durationMs: dryrunDurationMs,
      generationId: input.generationId,
      error: errMessage(error),
    });
    return finalize(totalStart, {
      pass: false,
      stage: 'dryrun',
      errors: [extractNtnErrorDetail(error)],
    });
  }

  // ─── Stage 5: ntn workers exec + output validation ─────────────────────
  const execStart = performance.now();
  let synthetic: unknown;
  try {
    synthetic = generateSynthetic(input.schema.inputSchema);
  } catch (error) {
    // generateSynthetic can throw if Tool Coder somehow produced a JSchemaSpec
    // with an unhandled kind. Surface as exec-stage failure so Tool Coder
    // retries with the validator complaint in the prompt.
    return finalize(totalStart, {
      pass: false,
      stage: 'exec',
      errors: [`failed to generate synthetic input: ${errMessage(error)}`],
    });
  }

  try {
    const execResult = await execWorker(input.code.workerName, synthetic, {
      cwd: SANDBOX_CWD,
      timeoutMs: EXEC_TIMEOUT_MS,
    });
    const execDurationMs = performance.now() - execStart;
    if (execResult.output === undefined) {
      logger.info('inspector.stage', {
        stage: 'exec',
        pass: false,
        durationMs: execDurationMs,
        generationId: input.generationId,
        reason: 'no-output',
      });
      return finalize(totalStart, {
        pass: false,
        stage: 'exec',
        errors: [`Worker produced no parseable JSON output. Raw: ${execResult.raw.slice(0, 2048)}`],
      });
    }
    const validation = validateAgainstOutputSchema(execResult.output, input.schema.outputSchema);
    if (!validation.ok) {
      logger.info('inspector.stage', {
        stage: 'exec',
        pass: false,
        durationMs: execDurationMs,
        generationId: input.generationId,
        reason: 'schema-mismatch',
        error: validation.error,
      });
      return finalize(totalStart, {
        pass: false,
        stage: 'exec',
        errors: [`Worker output failed schema validation: ${validation.error}`],
      });
    }
    logger.info('inspector.stage', {
      stage: 'exec',
      pass: true,
      durationMs: execDurationMs,
      generationId: input.generationId,
    });
    return finalize(totalStart, {
      pass: true,
      stage: 'exec',
      errors: [],
      output: execResult.output,
    });
  } catch (error) {
    const execDurationMs = performance.now() - execStart;
    logger.info('inspector.stage', {
      stage: 'exec',
      pass: false,
      durationMs: execDurationMs,
      generationId: input.generationId,
      error: errMessage(error),
    });
    return finalize(totalStart, {
      pass: false,
      stage: 'exec',
      errors: [extractNtnErrorDetail(error)],
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Stamp the final `durationMs` and return the result.
 *
 * Centralised so the duration math lives in one place — easier to audit and
 * to switch to a different clock if needed.
 */
function finalize(
  totalStart: number,
  partial: Omit<InspectionResult, 'durationMs'>,
): InspectionResult {
  // We construct the object without `output` when it's undefined to honour
  // exactOptionalPropertyTypes (the type says `output?: unknown`).
  const base = {
    pass: partial.pass,
    stage: partial.stage,
    errors: partial.errors,
    durationMs: performance.now() - totalStart,
  };
  return 'output' in partial && partial.output !== undefined
    ? { ...base, output: partial.output }
    : base;
}

/**
 * Format a single safety violation as a one-line human-readable string.
 *
 * Keeps the format stable so the orchestrator can grep for it in
 * `GenerationStep.errors` when triaging.
 */
function formatViolation(v: Violation): string {
  return `[${v.severity}:${v.rule}] line ${String(v.line)}:${String(v.column)}: ${v.message} — "${v.snippet}"`;
}

/** Pull the most useful message from an unknown thrown value. */
function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : JSON.stringify(err);
}

/**
 * Extract a richer error string from a typed `NtnExecError` (which carries
 * stderr + stdout + exit code) and fall back to `errMessage` for everything
 * else. Keeps the retry prompt informative.
 */
function extractNtnErrorDetail(err: unknown): string {
  if (err instanceof NtnExecError) {
    const parts: string[] = [err.message];
    if (err.stderr.length > 0) parts.push(`stderr: ${err.stderr.slice(0, 1024)}`);
    if (err.stdout.length > 0) parts.push(`stdout: ${err.stdout.slice(0, 1024)}`);
    return parts.join('\n');
  }
  return errMessage(err);
}

/**
 * Merge Tool Coder's dep patch into a minimal Worker `package.json`.
 *
 * The base shape is intentionally narrow — `type: module`, ESM only, no
 * scripts (the sandbox invokes commands directly, not via `npm run`). Adding
 * scripts here would create another LLM-attackable surface.
 */
function buildPackageJsonContent(code: ToolCoderOutput): string {
  const pkg = {
    name: code.workerName,
    version: '0.0.0',
    private: true,
    type: 'module',
    dependencies: code.packageJsonPatch.dependencies,
  };
  return JSON.stringify(pkg, null, 2);
}

/**
 * Minimal tsconfig.json used by `tsc --noEmit` inside the sandbox.
 *
 * Matches the canonical Worker tsconfig (PLAN.md §IX: "with the canonical
 * tsconfig.json (no overrides)") — strict mode on, ES2022, no emit. We do
 * not include path mappings; the generated Worker must only import from
 * allowlisted node_modules entries.
 */
function buildTsconfigContent(): string {
  return JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        lib: ['ES2022'],
        module: 'ESNext',
        moduleResolution: 'Bundler',
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        noEmit: true,
        isolatedModules: true,
        resolveJsonModule: true,
        forceConsistentCasingInFileNames: true,
      },
      include: ['src/**/*'],
    },
    null,
    2,
  );
}
