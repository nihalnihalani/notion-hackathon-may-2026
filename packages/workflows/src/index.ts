/**
 * `@forge/workflows` — public surface.
 *
 * Named exports only (no `export *`) so additions / removals show up in
 * diffs. Three logical sections:
 *
 *  1. Types — event payloads, step results, config injection seam.
 *  2. Workflow entry points — `runForgeGeneration` (the body) + constants
 *     (concurrency limit, event names) used by the deploy config.
 *  3. Publishers + helpers — `publishGenerationRequested`,
 *     `publishGenerationCancelled`, `cancelInflight`, idempotency check,
 *     cost-accounting helpers.
 *
 * The Inngest variant ships under the `./inngest` subpath export to avoid
 * pulling its types into the default surface.
 */

// ── Types ────────────────────────────────────────────────────────────────────
export type {
  DiscoveredContext,
  GenerationCancelledEvent,
  GenerationRequestedEvent,
  PostHogLike,
  ResendClientLike,
  SandboxFactory,
  WorkflowConfig,
  WorkflowDbHelpers,
  WorkflowNotionAdapter,
  WorkflowNtnAdapter,
  WorkflowStepResult,
  WorkflowSuccess,
  WorkflowWorkspaceContext,
} from './types.js';

// ── Workflow body + constants ────────────────────────────────────────────────
export {
  CostBudgetExceededError,
  FORGE_CANCELLATION_EVENT,
  FORGE_GENERATION_CONCURRENCY_LIMIT,
  FORGE_WORKFLOW_NAME,
  GenerationCancelledError,
  InspectorRetryExhaustedError,
  NeedsClarificationError,
  runForgeGeneration,
  sumGenerationCost,
  sumGenerationLatency,
} from './forge.js';

// ── Publishers ───────────────────────────────────────────────────────────────
export {
  __resetCachedRunner,
  cancelInflight,
  publishGenerationCancelled,
  publishGenerationRequested,
  type WorkflowRunner,
} from './triggers.js';

// ── Step handlers (exposed so the dashboard / debug tools can rerun a
//     single step against fixture inputs) ─────────────────────────────────────
export {
  discoverContext,
  runInspector,
  runSchemaSmith,
  runShipper,
  runToolCoder,
  type DiscoverContextArgs,
  type RunInspectorArgs,
  type RunSchemaSmithArgs,
  type RunShipperArgs,
  type RunToolCoderArgs,
} from './step-handlers.js';

// ── Idempotency helpers ──────────────────────────────────────────────────────
export {
  DEFAULT_IDEMPOTENCY_WINDOW_MS,
  checkExistingGeneration,
  type IdempotencyCheckResult,
} from './idempotency.js';

// ── Cost helpers ─────────────────────────────────────────────────────────────
export { costExceedsBudget } from './cost-accounting.js';

// ── Forge Operations self-monitoring (PLAN.md §X) ────────────────────────────
export {
  DEFAULT_OPS_METRICS_PROPERTY_NAMES,
  buildOpsRowProperties,
  createNotionOpsMetricsAdapter,
  createOpsMetricsAdapterFromEnv,
  type NotionOpsMetricsAdapterOptions,
  type OpsGenerationEvent,
  type OpsGenerationStatus,
  type OpsMetricsAdapter,
  type OpsMetricsEnvReader,
  type OpsMetricsPropertyNames,
} from './ops-metrics.js';

// ── Inngest backup (re-exports the factory — runtime opt-in via env flag) ────
export {
  createForgeInngestFunctions,
  runForgeOnInngest,
  type InngestClientLike,
  type InngestFunctionOptions,
  type InngestHandlerContext,
  type InngestTrigger,
} from './inngest/forge.js';
