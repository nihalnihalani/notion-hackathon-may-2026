#!/usr/bin/env tsx
/**
 * @forge/eval-harness CLI — drives the runner + baseline helpers from
 * GitHub Actions. Subcommands:
 *
 *   validate           Parse every YAML + verify prompt files (no API calls).
 *                       Used by `ci.yml: evals-dry-run`.
 *
 *   run                Execute the full Promptfoo eval suite.
 *                       Used by `evals-nightly.yml`.
 *
 *   baseline-check     Compare a previous `run` output to the baseline JSON.
 *                       Writes a diff to --output and exits 1 if any agent
 *                       regressed past --threshold (percentage points).
 *
 *   baseline-update    Overwrite baseline JSON with the latest run's results.
 *                       Manual command; run after intentionally accepting a
 *                       prompt change.
 *
 *   report             Generate Promptfoo's HTML report from raw results.
 *
 * Stdout is structured JSON unless --pretty is passed; stderr is human.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';

import { compareToBaseline, readBaseline, writeBaseline, type Baseline } from './baseline.js';
import { runEvals, validateEvalConfigs, type EvalRunResult } from './runner.js';

interface ParsedArgs {
  command: string;
  flags: Map<string, string | true>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const command = argv[2] ?? '';
  const rest = argv.slice(3);
  const flags = new Map<string, string | true>();
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg?.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq === -1) {
      const next = rest[i + 1];
      if (next && !next.startsWith('--')) {
        flags.set(arg.slice(2), next);
        i++;
      } else {
        flags.set(arg.slice(2), true);
      }
    } else {
      flags.set(arg.slice(2, eq), arg.slice(eq + 1));
    }
  }
  return { command, flags };
}

function flagAsString(flags: Map<string, string | true>, name: string): string | undefined {
  const v = flags.get(name);
  return typeof v === 'string' ? v : undefined;
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv);

  switch (command) {
    case 'validate': {
      const summary = validateEvalConfigs();
      process.stdout.write(JSON.stringify({ ok: true, agents: summary }, null, 2) + '\n');
      return;
    }

    case 'run': {
      const result = await runEvals();
      const outDir = flagAsString(flags, 'output') ?? 'evals-output';
      ensureDir(outDir);
      writeFileSync(resolve(outDir, 'results.json'), JSON.stringify(result, null, 2) + '\n');
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      return;
    }

    case 'baseline-check': {
      const resultsDir = flagAsString(flags, 'results') ?? 'evals-output';
      const thresholdRaw = flagAsString(flags, 'threshold') ?? '5';
      const threshold = Number.parseFloat(thresholdRaw);
      if (!Number.isFinite(threshold) || threshold < 0) {
        throw new Error(`invalid --threshold: ${thresholdRaw}`);
      }
      const resultsPath = resolve(resultsDir, 'results.json');
      if (!existsSync(resultsPath)) {
        throw new Error(`results.json not found at ${resultsPath}`);
      }
      const result = JSON.parse(readFileSync(resultsPath, 'utf8')) as EvalRunResult;
      const baseline = readBaseline();
      const diff = compareToBaseline(result, baseline, threshold);
      const outPath = flagAsString(flags, 'output');
      if (outPath) {
        ensureDir(dirname(outPath));
        writeFileSync(outPath, JSON.stringify(diff, null, 2) + '\n');
      }
      process.stdout.write(JSON.stringify(diff, null, 2) + '\n');
      if (diff.regressed) {
        process.exit(1);
      }
      return;
    }

    case 'baseline-update': {
      const resultsDir = flagAsString(flags, 'results') ?? 'evals-output';
      const resultsPath = resolve(resultsDir, 'results.json');
      const result = JSON.parse(readFileSync(resultsPath, 'utf8')) as EvalRunResult;
      const runId = flagAsString(flags, 'run-id') ?? process.env['GITHUB_RUN_ID'] ?? null;
      const updated: Baseline = writeBaseline(result, runId ? { runId } : {});
      process.stdout.write(JSON.stringify({ ok: true, baseline: updated }, null, 2) + '\n');
      return;
    }

    case 'report': {
      // Delegated to promptfoo's own report generator. We dynamically import
      // so `validate` users don't pay the load cost.
      const promptfoo = (await import('promptfoo')) as unknown as {
        viewer?: { generateHtml: (input: string, output: string) => Promise<void> };
      };
      const input = flagAsString(flags, 'input') ?? 'evals-output';
      const output = flagAsString(flags, 'output') ?? 'evals-output/html';
      ensureDir(output);
      if (promptfoo.viewer?.generateHtml) {
        await promptfoo.viewer.generateHtml(input, output);
      } else {
        // Fallback: emit a minimal stub the workflow can still publish.
        writeFileSync(
          resolve(output, 'index.html'),
          '<!doctype html><meta charset=utf-8><title>Forge evals</title>' +
            '<p>Promptfoo viewer API not available in this version; see raw results.json.</p>',
        );
      }
      process.stdout.write(JSON.stringify({ ok: true, output }, null, 2) + '\n');
      return;
    }

    default: {
      process.stderr.write(
        `usage: eval-harness <validate|run|baseline-check|baseline-update|report> [flags]\n`,
      );
      process.exit(2);
    }
  }
}

function ensureDir(p: string): void {
  if (!existsSync(p)) {
    mkdirSync(p, { recursive: true });
  }
}

main().catch((error: unknown) => {
  const msg = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`eval-harness CLI failed: ${msg}\n`);
  process.exit(1);
});
