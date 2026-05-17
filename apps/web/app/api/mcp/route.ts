/**
 * MCP server exposed over HTTP (stateless, JSON-RPC over POST).
 *
 * This route is a thin auth + per-request wiring layer around
 * `@forge/mcp-server`. The actual tool catalog (`forge_agent`,
 * `get_generation_status`, `list_my_agents`), prompts, and resource live in
 * that package so the same primitives can back stdio / SSE / future
 * transports.
 *
 * Why we no longer hand-roll JSON-RPC here:
 *   - The package wraps the official `@modelcontextprotocol/sdk` server with
 *     a Web-standard `Request`/`Response` adapter, so we get the spec-
 *     compliant protocol surface (initialize, capabilities negotiation,
 *     prompts, resources, structured content, error envelopes) for free.
 *   - Centralizing the protocol surface in one package keeps the contract
 *     uniform across MCP transports and gives us a single test surface for
 *     spec conformance.
 *
 * Per-request layering done HERE:
 *   1. `Authorization: Bearer <key>` → `ApiKeyClaims` via `validateApiKey`.
 *   2. Look up the workspace's `notionWorkspaceId` (claims only carry
 *      `userId` + `workspaceId`; the MCP context wants all three).
 *   3. Rate-limit the request (30 forge_agent calls / minute / userId).
 *   4. Build `ForgeMcpConfig` that wires:
 *        - `workflowTrigger`  → `publishGenerationRequested` from
 *          `@forge/workflows`, after creating the `Generation` row,
 *          short-circuiting on the descriptionHash idempotency window, and
 *          checking that the workspace has finished install (Build Log block
 *          + notionWorkspaceId present).
 *        - `getGenerationStatus` → `getGenerationWithSteps` from `@forge/db`,
 *          scoped by `context.workspaceId` so a stolen key cannot read
 *          another workspace's runs.
 *        - `listAgents` → `findActiveAgentsByWorkspace` from `@forge/db`,
 *          mapped into the package's narrow `GeneratedAgentView` shape.
 *   5. Hand off to `handleMcpHttpRequest` and return its `Response`.
 *
 * GET / DELETE: the package returns 405 — we're stateless, no SSE channel,
 * no sessions. The route exposes only POST.
 */

import {
  createGeneration,
  descriptionHash,
  findActiveAgentsByWorkspace,
  findRecentByHash,
  getGenerationWithSteps,
  prisma,
} from '@forge/db';
import type { AgentStatus } from '@forge/db';
import {
  createForgeMcpServer,
  handleMcpHttpRequest,
  type ForgeMcpConfig,
  type ForgeMcpContext,
  type GeneratedAgentView,
  type GenerationStatusView,
  type Logger,
  type WorkflowTriggerInput,
  type WorkflowTriggerResult,
} from '@forge/mcp-server';
import { asBlockId } from '@forge/notion-client';
import { publishGenerationRequested } from '@forge/workflows';
import * as Sentry from '@sentry/nextjs';
import { NextResponse } from 'next/server';

import { extractBearer, validateApiKey } from '@/lib/api-keys';
import { apiError } from '@/lib/errors';
import { capture } from '@/lib/posthog';
import { checkRateLimit, limiters } from '@/lib/ratelimit';
import { withSentry } from '@/lib/sentry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

async function authenticate(
  req: Request,
): Promise<
  | { ok: true; context: ForgeMcpContext }
  | { ok: false; response: NextResponse }
> {
  const bearer = extractBearer(req);
  if (!bearer) {
    return {
      ok: false,
      response: apiError('unauthenticated', 'Missing Bearer API key.'),
    };
  }
  const claims = await validateApiKey(bearer);
  if (!claims) {
    return {
      ok: false,
      response: apiError('unauthenticated', 'Invalid API key.'),
    };
  }

  // Claims only carry `userId` + `workspaceId`; the MCP context also needs
  // the upstream Notion workspace id (for deep links + downstream calls).
  const ws = await prisma.workspace.findUnique({
    where: { id: claims.workspaceId },
    select: { notionWorkspaceId: true },
  });
  if (!ws) {
    return {
      ok: false,
      response: apiError(
        'unauthenticated',
        'Workspace for this API key no longer exists.',
      ),
    };
  }

  return {
    ok: true,
    context: {
      userId: claims.userId,
      workspaceId: claims.workspaceId,
      notionWorkspaceId: ws.notionWorkspaceId,
    },
  };
}

// ---------------------------------------------------------------------------
// Config wiring — production implementations of the package's structural deps
// ---------------------------------------------------------------------------

/**
 * Minimal structured logger that pipes into Sentry breadcrumbs and console.
 * Mirrors the package's `Logger` shape — kept here so we don't tie the
 * package to `@sentry/nextjs`.
 */
const logger: Logger = {
  info(msg, meta) {
    Sentry.addBreadcrumb({
      category: 'mcp',
      level: 'info',
      message: msg,
      ...(meta ? { data: meta } : {}),
    });
  },
  error(msg, meta) {
    Sentry.addBreadcrumb({
      category: 'mcp',
      level: 'error',
      message: msg,
      ...(meta ? { data: meta } : {}),
    });
  },
};

/**
 * `workflowTrigger` implementation passed into the MCP config.
 *
 * Responsibilities mirror the dashboard's `/api/forge/trigger`:
 *   - 1h descriptionHash idempotency check (unless `force: true`)
 *   - install precheck (workspace must have Build Log + notion workspace id)
 *   - persist the `Generation` row before returning so the returned id is
 *     immediately queryable by `get_generation_status`
 *   - publish the `forge/generation.requested` event
 *
 * Throws on enqueue failure so the package surfaces a `WorkflowTriggerError`
 * to the MCP client.
 */
async function workflowTrigger(
  input: WorkflowTriggerInput,
): Promise<WorkflowTriggerResult> {
  // Per-user rate limit; the same limiter used by the package surface.
  const rl = await checkRateLimit(limiters.mcpForgeAgent(), input.userId);
  if (!rl.success) {
    // Throwing surfaces the error through the MCP envelope. We don't have a
    // dedicated error-code variant for rate limits in the package today; a
    // generic message is fine — the tool result will be `isError: true`.
    throw new Error('rate limited');
  }

  const hash = await descriptionHash(input.workspaceId, input.description);

  // Idempotency: return the cached generation when the same description was
  // already shipped in the last hour. We surface it as a normal
  // `WorkflowTriggerResult` — the tool wrapper labels the status `queued`
  // either way; clients should call `get_generation_status` immediately to
  // see the true terminal status (`succeeded` for a cache hit).
  if (!input.force) {
    const cached = await findRecentByHash(input.workspaceId, hash);
    if (cached && cached.agentId) {
      await capture({
        distinctId: input.userId,
        event: 'forge.generation.cache_hit',
        workspaceId: input.workspaceId,
        properties: {
          generationId: cached.id,
          agentId: cached.agentId,
          source: input.source,
        },
      });
      return { generationId: cached.id };
    }
  }

  // Pull the workspace's install metadata. The mcp-server context already
  // carries `notionWorkspaceId`, but the Build Log block id only lives on the
  // Workspace row — we read it once here per request.
  const workspaceRow = await prisma.workspace.findUnique({
    where: { id: input.workspaceId },
    select: { forgeBuildLogBlockId: true },
  });
  if (!workspaceRow?.forgeBuildLogBlockId) {
    throw new Error('workspace install incomplete');
  }

  const gen = await createGeneration({
    workspaceId: input.workspaceId,
    userId: input.userId,
    notionRowId: null,
    description: input.description,
    descriptionHash: hash,
  });

  await publishGenerationRequested({
    generationId: gen.id,
    workspaceId: input.workspaceId,
    notionWorkspaceId: input.notionWorkspaceId,
    userId: input.userId,
    // MCP callers are bots; we don't have a Clerk-backed email for them.
    // Use a synthetic so the Shipper's email-send gates safely on "no
    // recipient".
    userEmail: `${input.userId}@mcp.local`,
    description: input.description,
    descriptionHash: hash,
    force: input.force,
    buildLogBlockId: asBlockId(workspaceRow.forgeBuildLogBlockId),
    notionRequestRowId: '',
  });

  await capture({
    distinctId: input.userId,
    event: 'forge.generation.requested',
    workspaceId: input.workspaceId,
    properties: { generationId: gen.id, source: input.source },
  });

  return { generationId: gen.id };
}

/**
 * `getGenerationStatus` implementation.
 *
 * SECURITY: scopes by `context.workspaceId`. A row that exists in a different
 * workspace is collapsed to `null` so the MCP client cannot probe for
 * generation ids that belong to other tenants.
 */
async function getGenerationStatus(
  id: string,
  context: ForgeMcpContext,
): Promise<GenerationStatusView | null> {
  const row = await getGenerationWithSteps(id);
  if (!row || row.workspaceId !== context.workspaceId) return null;
  return {
    id: row.id,
    status: row.status,
    pattern: row.pattern,
    agentId: row.agentId,
    createdAt: row.startedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    totalLatencyMs: row.totalLatencyMs,
    totalCostUsd:
      row.totalCostUsd === null ? null : Number(row.totalCostUsd),
    steps: row.steps.map((s) => ({
      id: s.id,
      agent: s.agent,
      attempt: s.attempt,
      status: s.status,
      modelUsed: s.modelUsed,
      startedAt: s.startedAt.toISOString(),
      completedAt: s.completedAt?.toISOString() ?? null,
      latencyMs: s.latencyMs,
      costUsd: s.costUsd === null ? null : Number(s.costUsd),
      errorJson: s.errorJson,
    })),
  };
}

/**
 * `listAgents` implementation. Filters by status when supplied. We never
 * surface `retracted` rows (the repository already excludes them).
 */
async function listAgents(
  filter: { status?: AgentStatus },
  context: ForgeMcpContext,
): Promise<ReadonlyArray<GeneratedAgentView>> {
  const rows = await findActiveAgentsByWorkspace(context.workspaceId);
  const filtered = filter.status
    ? rows.filter((r) => r.status === filter.status)
    : rows;
  return filtered.map((r) => ({
    id: r.id,
    ntnWorkerName: r.ntnWorkerName,
    ntnDeployUrl: r.ntnDeployUrl,
    pattern: r.pattern,
    description: r.description,
    status: r.status,
    avatarUrl: r.avatarUrl,
    oauthProviders: r.oauthProviders,
    createdAt: r.createdAt.toISOString(),
  }));
}

const mcpConfig: ForgeMcpConfig = {
  workflowTrigger,
  getGenerationStatus,
  listAgents,
  logger,
};

// ---------------------------------------------------------------------------
// HTTP entry points
// ---------------------------------------------------------------------------

/**
 * POST → JSON-RPC 2.0 message. The package's transport adapter handles
 * `initialize`, `tools/list`, `tools/call`, `prompts/list`, `prompts/get`,
 * `resources/list`, `resources/read`, etc.
 */
export const POST = withSentry(
  async (req) => {
    const auth = await authenticate(req);
    if (!auth.ok) return auth.response;

    const server = createForgeMcpServer(auth.context, mcpConfig);
    return handleMcpHttpRequest(req, server, auth.context, { logger });
  },
  { routeName: 'mcp.rpc' },
);

/**
 * GET → the stateless transport returns 405 (no standalone SSE channel).
 * Authentication still runs first so unauthenticated probes get the
 * standard 401, not a leaked "method not allowed".
 */
export const GET = withSentry(
  async (req) => {
    const auth = await authenticate(req);
    if (!auth.ok) return auth.response;
    const server = createForgeMcpServer(auth.context, mcpConfig);
    return handleMcpHttpRequest(req, server, auth.context, { logger });
  },
  { routeName: 'mcp.sse' },
);

/**
 * DELETE → same story: stateless transport returns 405. Authenticate first.
 */
export const DELETE = withSentry(
  async (req) => {
    const auth = await authenticate(req);
    if (!auth.ok) return auth.response;
    const server = createForgeMcpServer(auth.context, mcpConfig);
    return handleMcpHttpRequest(req, server, auth.context, { logger });
  },
  { routeName: 'mcp.delete' },
);
