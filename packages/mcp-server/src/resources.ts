/**
 * Resource handler for `forge://agents`.
 *
 * Resources in MCP are read-only addressable content. We expose a single
 * one: the list of all deployed agents in the caller's workspace, served as
 * a JSON payload. Clients can `resources/read` it and decide what to do
 * with the data; it's a parallel surface to `list_my_agents` (the tool)
 * for clients that prefer the resource interaction model.
 *
 * Why one resource and not many: a per-agent template (`forge://agents/{id}`)
 * would be useful but the current spec for `findActiveAgentsByWorkspace`
 * already returns full rows in one call. We can add a template later
 * without breaking the static URI consumer.
 */

import { toMcpErrorContent } from './errors.js';
import type {
  ForgeMcpConfig,
  ForgeMcpContext,
  GeneratedAgentView,
  Logger,
} from './types.js';
import { noopLogger } from './types.js';

/** The single URI we register. Kept as a const so server.ts can re-use it. */
export const FORGE_AGENTS_URI = 'forge://agents';

/** Stable metadata used when registering the resource. */
export const FORGE_AGENTS_RESOURCE_METADATA = Object.freeze({
  title: "Workspace agents",
  description:
    "All deployed Forge agents (active + paused) for the requesting workspace, as JSON.",
  mimeType: 'application/json',
});

/**
 * Build the `resources/read` payload for `forge://agents`.
 *
 * Returns the SDK's `ReadResourceResult.contents` shape directly. On error
 * we surface a `text/plain` content block describing the failure rather
 * than throwing — the MCP spec doesn't define an `isError` channel for
 * resources (only for tools), so a text error is the most universally
 * understood degradation.
 */
export async function readForgeAgentsResource(
  context: ForgeMcpContext,
  config: ForgeMcpConfig,
): Promise<{
  contents: {
    uri: string;
    mimeType: string;
    text: string;
  }[];
}> {
  const logger: Logger = config.logger ?? noopLogger;
  try {
    const rows = await config.listAgents({}, context);
    const safe = rows.filter((r) => r.status !== 'retracted');
    const payload = {
      workspaceId: context.workspaceId,
      generatedAt: new Date().toISOString(),
      total: safe.length,
      agents: safe satisfies readonly GeneratedAgentView[],
    };
    return {
      contents: [
        {
          uri: FORGE_AGENTS_URI,
          mimeType: 'application/json',
          text: JSON.stringify(payload, null, 2),
        },
      ],
    };
  } catch (error) {
    logger.error('mcp.resource.forge_agents.failed', {
      workspaceId: context.workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
    const errorPayload = toMcpErrorContent(error);
    return {
      contents: [
        {
          uri: FORGE_AGENTS_URI,
          mimeType: 'application/json',
          text: JSON.stringify(errorPayload.structuredContent, null, 2),
        },
      ],
    };
  }
}
