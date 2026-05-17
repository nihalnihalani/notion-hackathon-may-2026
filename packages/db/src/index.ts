/**
 * Public API surface for `@forge/db`.
 *
 * We re-export by name (no wildcards) so additions/removals show up in diffs
 * and downstream packages can rely on a stable, intentional surface.
 *
 * Runtime split
 * -------------
 *   - This module pulls in the Node-runtime `prisma` singleton (binary engine
 *     over a pg pool). It is safe to import from any Node route, script, or
 *     worker.
 *   - For Edge runtimes import the Edge factory directly from
 *     `@forge/db/edge`, not from this module — pulling the Node client into
 *     an Edge bundle will fail at build time.
 */

// --- Runtime clients ---------------------------------------------------------
export { disconnect, prisma } from "./client.js";

// --- Pure helpers ------------------------------------------------------------
export { descriptionHash, normalize } from "./idempotency.js";

// --- Audit writer ------------------------------------------------------------
export { recordAuditEvent } from "./audit.js";

// --- Usage meter -------------------------------------------------------------
export { getUsageSince, recordUsage } from "./usage-meter.js";

// --- Repository: workspaces --------------------------------------------------
export {
  findWorkspaceByNotionId,
  getForgePageIds,
  upsertWorkspace,
} from "./repositories/workspaces.js";

// --- Repository: generations -------------------------------------------------
export {
  createGeneration,
  findRecentByHash,
  getGenerationWithSteps,
  updateGenerationStatus,
} from "./repositories/generations.js";

// --- Repository: generation steps --------------------------------------------
export {
  listStepsForGeneration,
  recordStep,
} from "./repositories/generation-steps.js";

// --- Repository: generated agents --------------------------------------------
export {
  createGeneratedAgent,
  findActiveAgentsByWorkspace,
  markAgentStatus,
  softDeleteAgent,
} from "./repositories/generated-agents.js";

// --- Repository: prompt cache ------------------------------------------------
export {
  lookupByEmbedding,
  lookupByHash,
} from "./repositories/prompt-cache.js";

// --- Types -------------------------------------------------------------------
export type {
  AgentName,
  AgentPattern,
  AgentStatus,
  AuditEvent,
  AuditEventBase,
  AuditEventInput,
  AuditLog,
  Evaluation,
  GeneratedAgent,
  Generation,
  GenerationStatus,
  GenerationStep,
  Prisma,
  PrismaClient,
  PromptCache,
  StepStatus,
  UsageMeter,
  UsageMeterAggregate,
  UsageMeterFields,
  User,
  Workspace,
} from "./types.js";
