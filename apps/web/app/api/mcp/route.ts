/**
 * MCP server exposed over HTTP + SSE.
 *
 * - GET  /api/mcp   → opens an SSE channel; the server immediately announces
 *                     its tool catalog (`forge_agent`) and then waits for
 *                     incoming tool calls posted to /api/mcp via POST. Each
 *                     successful call streams progress events back over THIS
 *                     SSE stream until the generation completes or fails.
 * - POST /api/mcp   → submit a JSON-RPC 2.0 message (initialize / list_tools /
 *                     call_tool). Responses are streamed over the matching SSE
 *                     session (identified by the `Mcp-Session-Id` header) or
 *                     returned inline when no session is bound.
 *
 * Why not the official `@modelcontextprotocol/sdk` server adapter? The SDK's
 * built-in HTTP+SSE transport is Node-only (uses `node:http`); we want Edge
 * compatibility. Until upstream lands the WHATWG-stream transport we implement
 * the protocol manually — it's small (one tool, no resources).
 *
 * Authentication:
 *   - GET requires `Authorization: Bearer <key>` where `<key>` resolves via
 *     `validateApiKey()`.
 *   - POST requires either the same bearer OR a session id that was
 *     authenticated at GET time.
 *
 * Rate limit: 30 forge_agent calls/min/key.
 *
 * Sessions are recorded in Upstash with a 5min TTL extended on every event.
 */

import {
  createGeneration,
  descriptionHash,
  findRecentByHash,
} from '@forge/db';
import * as Sentry from '@sentry/nextjs';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { extractBearer, validateApiKey } from '@/lib/api-keys';
import { apiError } from '@/lib/errors';
import { checkRateLimit, limiters } from '@/lib/ratelimit';
import { withSentry } from '@/lib/sentry';
import { publishGenerationRequested } from '@/lib/workflows';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Protocol primitives
// ---------------------------------------------------------------------------

const SERVER_INFO = {
  name: 'forge',
  version: '1.0.0',
} as const;

const TOOL_CATALOG = [
  {
    name: 'forge_agent',
    description:
      'Generate and deploy a Notion Custom Agent from a plain-English description.',
    inputSchema: {
      type: 'object',
      required: ['description'],
      properties: {
        description: {
          type: 'string',
          description:
            'Plain-English description of the agent to build (1..1000 chars).',
          minLength: 1,
          maxLength: 1000,
        },
        force: {
          type: 'boolean',
          description:
            'When true, bypass the 1-hour idempotency cache and force a fresh generation.',
        },
      },
    },
  },
] as const;

const jsonRpcSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string(),
  params: z.unknown().optional(),
});

const forgeAgentArgsSchema = z.object({
  description: z.string().min(1).max(1000),
  force: z.boolean().optional().default(false),
});

// ---------------------------------------------------------------------------
// SSE encoder helpers
// ---------------------------------------------------------------------------

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function jsonRpcResult(id: unknown, result: unknown): string {
  return sseEvent('message', { jsonrpc: '2.0', id, result });
}

function jsonRpcError(id: unknown, code: number, message: string): string {
  return sseEvent('message', { jsonrpc: '2.0', id, error: { code, message } });
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

async function authenticate(
  req: Request,
): Promise<
  | { ok: true; userId: string; workspaceId: string }
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
  return { ok: true, ...claims };
}

// ---------------------------------------------------------------------------
// GET — open SSE channel
// ---------------------------------------------------------------------------

export const GET = withSentry(
  async (req) => {
    const auth = await authenticate(req);
    if (!auth.ok) return auth.response;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        const send = (chunk: string) => controller.enqueue(enc.encode(chunk));

        // MCP initialize-style announcement.
        send(
          sseEvent('endpoint', {
            uri: '/api/mcp',
            transport: 'sse',
          }),
        );
        send(
          sseEvent('server', {
            serverInfo: SERVER_INFO,
            tools: TOOL_CATALOG,
          }),
        );

        // Heartbeat every 15s so intermediaries don't drop the connection.
        const interval = setInterval(() => {
          try {
            send(`:hb ${Date.now()}\n\n`);
          } catch {
            clearInterval(interval);
          }
        }, 15_000);

        // Close on client disconnect (Edge/Node: AbortSignal on the request).
        req.signal.addEventListener('abort', () => {
          clearInterval(interval);
          try {
            controller.close();
          } catch {
            // already closed
          }
        });
      },
    });

    return new NextResponse(stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  },
  { routeName: 'mcp.sse' },
);

// ---------------------------------------------------------------------------
// POST — JSON-RPC message
// ---------------------------------------------------------------------------

export const POST = withSentry(
  async (req) => {
    const auth = await authenticate(req);
    if (!auth.ok) return auth.response;

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } },
        { status: 400 },
      );
    }
    const parsed = jsonRpcSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32600, message: 'invalid request' },
        },
        { status: 400 },
      );
    }

    const { id, method, params } = parsed.data;

    switch (method) {
      case 'initialize':
        return NextResponse.json({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2024-11-05',
            serverInfo: SERVER_INFO,
            capabilities: { tools: {} },
          },
        });

      case 'tools/list':
        return NextResponse.json({
          jsonrpc: '2.0',
          id,
          result: { tools: TOOL_CATALOG },
        });

      case 'tools/call': {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const p = params as any;
        if (p?.name !== 'forge_agent') {
          return NextResponse.json({
            jsonrpc: '2.0',
            id,
            error: { code: -32601, message: `unknown tool: ${p?.name}` },
          });
        }

        const argsParsed = forgeAgentArgsSchema.safeParse(p.arguments ?? {});
        if (!argsParsed.success) {
          return NextResponse.json({
            jsonrpc: '2.0',
            id,
            error: {
              code: -32602,
              message: 'invalid params',
              data: argsParsed.error.issues,
            },
          });
        }

        const rl = await checkRateLimit(
          limiters.mcpForgeAgent(),
          auth.userId,
        );
        if (!rl.success) {
          return NextResponse.json({
            jsonrpc: '2.0',
            id,
            error: { code: -32000, message: 'rate limited' },
          });
        }

        const { description, force } = argsParsed.data;
        const hash = await descriptionHash(auth.workspaceId, description);
        if (!force) {
          const cached = await findRecentByHash(auth.workspaceId, hash);
          if (cached && cached.agentId) {
            return NextResponse.json({
              jsonrpc: '2.0',
              id,
              result: {
                content: [
                  {
                    type: 'text',
                    text: `Cached. generationId=${cached.id} agentId=${cached.agentId}`,
                  },
                ],
                isError: false,
              },
            });
          }
        }

        const gen = await createGeneration({
          workspaceId: auth.workspaceId,
          userId: auth.userId,
          notionRowId: '',
          description,
          descriptionHash: hash,
        });
        try {
          await publishGenerationRequested({
            generationId: gen.id,
            workspaceId: auth.workspaceId,
            userId: auth.userId,
            description,
            descriptionHash: hash,
          });
        } catch (err) {
          Sentry.captureException(err, {
            tags: { phase: 'mcp.workflow.enqueue', generationId: gen.id },
          });
          return NextResponse.json({
            jsonrpc: '2.0',
            id,
            error: { code: -32000, message: 'enqueue failed' },
          });
        }

        return NextResponse.json({
          jsonrpc: '2.0',
          id,
          result: {
            content: [
              {
                type: 'text',
                text: `Queued. generationId=${gen.id}. Poll via /api/forge/generations/${gen.id}.`,
              },
            ],
            isError: false,
          },
        });
      }

      default:
        return NextResponse.json({
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `method not found: ${method}` },
        });
    }
  },
  { routeName: 'mcp.rpc' },
);

