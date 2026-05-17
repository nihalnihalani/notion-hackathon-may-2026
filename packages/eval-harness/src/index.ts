/**
 * @forge/eval-harness — public surface.
 *
 * - {@link AGENT_NAMES}: the four sub-agents we eval.
 * - {@link AgentName}: type alias for the union of names.
 * - {@link runEvals}: programmatically invoke Promptfoo for one or all agents.
 * - {@link readBaseline}, {@link writeBaseline}, {@link compareToBaseline}:
 *   baseline I/O + regression detection.
 *
 * Workflows under .github/workflows/{ci,evals-nightly}.yml import these
 * indirectly via the CLI in `cli.ts`.
 */
export { AGENT_NAMES, type AgentName } from './agents.js';
export { runEvals, validateEvalConfigs, type EvalRunResult, type AgentRunResult } from './runner.js';
export {
  readBaseline,
  writeBaseline,
  compareToBaseline,
  type Baseline,
  type BaselineDiff,
} from './baseline.js';
