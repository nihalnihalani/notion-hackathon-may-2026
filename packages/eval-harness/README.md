# @forge/eval-harness

Promptfoo-based eval harness. Houses Promptfoo configs + golden inputs for each
sub-agent (Schema Smith, Tool Coder, Inspector, Shipper). Per-PR CI runs the
dry-run validator only (no API spend). The nightly workflow runs the full sweep
against real Anthropic + OpenAI APIs and compares pass-rates to the baseline.

## Layout

```
evals/
  schema-smith.yaml      Promptfoo config + assertions (11 cases)
  tool-coder.yaml        (10 cases)
  inspector.yaml         (10 cases)
  shipper.yaml           (10 cases)
  baselines.json         pass-rate snapshot per agent
prompts/
  schema-smith.txt       prompt template referenced by the YAML
  tool-coder.txt
  inspector.txt
  shipper.txt
src/
  index.ts               public exports
  agents.ts              AGENT_NAMES + config path resolver
  runner.ts              programmatic Promptfoo runner + dry-run validator
  baseline.ts            read/write/compare baselines.json
  cli.ts                 GHA-facing CLI (validate/run/baseline-check/...)
  *.test.ts              vitest unit tests
```

## Commands

| Command                                                                 | What                                                                  | Where                              |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------- |
| `pnpm --filter @forge/eval-harness eval:dry-run`                        | Parse YAMLs + verify prompt files (no API calls).                     | `ci.yml: evals-dry-run`            |
| `pnpm --filter @forge/eval-harness eval -- --output evals-output/`      | Run the full sweep against real APIs.                                 | `evals-nightly.yml: evals`         |
| `pnpm --filter @forge/eval-harness baseline:check -- --threshold 5`    | Compare last run to baseline; exit 1 on regression.                   | `evals-nightly.yml: evals`         |
| `pnpm --filter @forge/eval-harness baseline:update`                    | Seed/overwrite `evals/baselines.json` from latest run.                | manual (after accepting changes)   |
| `pnpm --filter @forge/eval-harness eval:report --input evals-output/`  | Generate HTML report.                                                 | `evals-nightly.yml: publish`       |

## Adding a sub-agent

See [docs/CI_CD.md](../../docs/CI_CD.md#how-to-add-a-new-sub-agent-eval).

## Public API surface

```ts
import {
  AGENT_NAMES,
  type AgentName,
  validateEvalConfigs,
  runEvals,
  readBaseline,
  writeBaseline,
  compareToBaseline,
} from '@forge/eval-harness';
```
