/**
 * `createForgeMcpServer` — main package entrypoint.
 *
 * Builds an `McpServer` configured with Forge's three tools, two prompts,
 * and one resource. The same factory is used in three places:
 *
 *   - `apps/web/app/api/mcp/route.ts` (production HTTP transport)
 *   - integration tests (in-memory transport via `InMemoryTransport`)
 *   - any future stdio shim (not built yet)
 *
 * The server itself is **stateless across requests** — there is no per-user
 * state held inside the server instance. All per-request state (the
 * authenticated principal) flows through {@link ForgeMcpContext}, which is
 * captured by closure when the server is constructed. In production the
 * route handler creates a new server per request.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { FORGE_AGENTS_RESOURCE_METADATA, FORGE_AGENTS_URI, readForgeAgentsResource } from './resources.js';
import { PROMPT_CATALOG } from './prompts.js';
import { forgeAgent, getGenerationStatus, listMyAgents } from './tools.js';
import {
  forgeAgentInputShape,
  getGenerationStatusInputShape,
  listMyAgentsInputShape,
} from './types.js';
import type { ForgeMcpConfig, ForgeMcpContext } from './types.js';

/** Version reported in server `Implementation`. Bump on protocol-visible changes. */
export const FORGE_MCP_SERVER_VERSION = '0.1.0';
export const FORGE_MCP_SERVER_NAME = 'forge';

/**
 * Build a fully-wired `McpServer` instance.
 *
 * @param context - The validated principal for this request.
 * @param config  - Workflow trigger + DB reader callbacks.
 *
 * Tool annotation policy (MCP 2025-06-18):
 *
 *   forge_agent              — mutates state and produces external side
 *                              effects → `readOnlyHint: false`,
 *                              `destructiveHint: false`,
 *                              `idempotentHint: false`,
 *                              `openWorldHint: true`. Clients SHOULD prompt
 *                              the user for confirmation per the spec's
 *                              Trust & Safety guidance.
 *
 *   get_generation_status    — pure read → `readOnlyHint: true`,
 *                              `idempotentHint: true`.
 *
 *   list_my_agents           — pure read → `readOnlyHint: true`,
 *                              `idempotentHint: true`.
 *
 * Annotations are HINTS only; the spec is explicit that clients must treat
 * them as untrusted unless they come from a trusted server. They drive the
 * client's confirmation UX, nothing more.
 */
export function createForgeMcpServer(
  context: ForgeMcpContext,
  config: ForgeMcpConfig,
): McpServer {
  const server = new McpServer(
    {
      name: FORGE_MCP_SERVER_NAME,
      version: FORGE_MCP_SERVER_VERSION,
    },
    {
      instructions: [
        'Forge compiles plain-English descriptions into deployed Notion Custom Agents.',
        'Use `forge_agent` to start a build (the user MUST consent — this deploys code).',
        'Use `get_generation_status` to poll progress (~30-120s typical end-to-end).',
        'Use `list_my_agents` (or read the `forge://agents` resource) to see deployed agents.',
        'When a generation fails, the `forge_diagnose_failure` prompt walks through the step trail.',
      ].join('\n'),
    },
  );

  // ── Tools ──────────────────────────────────────────────────────────────

  server.registerTool(
    'forge_agent',
    {
      title: 'Forge a Notion Custom Agent',
      description:
        'Compile a plain-English description into a deployed Notion Custom Agent. Returns a `generationId` immediately; poll with `get_generation_status` until status is `succeeded` or `failed`. Typical end-to-end time: 30–120s.',
      inputSchema: forgeAgentInputShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => forgeAgent(args, context, config),
  );

  server.registerTool(
    'get_generation_status',
    {
      title: 'Get the current status of a Forge generation',
      description:
        'Returns the current Generation row plus its ordered step trail (schema-smith → tool-coder → inspector → shipper). Use this to poll progress and surface failures.',
      inputSchema: getGenerationStatusInputShape,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => getGenerationStatus(args, context, config),
  );

  server.registerTool(
    'list_my_agents',
    {
      title: "List the workspace's deployed agents",
      description:
        "List every Forge-deployed agent in the requesting user's workspace. Excludes retracted (deleted) agents. Optionally filter by status.",
      inputSchema: listMyAgentsInputShape,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => listMyAgents(args, context, config),
  );

  // ── Prompts ────────────────────────────────────────────────────────────
  //
  // Registered individually (rather than via `Object.entries`) because each
  // catalog entry's `argsShape` and `render` are linked by a different
  // generic; iterating would force TS to intersect the arg types and break
  // type inference for the render callback.

  const describe = PROMPT_CATALOG.forge_describe_agent;
  server.registerPrompt(
    'forge_describe_agent',
    {
      title: describe.title,
      description: describe.description,
      argsSchema: describe.argsShape,
    },
    (args) => describe.render(args),
  );

  const diagnose = PROMPT_CATALOG.forge_diagnose_failure;
  server.registerPrompt(
    'forge_diagnose_failure',
    {
      title: diagnose.title,
      description: diagnose.description,
      argsSchema: diagnose.argsShape,
    },
    (args) => diagnose.render(args),
  );

  // ── Resource ───────────────────────────────────────────────────────────

  server.registerResource(
    'forge-agents',
    FORGE_AGENTS_URI,
    FORGE_AGENTS_RESOURCE_METADATA,
    async () => readForgeAgentsResource(context, config),
  );

  return server;
}
