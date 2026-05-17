/**
 * Public shapes for `@forge/mcp-server`.
 *
 * Three audiences for this module:
 *
 *   1. The Next.js `/api/mcp` route — constructs a {@link ForgeMcpContext}
 *      from the validated `Authorization: Bearer <key>` header and passes a
 *      {@link ForgeMcpConfig} that wires the workflow trigger + DB readers.
 *   2. The MCP server factory in `./server.ts` — consumes both.
 *   3. Tests — instantiate the server with mock implementations.
 *
 * Design notes:
 *
 *   - Auth validation happens in `apps/web`, NOT here. By the time anything
 *     in this package runs, we trust that {@link ForgeMcpContext} represents
 *     a real, currently-authenticated principal. This keeps the package
 *     edge-bundleable (no DB-backed key lookup, no JWT lib import) and lets
 *     the same primitives back stdio / SSE / future transports.
 *
 *   - The {@link ForgeMcpConfig} dependencies are intentionally narrow
 *     structural shapes (no `@forge/db` or `@forge/workflows` import). This
 *     makes the test surface small (each call site provides only what each
 *     tool actually needs), keeps cyclic dependencies out of the workspace
 *     graph, and lets us swap the workflow backend without touching MCP.
 *
 *   - All zod schemas live here so that `server.ts`, `tools.ts`, and the
 *     test file all reference the same canonical input shape — there is one
 *     contract per tool.
 */

import { z } from 'zod';

import type { AgentPattern, AgentStatus, GenerationStatus } from '@forge/db';

// ───────────────────────────────────────────────────────────────────────────
// Logger
// ───────────────────────────────────────────────────────────────────────────

/**
 * Minimal structured logger. Mirrors `SubAgentLogger` from `@forge/agents`
 * intentionally — we want a single ergonomic surface across the workspace
 * without taking on a logger dependency that breaks the Edge bundle.
 */
export interface Logger {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
}

/** Silent default used when {@link ForgeMcpConfig.logger} is omitted. */
export const noopLogger: Logger = {
  info: () => {
    /* no-op */
  },
  error: () => {
    /* no-op */
  },
};

// ───────────────────────────────────────────────────────────────────────────
// Context: who is calling this MCP server right now
// ───────────────────────────────────────────────────────────────────────────

/**
 * Per-request principal context.
 *
 * Produced by `apps/web/app/api/mcp/route.ts` after the bearer token is
 * validated against the `ApiKey` table and mapped back to the owning user +
 * workspace.
 *
 * SECURITY: every tool, prompt, and resource MUST scope its DB reads/writes
 * by `workspaceId` (and where appropriate `userId`). Failure to do so allows
 * an attacker who steals an API key to read another workspace's agents.
 */
export interface ForgeMcpContext {
  /** Forge `User.id` (Clerk subject, mapped through our user row). */
  readonly userId: string;
  /** Forge `Workspace.id`. */
  readonly workspaceId: string;
  /** The underlying Notion workspace this user installed Forge into. */
  readonly notionWorkspaceId: string;
}

// ───────────────────────────────────────────────────────────────────────────
// Zod input shapes for each tool
//
// MCP `registerTool` accepts a raw shape (Record<string, ZodSchema>) for
// `inputSchema`. The SDK auto-converts the shape to JSON Schema for the
// tools/list response and validates incoming tools/call arguments against it.
// ───────────────────────────────────────────────────────────────────────────

/** Input for `forge_agent`. */
export const forgeAgentInputShape = {
  description: z
    .string()
    .min(10, 'description must be at least 10 characters')
    .max(2000, 'description must be at most 2000 characters')
    .describe('Plain-English description of the agent to forge — input, output, triggers.'),
  force: z
    .boolean()
    .optional()
    .describe('Bypass the 1h descriptionHash idempotency cache and re-run the pipeline.'),
} as const;
export const forgeAgentInputSchema = z.object(forgeAgentInputShape);
export type ForgeAgentInput = z.infer<typeof forgeAgentInputSchema>;

/** Input for `get_generation_status`. */
export const getGenerationStatusInputShape = {
  generationId: z
    .string()
    .min(1, 'generationId is required')
    .describe('The `Generation.id` returned by `forge_agent`.'),
} as const;
export const getGenerationStatusInputSchema = z.object(getGenerationStatusInputShape);
export type GetGenerationStatusInput = z.infer<typeof getGenerationStatusInputSchema>;

/** Input for `list_my_agents`. */
export const listMyAgentsInputShape = {
  status: z
    .enum(['active', 'paused'])
    .optional()
    .describe(
      "Filter by status. Omit to return both active and paused agents (excludes 'retracted').",
    ),
} as const;
export const listMyAgentsInputSchema = z.object(listMyAgentsInputShape);
export type ListMyAgentsInput = z.infer<typeof listMyAgentsInputSchema>;

// ───────────────────────────────────────────────────────────────────────────
// Workflow trigger contract
// ───────────────────────────────────────────────────────────────────────────

/**
 * Result of dispatching a `forge/generation.requested` workflow event.
 *
 * `workflowRunId` is the upstream durable-execution handle (Vercel Workflow
 * run ID) when available. It's optional because some triggers (e.g., the
 * Inngest fallback path) may return the same id under a different name.
 */
export interface WorkflowTriggerResult {
  readonly generationId: string;
  readonly workflowRunId?: string;
}

/**
 * Input the route handler / mcp-server passes to the workflow trigger.
 *
 * Mirrors `publishGenerationRequested(...)` from `@forge/workflows`:
 *   - `force` short-circuits idempotency.
 *   - `source` lets the workflow record where the request came from (Notion
 *     button, dashboard re-forge, MCP client). We always pass `'mcp'` here.
 */
export interface WorkflowTriggerInput {
  readonly userId: string;
  readonly workspaceId: string;
  readonly notionWorkspaceId: string;
  readonly description: string;
  readonly force: boolean;
  readonly source: 'mcp';
}

// ───────────────────────────────────────────────────────────────────────────
// DB-shaped results (what tools return to the MCP client)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Reduced `Generation` row returned by `get_generation_status`.
 *
 * We deliberately project a stable subset — not the raw Prisma row — so the
 * MCP contract doesn't churn every time we add a column. Numeric Decimal
 * fields are pre-coerced to `number` for JSON serialization safety.
 */
export interface GenerationStatusView {
  readonly id: string;
  readonly status: GenerationStatus;
  readonly pattern: AgentPattern | null;
  readonly agentId: string | null;
  readonly createdAt: string; // ISO 8601
  readonly completedAt: string | null;
  readonly totalLatencyMs: number | null;
  readonly totalCostUsd: number | null;
  readonly steps: readonly GenerationStepView[];
}

export interface GenerationStepView {
  readonly id: string;
  readonly agent: string;
  readonly attempt: number;
  readonly status: string;
  readonly modelUsed: string | null;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly latencyMs: number | null;
  readonly costUsd: number | null;
  readonly errorJson: unknown;
}

export interface GeneratedAgentView {
  readonly id: string;
  readonly ntnWorkerName: string;
  readonly ntnDeployUrl: string | null;
  readonly pattern: AgentPattern;
  readonly description: string;
  readonly status: AgentStatus;
  readonly avatarUrl: string | null;
  readonly oauthProviders: readonly string[];
  readonly createdAt: string;
}

// ───────────────────────────────────────────────────────────────────────────
// Config: dependencies the route handler injects
// ───────────────────────────────────────────────────────────────────────────

/**
 * Everything the MCP server needs to do its job.
 *
 * All four functions receive the per-request {@link ForgeMcpContext} so
 * they can scope DB queries by workspace. We pass it explicitly (rather than
 * binding via closure in the route handler) because the same server instance
 * is reused across requests but the context is not.
 */
export interface ForgeMcpConfig {
  /**
   * Dispatch a generation request to the workflow engine. Implemented by
   * `publishGenerationRequested` from `@forge/workflows` in production.
   *
   * MUST create the `Generation` row before returning so the returned id is
   * immediately queryable by `get_generation_status`.
   */
  readonly workflowTrigger: (input: WorkflowTriggerInput) => Promise<WorkflowTriggerResult>;

  /**
   * Fetch a single generation + its ordered step trail. The caller (route
   * handler in production) is responsible for scoping by `workspaceId` and
   * returning `null` if the id belongs to another workspace.
   */
  readonly getGenerationStatus: (
    id: string,
    context: ForgeMcpContext,
  ) => Promise<GenerationStatusView | null>;

  /**
   * List the requesting workspace's deployed agents. Excludes `retracted`.
   * The route handler scopes by `context.workspaceId` and applies the
   * status filter if provided.
   */
  readonly listAgents: (
    filter: { status?: AgentStatus },
    context: ForgeMcpContext,
  ) => Promise<readonly GeneratedAgentView[]>;

  /** Optional structured logger. Defaults to {@link noopLogger}. */
  readonly logger?: Logger;
}
