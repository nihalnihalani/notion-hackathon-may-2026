/**
 * Promptfoo runner — invokes the Promptfoo library programmatically for
 * each sub-agent's YAML config, then summarizes results into a structured
 * shape the GitHub Actions workflow can compare against the baseline.
 *
 * Design choices:
 * - `runEvals` returns *data*, never prints to stdout (except for explicit
 *   structured JSON when invoked via the CLI). Keeps the workflow logs
 *   readable.
 * - `validateEvalConfigs` parses every YAML + checks that referenced
 *   prompt files exist. This is the "dry-run" entrypoint CI calls on
 *   every PR (no API spend).
 * - Promptfoo is dynamically imported so the dry-run path doesn't require
 *   the (heavy) `promptfoo` package to be resolvable at parse time. This
 *   matters for the CI evals-dry-run job, which only checks YAMLs.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as parseYaml } from 'js-yaml';

import { AGENT_NAMES, agentConfigPath, type AgentName } from './agents.js';

export interface AgentRunResult {
  agent: AgentName;
  totalCases: number;
  passed: number;
  failed: number;
  /** Pass rate in [0, 1]; null if no cases ran. */
  passRate: number | null;
  /** Raw per-case verdicts, kept short to fit a Slack message. */
  failures: { description: string; reason: string }[];
}

export interface EvalRunResult {
  startedAt: string;
  finishedAt: string;
  results: AgentRunResult[];
}

/**
 * Resolve the package root no matter where the runner is invoked from
 * (tsx from monorepo root, dist/* from node_modules, etc.).
 */
function packageRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/runner.ts → ../   |   dist/runner.js → ../
  return resolve(here, '..');
}

interface PromptfooYaml {
  description?: string;
  prompts?: (string | { file?: string })[];
  tests?: unknown[];
}

/**
 * Parse every agent's YAML, assert it has prompts + at least one test, and
 * verify every `file://`-referenced prompt resolves on disk. No network,
 * no Promptfoo runtime — safe to run on every PR.
 *
 * Throws on any failure with a multiline, grep-friendly message.
 */
export function validateEvalConfigs(): { agent: AgentName; cases: number }[] {
  const root = packageRoot();
  const errors: string[] = [];
  const summary: { agent: AgentName; cases: number }[] = [];

  for (const agent of AGENT_NAMES) {
    const cfgPath = agentConfigPath(agent, root);
    if (!existsSync(cfgPath)) {
      errors.push(`[${agent}] missing config: ${cfgPath}`);
      continue;
    }
    const raw = readFileSync(cfgPath, 'utf8');
    let parsed: PromptfooYaml;
    try {
      parsed = parseYaml(raw) as PromptfooYaml;
    } catch (error) {
      errors.push(`[${agent}] YAML parse error: ${(error as Error).message}`);
      continue;
    }
    const cases = Array.isArray(parsed.tests) ? parsed.tests.length : 0;
    if (cases === 0) {
      errors.push(`[${agent}] config has zero test cases`);
    }
    const prompts = parsed.prompts ?? [];
    if (prompts.length === 0) {
      errors.push(`[${agent}] config has no prompts`);
    }
    for (const p of prompts) {
      const ref = typeof p === 'string' ? p : (p.file ?? '');
      if (!ref) continue;
      const cleaned = ref.replace(/^file:\/\//, '');
      const abs = isAbsolute(cleaned) ? cleaned : resolve(dirname(cfgPath), cleaned);
      if (!existsSync(abs)) {
        errors.push(`[${agent}] prompt file not found: ${abs}`);
      }
    }
    summary.push({ agent, cases });
  }

  if (errors.length > 0) {
    throw new Error(`eval config validation failed:\n  - ${errors.join('\n  - ')}`);
  }
  return summary;
}

/**
 * Run the full Promptfoo eval suite for one agent (or all).
 *
 * This is intended to be called from `cli.ts run` (which is itself invoked
 * by `evals-nightly.yml`). The function dynamically imports `promptfoo`
 * so callers that only need `validateEvalConfigs` don't pay the load cost.
 */
export async function runEvals(opts: { agents?: AgentName[] } = {}): Promise<EvalRunResult> {
  const startedAt = new Date().toISOString();
  const which = opts.agents ?? [...AGENT_NAMES];

  // Dynamic import — keeps the dry-run path cheap.
  const promptfoo = (await import('promptfoo')) as unknown as {
    evaluate: (config: string | object, options?: object) => Promise<unknown>;
  };

  const root = packageRoot();
  const results: AgentRunResult[] = [];

  for (const agent of which) {
    const cfgPath = agentConfigPath(agent, root);
    // Promptfoo's `evaluate` accepts a path; we pass the YAML by path so it
    // resolves relative providers/prompts correctly.
    const raw = (await promptfoo.evaluate(cfgPath, {})) as PromptfooRawResult;
    results.push(summarize(agent, raw));
  }

  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    results,
  };
}

/**
 * Promptfoo's result type isn't exported in a stable way across versions,
 * so we declare a minimal structural subset we depend on.
 */
interface PromptfooRawResult {
  results?: {
    description?: string;
    success?: boolean;
    error?: string;
    gradingResult?: { reason?: string };
  }[];
}

function summarize(agent: AgentName, raw: PromptfooRawResult): AgentRunResult {
  const cases = raw.results ?? [];
  const passed = cases.filter((c) => c.success === true).length;
  const failed = cases.length - passed;
  const failures = cases
    .filter((c) => c.success !== true)
    .slice(0, 5)
    .map((c) => ({
      description: c.description ?? '(unnamed case)',
      reason: c.error ?? c.gradingResult?.reason ?? 'unknown failure',
    }));
  return {
    agent,
    totalCases: cases.length,
    passed,
    failed,
    passRate: cases.length === 0 ? null : passed / cases.length,
    failures,
  };
}
