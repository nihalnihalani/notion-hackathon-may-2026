/**
 * Shared types for `@forge/workflows`.
 *
 * Three categories live here:
 *
 *  1. **Event payloads** — the wire shapes that trigger / cancel a generation.
 *     Both the Vercel Workflow DevKit entry point (`forge.ts`) and the Inngest
 *     backup (`inngest/forge.ts`) speak these. Keeping them in one file means
 *     the API route that emits them never imports the runtime package.
 *
 *  2. **`WorkflowStepResult`** — a discriminated union of every sub-agent's
 *     return shape, plus the step-level metadata (latency, attempt, costUsd)
 *     the orchestrator records into `GenerationStep` rows.
 *
 *  3. **`WorkflowConfig`** — the single injection seam consumed by the
 *     workflow. Holds every external dependency the steps need: the Prisma
 *     client surface (typed structurally so the workflow doesn't pull
 *     `@prisma/client` into edge bundles), the Notion client config, the
 *     sandbox factory, AI provider credentials, Vercel Blob token, MiniMax
 *     config, PostHog + Resend hooks, and abort-signal plumbing.
 *
 * Design notes:
 *  - All types are pure and side-effect free.
 *  - The `WorkflowConfig.deps` shape is intentionally structural — tests can
 *    pass a tiny stub matching only the methods they need.
 *  - `noopLogger` is re-exported from `@forge/agents` rather than redefined
 *    here so loggers are uniform across the codebase.
 */

import type {
  AgentPattern,
  InspectionResult,
  MinimaxConfig,
  SchemaSmithOutput,
  ShipperPrismaClient,
  ShipperResendClient,
  ShipperResult,
  SubAgentConfig,
  SubAgentLogger,
  ToolCoderOutput,
  VercelBlobPutFn,
  WorkspaceContext,
} from '@forge/agents';
import type { SandboxRunner } from '@forge/agents';
import type { NotionClientConfig, BlockId } from '@forge/notion-client';

import type { OpsMetricsAdapter } from './ops-metrics.js';

// ─────────────────────────────────────────────────────────────────────────────
// Event payloads (wire-format)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Emitted by `/api/forge/trigger` after the Generation row is created in
 * `queued` status. The workflow consumes it and runs the full DAG.
 *
 * `description` is the raw user-typed string; the orchestrator computes its
 * idempotency hash before running anything.
 *
 * `force` lets the trigger API explicitly bypass the idempotency cache when a
 * user clicks "Re-run anyway" in the Notion UI.
 */
export interface GenerationRequestedEvent {
  /** `Generation.id` (cuid). Stable across the full DAG. */
  generationId: string;
  /** PlanetScale `Workspace.id` (cuid). Used for concurrency key + DB writes. */
  workspaceId: string;
  /** Notion-side workspace id (UUID-ish). Used by Shipper for deep links. */
  notionWorkspaceId: string;
  /** Clerk user id. Used for the per-user PostHog distinct-id + Resend email. */
  userId: string;
  /** User's email — populated by the trigger API from Clerk. */
  userEmail: string;
  /** Raw user-typed description (PLAN.md §VI). */
  description: string;
  /** Pre-computed `descriptionHash` from `@forge/db/idempotency`. */
  descriptionHash: string;
  /** Bypass idempotency cache. Defaults to `false`. */
  force?: boolean;
  /**
   * `BlockId` of the Build Log container in the user's Forge page. Each step
   * appends a paragraph block to this container.
   */
  buildLogBlockId: BlockId;
  /**
   * Notion row id for the Forge Requests DB row that triggered this run.
   * Used to post a comment back to the user when Schema Smith returns
   * `pattern: null`.
   */
  notionRequestRowId: string;
}

/**
 * Emitted when a user clicks the "Cancel" button in the Notion page, OR by
 * the cancellation cron when a run exceeds its global wall-clock budget, OR
 * by an admin via the dashboard.
 */
export interface GenerationCancelledEvent {
  generationId: string;
  reason: 'user' | 'timeout' | 'admin';
}

// ─────────────────────────────────────────────────────────────────────────────
// Step results (discriminated union)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Per-sub-agent step outcome as recorded by `step-handlers.ts`.
 *
 * Each variant is `kind`-tagged. `latencyMs`, `attempt`, and `costUsd` live on
 * every variant so the orchestrator can aggregate them at `finalize` time
 * without inspecting the variant.
 */
export type WorkflowStepResult =
  | {
      kind: 'schema-smith';
      output: SchemaSmithOutput;
      attempt: number;
      latencyMs: number;
      costUsd: number;
      stepRowId: string;
    }
  | {
      kind: 'tool-coder';
      output: ToolCoderOutput;
      attempt: number;
      latencyMs: number;
      costUsd: number;
      stepRowId: string;
    }
  | {
      kind: 'inspector';
      output: InspectionResult;
      attempt: number;
      latencyMs: number;
      costUsd: number; // always 0 — Inspector is no-LLM
      stepRowId: string;
    }
  | {
      kind: 'shipper';
      output: ShipperResult;
      attempt: number;
      latencyMs: number;
      costUsd: number; // always 0 — Shipper is no-LLM
      stepRowId: string;
    };

// ─────────────────────────────────────────────────────────────────────────────
// PostHog + Resend hooks (structural, injectable)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Structural slice of the `posthog-node` client we actually call. Kept
 * structural so callers can pass a noop in tests or a real client in prod
 * without us depending on the package at the workflow level.
 */
export interface PostHogLike {
  capture(input: { distinctId: string; event: string; properties?: Record<string, unknown> }): void;
  /** Optional flush hook — Vercel functions call this before returning. */
  flush?(): Promise<void>;
}

/**
 * Structural slice of the Resend client used by `finalize` to send the
 * deploy-success email. Same surface as `ShipperResendClient` from
 * `@forge/agents` — we re-export the alias here for callers that only depend
 * on `@forge/workflows`.
 */
export type ResendClientLike = ShipperResendClient;

// ─────────────────────────────────────────────────────────────────────────────
// Notion context (used by `discover-context` step)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Subset of the `Workspace` row the workflow needs at runtime. We re-shape
 * (instead of using the Prisma model directly) so we can serialize this into
 * the step output JSON without leaking the full DB row.
 */
export interface WorkflowWorkspaceContext {
  workspaceId: string;
  notionWorkspaceId: string;
  notionToken: string;
  /** PlanetScale `Workspace.ownerUserId` (Clerk id). */
  ownerUserId: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// WorkflowConfig — the single injection point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * DB helper surface the workflow uses. Structural so we don't tie the package
 * to a specific Prisma version at the type-import level.
 *
 * Each method maps 1:1 to `@forge/db`'s public API. In production the workflow
 * adapter wires these from `import * as db from '@forge/db'`.
 */
export interface WorkflowDbHelpers {
  // Generations
  findRecentByHash(
    workspaceId: string,
    descriptionHash: string,
    windowMs?: number,
  ): Promise<{
    id: string;
    workspaceId: string;
    agentId: string | null;
    status: string;
    completedAt: Date | null;
  } | null>;
  updateGenerationStatus(
    id: string,
    patch: {
      status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
      pattern?: AgentPattern | null;
      agentId?: string | null;
      completedAt?: Date | null;
      totalLatencyMs?: number | null;
      totalCostUsd?: number | null;
    },
  ): Promise<unknown>;
  // GenerationStep
  recordStep(
    step:
      | {
          kind: 'start';
          generationId: string;
          agent: 'schema_smith' | 'tool_coder' | 'inspector' | 'shipper';
          attempt: number;
          modelUsed?: string | null;
          inputJson: unknown;
        }
      | {
          kind: 'finish';
          id: string;
          status: 'succeeded' | 'failed' | 'running';
          promptTokens?: number | null;
          completionTokens?: number | null;
          cacheReadTokens?: number | null;
          cacheWriteTokens?: number | null;
          costUsd?: number | null;
          outputJson?: unknown;
          errorJson?: unknown;
          latencyMs?: number | null;
          completedAt?: Date | null;
        },
  ): Promise<{ id: string }>;
  // Workspace context lookup (also fetches existing agents for Schema Smith)
  getWorkspaceContext(workspaceId: string): Promise<WorkflowWorkspaceContext | null>;
  listExistingAgents(workspaceId: string): Promise<
    readonly {
      name: string;
      pattern: AgentPattern;
      description: string;
    }[]
  >;
}

/**
 * The Notion-client slice the workflow needs:
 *  - Build Log appender (one call per step)
 *  - Comment poster (one call when Schema Smith asks for clarification)
 */
export interface WorkflowNotionAdapter {
  config: NotionClientConfig;
  /** Append a Build Log entry to the page's log container. */
  appendBuildLogEntry(
    buildLogBlockId: BlockId,
    entry: {
      step: string;
      status: 'running' | 'succeeded' | 'failed' | 'info';
      message: string;
      timestamp: Date;
    },
  ): Promise<void>;
  /** Post a clarification comment on the Forge Requests row. */
  postClarificationComment(notionRowId: string, message: string): Promise<void>;
}

/**
 * NTN CLI wrapper slice — used by the `discover-context` step to query
 * available databases via `ntn datasources query`.
 *
 * Structural so a test can pass a stub returning fixture data.
 */
export interface WorkflowNtnAdapter {
  /**
   * List the workspace's queryable databases. Implementations may cache or
   * directly call `ntn datasources query`.
   */
  listDatabases(workspaceId: string): Promise<
    readonly {
      id: string;
      name: string;
      properties: readonly { name: string; type: string }[];
    }[]
  >;
}

/**
 * Sandbox factory — Inspector needs a fresh `SandboxRunner` per generation.
 * The factory is per-generation rather than per-step so all Inspector retries
 * within a single workflow run share one sandbox (saves cold start).
 */
export interface SandboxFactory {
  create(input: {
    generationId: string;
    workspaceId: string;
    abortSignal?: AbortSignal;
  }): Promise<SandboxRunner>;
}

/**
 * Top-level wiring object. The Vercel function that boots the workflow builds
 * this once per request and passes it into the workflow entrypoint.
 *
 * No field is optional unless explicitly marked — partial configs are a
 * deployment bug, not a runtime path.
 */
export interface WorkflowConfig {
  /** AI provider credentials + clients (passed through to each sub-agent). */
  subAgent: SubAgentConfig;
  /**
   * Shipper-specific extras. These wire the structural surfaces that the
   * Shipper sub-agent declares in `ShipperSubAgentConfig`:
   *  - `dbClient`: the structural Prisma slice (generatedAgent CRUD)
   *  - `notionClient`: REST config for the wire-up calls
   *  - `vercelBlob`: blob token + optional `put` override
   *  - `minimaxConfig`: optional avatar gen
   *  - `resendClient`: optional deploy-success email
   *  - `emailTo`, `emailFrom`, `notionWorkspaceIdForLink`: optional Shipper extras
   *
   * The orchestrator merges these with `subAgent` + the per-generation sandbox
   * when invoking the Shipper.
   */
  shipper: {
    dbClient: ShipperPrismaClient;
    notionClient: NotionClientConfig;
    vercelBlob: { token: string; put?: VercelBlobPutFn | undefined };
    minimaxConfig?: MinimaxConfig | undefined;
    resendClient?: ResendClientLike | undefined;
    emailTo?: string | undefined;
    emailFrom?: string | undefined;
    notionWorkspaceIdForLink?: string | undefined;
  };
  /** DB helpers (idempotency, step recording, generation status). */
  db: WorkflowDbHelpers;
  /** Notion adapter (Build Log + clarification comments). */
  notion: WorkflowNotionAdapter;
  /** NTN adapter (datasource discovery). */
  ntn: WorkflowNtnAdapter;
  /** Sandbox factory for the Inspector. */
  sandbox: SandboxFactory;
  /** Structured logger; defaults handled by callers via `noopLogger`. */
  logger?: SubAgentLogger | undefined;
  /** PostHog client for funnel events. Optional but recommended in prod. */
  posthog?: PostHogLike | undefined;
  /**
   * Optional Forge Operations self-monitoring sink (PLAN.md §X). When present
   * the workflow publishes one row to the Notion ops DB at every terminal
   * outcome (succeeded, failed, cancelled, needs_clarification, cached).
   * Best-effort: publish failures are logged but never propagate.
   */
  opsMetrics?: OpsMetricsAdapter | undefined;
  /**
   * Idempotency window. Defaults to 1h (PLAN.md §VI). Pass `0` to disable the
   * cache entirely (still safe — the check just always misses).
   */
  idempotencyWindowMs?: number | undefined;
  /**
   * Hard wall-clock budget for the full DAG. The Workflow runtime enforces
   * its own per-step timeout; this is an additional soft check the orchestrator
   * uses to surface a clean "timeout" error in the Build Log before the
   * runtime kills the run.
   */
  totalBudgetMs?: number | undefined;
  /**
   * Cost budget (USD). When exceeded the orchestrator halts with a
   * `cost_exceeded` failure code. Defaults to no budget.
   */
  totalCostBudgetUsd?: number | undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Step input shapes (intermediate values between steps)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Output of `discover-context`. Fed into Schema Smith.
 */
export interface DiscoveredContext {
  workspace: WorkflowWorkspaceContext;
  schemaSmithContext: WorkspaceContext;
}

/**
 * Final summary returned by the workflow on successful completion. Useful for
 * test assertions + the API route's response.
 */
export interface WorkflowSuccess {
  generationId: string;
  status: 'succeeded' | 'cached' | 'needs_clarification';
  agentId?: string;
  generatedAgentId?: string;
  customAgentId?: string | null;
  deployUrl?: string;
  totalCostUsd: number;
  totalLatencyMs: number;
  /** When `status === 'cached'`, the workflow short-circuited. */
  cacheHit: boolean;
}
