/**
 * Server-only re-export of `@forge/db` for the dashboard.
 *
 * Why a tiny shim file instead of importing `@forge/db` directly from every
 * server component?
 *
 *   1. `import 'server-only'` here gives us a build-time guarantee that no
 *      client component can accidentally pull this module — Next.js will
 *      throw if a `'use client'` file tries to import from `@/lib/db`.
 *      `@forge/db` itself doesn't take that stance because it's also used
 *      from scripts/workers.
 *
 *   2. Centralises the surface the dashboard depends on. If we ever swap
 *      the data layer (e.g. to a typed RPC), every dashboard page only has
 *      to update its import target by one path.
 */
import 'server-only';

export {
  prisma,
  descriptionHash,
  normalize,
  recordAuditEvent,
  getUsageSince,
  recordUsage,
  findWorkspaceByNotionId,
  getForgePageIds,
  upsertWorkspace,
  createGeneration,
  findRecentByHash,
  getGenerationWithSteps,
  updateGenerationStatus,
  listStepsForGeneration,
  recordStep,
  createGeneratedAgent,
  findActiveAgentsByWorkspace,
  markAgentStatus,
  softDeleteAgent,
  lookupByHash,
} from '@forge/db';

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
} from '@forge/db';
