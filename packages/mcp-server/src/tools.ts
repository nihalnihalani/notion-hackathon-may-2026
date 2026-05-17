/**
 * Pure tool handler implementations.
 *
 * Each handler accepts `(args, context, deps)` and returns an MCP
 * CallToolResult-shaped object. They are exported separately from the
 * server factory so they can be unit-tested without standing up a transport
 * and without depending on `@modelcontextprotocol/sdk` at all.
 *
 * Result-shape contract per MCP 2025-06-18 spec:
 *
 *   - On success: `{ content: [...], structuredContent?: {...} }`
 *   - On error:   `{ isError: true, content: [...], structuredContent: {...} }`
 *     produced by {@link toMcpErrorContent} so the error code surfaces in
 *     both the human-readable and machine-readable channels.
 */

import {
  AgentListError,
  GenerationNotFoundError,
  WorkflowTriggerError,
  toMcpErrorContent,
} from './errors.js';
import type {
  ForgeAgentInput,
  ForgeMcpConfig,
  ForgeMcpContext,
  GeneratedAgentView,
  GenerationStatusView,
  GetGenerationStatusInput,
  ListMyAgentsInput,
  Logger,
} from './types.js';
import { noopLogger } from './types.js';

// ───────────────────────────────────────────────────────────────────────────
// Shared content shapes
// ───────────────────────────────────────────────────────────────────────────

/**
 * Standard tool-success envelope.
 *
 * We mirror `structuredContent` as a JSON-stringified text block per the MCP
 * spec's backward-compatibility recommendation: "a tool that returns
 * structured content SHOULD also return the serialized JSON in a TextContent
 * block". Clients that ignore structuredContent still get the data.
 */
// MCP SDK ≥1.29 widens `structuredContent` to `Record<string, unknown>`.
// We intersect with that so concrete view interfaces (which lack the string
// index signature) still satisfy the structural target.
interface ToolSuccess<T> {
  [key: string]: unknown;
  content: { type: 'text'; text: string }[];
  structuredContent: T & Record<string, unknown>;
}

type ToolResult<T> =
  | ToolSuccess<T>
  | ReturnType<typeof toMcpErrorContent>;

function ok<T>(structured: T, summary: string): ToolSuccess<T> {
  return {
    content: [
      { type: 'text', text: summary },
      { type: 'text', text: JSON.stringify(structured, null, 2) },
    ],
    // The SDK widens `structuredContent` to a record. Our view types are
    // structurally compatible (all keys are strings); cast to add the index
    // signature without copying.
    structuredContent: structured as T & Record<string, unknown>,
  };
}

function resolveLogger(config: ForgeMcpConfig): Logger {
  return config.logger ?? noopLogger;
}

// ───────────────────────────────────────────────────────────────────────────
// forge_agent
// ───────────────────────────────────────────────────────────────────────────

/**
 * Trigger a new generation.
 *
 * Spec annotation contract (set in `server.ts`):
 *   - readOnlyHint: false  (it mutates: writes a Generation row + dispatches work)
 *   - destructiveHint: false (it adds, never deletes)
 *   - idempotentHint: false (each call with the same description without
 *     `force: true` *may* return a cached generation, but the trigger itself
 *     is conceptually non-idempotent; callers shouldn't assume repeated calls
 *     are no-ops because idempotency is governed by a 1h descriptionHash
 *     window inside the workflow trigger)
 *   - openWorldHint: true  (it can produce side effects outside the local
 *     workspace boundary — deploys workers, calls upstream LLMs, etc.)
 */
export async function forgeAgent(
  args: ForgeAgentInput,
  context: ForgeMcpContext,
  config: ForgeMcpConfig,
): Promise<
  ToolResult<{
    generationId: string;
    status: 'queued';
    workflowRunId: string | null;
  }>
> {
  const logger = resolveLogger(config);
  const force = args.force ?? false;

  try {
    const result = await config.workflowTrigger({
      userId: context.userId,
      workspaceId: context.workspaceId,
      notionWorkspaceId: context.notionWorkspaceId,
      description: args.description,
      force,
      source: 'mcp',
    });

    logger.info('mcp.forge_agent.triggered', {
      workspaceId: context.workspaceId,
      generationId: result.generationId,
      force,
    });

    return ok(
      {
        generationId: result.generationId,
        status: 'queued' as const,
        workflowRunId: result.workflowRunId ?? null,
      },
      `Queued generation ${result.generationId}. Poll with get_generation_status.`,
    );
  } catch (error) {
    logger.error('mcp.forge_agent.failed', {
      workspaceId: context.workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return toMcpErrorContent(
      new WorkflowTriggerError(
        'Failed to enqueue generation. The workflow trigger rejected the request.',
        { cause: error },
      ),
    );
  }
}

// ───────────────────────────────────────────────────────────────────────────
// get_generation_status
// ───────────────────────────────────────────────────────────────────────────

/**
 * Read-only: returns the current Generation row + steps.
 *
 * Returns `generation_not_found` when the id doesn't exist *in this
 * workspace*. We deliberately collapse "exists in another workspace" and
 * "doesn't exist anywhere" into the same response to avoid leaking which
 * generation ids are valid across the system.
 */
export async function getGenerationStatus(
  args: GetGenerationStatusInput,
  context: ForgeMcpContext,
  config: ForgeMcpConfig,
): Promise<ToolResult<GenerationStatusView>> {
  const logger = resolveLogger(config);
  try {
    const row = await config.getGenerationStatus(args.generationId, context);
    if (row === null) {
      return toMcpErrorContent(new GenerationNotFoundError(args.generationId));
    }
    return ok(row, `Generation ${row.id} — status: ${row.status} (${row.steps.length} step(s))`);
  } catch (error) {
    logger.error('mcp.get_generation_status.failed', {
      workspaceId: context.workspaceId,
      generationId: args.generationId,
      error: error instanceof Error ? error.message : String(error),
    });
    return toMcpErrorContent(error);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// list_my_agents
// ───────────────────────────────────────────────────────────────────────────

/**
 * Read-only: returns the workspace's `active` + `paused` agents.
 *
 * When `status` is provided we narrow to that single status. We never return
 * `retracted` rows — the spec for `findActiveAgentsByWorkspace` in
 * `@forge/db` already excludes them, but we double-check here as a guard
 * against future repository changes silently widening the surface.
 */
export async function listMyAgents(
  args: ListMyAgentsInput,
  context: ForgeMcpContext,
  config: ForgeMcpConfig,
): Promise<
  ToolResult<{ agents: readonly GeneratedAgentView[]; total: number }>
> {
  const logger = resolveLogger(config);
  try {
    const rows = await config.listAgents(
      args.status === undefined ? {} : { status: args.status },
      context,
    );
    const safe = rows.filter((r) => r.status !== 'retracted');
    return ok(
      { agents: safe, total: safe.length },
      `Found ${safe.length} agent(s)${args.status ? ` with status=${args.status}` : ''}.`,
    );
  } catch (error) {
    logger.error('mcp.list_my_agents.failed', {
      workspaceId: context.workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return toMcpErrorContent(
      new AgentListError('Failed to list agents.', { cause: error }),
    );
  }
}
