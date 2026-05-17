/**
 * `handleMcpHttpRequest` — Edge-runtime-safe adapter between a Web standard
 * `Request` and an `McpServer` instance.
 *
 * Why we don't use the SDK's `StreamableHTTPServerTransport` directly:
 *
 *   That transport wraps a Node `IncomingMessage` / `ServerResponse` pair
 *   (via `@hono/node-server` shimming). It works on Node but pulls in
 *   modules that aren't reachable in the Edge runtime. Forge's
 *   `/api/mcp/route.ts` runs on the Edge, so we need a Web-standard
 *   bridge.
 *
 * How this works:
 *
 *   1. We construct an in-memory transport pair (`InMemoryTransport`).
 *   2. We connect one end to the `McpServer`. The server is now driven
 *      entirely by `onmessage` callbacks on the other end.
 *   3. We push the client's JSON-RPC request into the server side.
 *   4. We wait for the matching JSON-RPC response (matched by `id`) on the
 *      other end, then return it.
 *   5. If `Accept` lists `text/event-stream` AND the client opts into SSE
 *      via that header alone (no `application/json`), we frame the same
 *      response as a single SSE event. The MCP spec allows the server to
 *      choose; JSON is simpler, lossless, and the only mode that fits a
 *      one-shot serverless handler.
 *
 * Statelessness:
 *
 *   This adapter is fully stateless — every request gets a fresh transport
 *   pair and the server pump completes before we respond. The route handler
 *   in `apps/web` is the right place to add cross-request concerns
 *   (rate-limit, key rotation, audit log).
 */

import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

import type { ForgeMcpContext, Logger } from './types.js';
import { noopLogger } from './types.js';

function noopResolve(): void {
  // Replaced immediately when the response wait promise is constructed.
}

/**
 * Web-standard MCP request handler.
 *
 * @param req     The Fetch API `Request`.
 * @param server  An `McpServer` instance (typically built per-request via
 *                `createForgeMcpServer(context, config)`).
 * @param context Carried for logging/audit only; the server already has its
 *                copy via closure. Included so the route handler doesn't
 *                need to pass it twice.
 * @param options.logger  Optional structured logger.
 */
export async function handleMcpHttpRequest(
  req: Request,
  server: McpServer,
  context: ForgeMcpContext,
  options?: { logger?: Logger },
): Promise<Response> {
  const logger = options?.logger ?? noopLogger;
  const method = req.method.toUpperCase();

  // GET → standalone SSE channel for server-initiated messages. We don't
  // emit any in stateless mode, so 405 is the spec-compliant answer.
  if (method === 'GET') {
    return new Response(
      'Method Not Allowed: stateless MCP endpoint does not offer a standalone SSE stream',
      {
        status: 405,
        headers: {
          Allow: 'POST, DELETE',
          'Content-Type': 'text/plain',
        },
      },
    );
  }

  // DELETE → session termination. Stateless = no session; respond 405 per spec.
  if (method === 'DELETE') {
    return new Response('Method Not Allowed: stateless MCP endpoint has no sessions to terminate', {
      status: 405,
      headers: {
        Allow: 'POST',
        'Content-Type': 'text/plain',
      },
    });
  }

  if (method !== 'POST') {
    return new Response(`Method Not Allowed: ${method}`, {
      status: 405,
      headers: { Allow: 'POST', 'Content-Type': 'text/plain' },
    });
  }

  // ── Parse body ──────────────────────────────────────────────────────────
  let body: unknown;
  try {
    const text = await req.text();
    if (text.length === 0) {
      return jsonRpcParseError(null, 'Request body was empty');
    }
    body = JSON.parse(text);
  } catch (error) {
    logger.error('mcp.transport.parse_error', {
      workspaceId: context.workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return jsonRpcParseError(null, 'Failed to parse JSON-RPC payload');
  }

  if (!isJsonRpcMessage(body)) {
    return jsonRpcParseError(extractId(body), 'Payload is not a valid JSON-RPC message');
  }

  // Per spec: a notification or response from the client gets a bare 202.
  // Only a request expects a response back.
  const isRequest = isJsonRpcRequest(body);

  // ── Bridge: spin up an in-memory transport pair and connect the server ──
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();

  // We collect every JSON-RPC payload the server emits towards the client
  // until we observe the matching response (`id` equals the request id) or
  // the client side closes. For notifications/responses there's no matching
  // id, so we close immediately after the message has been delivered.
  const collected: JSONRPCMessage[] = [];

  // Resolver wiring up the wait loop below.
  let resolve: (value: void | PromiseLike<void>) => void = noopResolve;
  const done = new Promise<void>((r) => {
    resolve = r;
  });

  // `isRequest` narrows the JSON-RPC union, but the SDK's discriminated union
  // types don't propagate that narrowing here — re-extract via `extractId`
  // which already knows how to read the id off any shape.
  const targetId = isRequest ? extractId(body) : null;

  // InMemoryTransport exposes callback properties, not EventTarget methods.
  // eslint-disable-next-line unicorn/prefer-add-event-listener
  clientSide.onmessage = (message) => {
    collected.push(message);
    if (targetId !== null && isJsonRpcResponseMatching(message, targetId)) {
      resolve();
    }
  };
  // eslint-disable-next-line unicorn/prefer-add-event-listener
  clientSide.onclose = () => {
    resolve();
  };
  // eslint-disable-next-line unicorn/prefer-add-event-listener
  clientSide.onerror = () => {
    resolve();
  };

  try {
    await server.connect(serverSide);
  } catch (error) {
    logger.error('mcp.transport.connect_failed', {
      workspaceId: context.workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return jsonRpcInternalError(extractId(body), 'Server failed to attach to transport');
  }

  // Deliver the request to the server.
  try {
    await clientSide.send(body);
  } catch (error) {
    await safeClose(server, clientSide);
    logger.error('mcp.transport.send_failed', {
      workspaceId: context.workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return jsonRpcInternalError(extractId(body), 'Failed to deliver request to server');
  }

  // Notifications and client-side responses don't get a body back.
  if (!isRequest) {
    // Give the server one microtask tick to consume the message, then close.
    await Promise.resolve();
    await safeClose(server, clientSide);
    return new Response(null, { status: 202 });
  }

  await done;
  await safeClose(server, clientSide);

  // We've already returned 202 above when `!isRequest`, so by here `targetId`
  // is non-null. Narrow explicitly for the compiler.
  if (targetId === null) {
    return jsonRpcInternalError(null, 'Unexpected null request id');
  }
  const matchId = targetId;
  const response = collected.find((m) => isJsonRpcResponseMatching(m, matchId));
  if (!response) {
    return jsonRpcInternalError(matchId, 'Server completed without producing a JSON-RPC response');
  }

  // ── Negotiate response framing: JSON vs SSE ─────────────────────────────
  const accept = (req.headers.get('accept') ?? '').toLowerCase();
  const acceptsJson =
    accept.includes('application/json') || accept === '' || accept.includes('*/*');
  const acceptsSse = accept.includes('text/event-stream');

  if (!acceptsJson && acceptsSse) {
    return sseResponse(response);
  }

  return jsonResponse(response);
}

// ───────────────────────────────────────────────────────────────────────────
// Internal helpers
// ───────────────────────────────────────────────────────────────────────────

function jsonResponse(payload: JSONRPCMessage, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

function sseResponse(payload: JSONRPCMessage): Response {
  // Single-event SSE stream. Per the SSE spec each event is a sequence of
  // `field: value\n` lines terminated by a blank line.
  const data = `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
  return new Response(data, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    },
  });
}

function jsonRpcParseError(id: string | number | null, message: string): Response {
  return jsonResponse(
    {
      jsonrpc: '2.0',
      // Parse errors per spec use a null id when the offending id can't be determined.
      id: id ?? null,
      error: { code: -32_700, message },
    } as JSONRPCMessage,
    400,
  );
}

function jsonRpcInternalError(id: string | number | null, message: string): Response {
  return jsonResponse(
    {
      jsonrpc: '2.0',
      id: id ?? null,
      error: { code: -32_603, message },
    } as JSONRPCMessage,
    500,
  );
}

function isJsonRpcMessage(value: unknown): value is JSONRPCMessage {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as {
    jsonrpc?: unknown;
    method?: unknown;
    id?: unknown;
    result?: unknown;
    error?: unknown;
  };
  if (v.jsonrpc !== '2.0') return false;
  // Either a request (method + id), a notification (method, no id), a
  // response (id + result), or an error response (id + error).
  if (typeof v.method === 'string') return true;
  if ((typeof v.id === 'string' || typeof v.id === 'number') && ('result' in v || 'error' in v))
    return true;
  return false;
}

function isJsonRpcRequest(value: JSONRPCMessage): value is JSONRPCMessage & {
  id: string | number;
  method: string;
} {
  const v = value as { method?: unknown; id?: unknown };
  return typeof v.method === 'string' && (typeof v.id === 'string' || typeof v.id === 'number');
}

function isJsonRpcResponseMatching(message: JSONRPCMessage, targetId: string | number): boolean {
  const v = message as { id?: unknown; result?: unknown; error?: unknown };
  if (v.id !== targetId) return false;
  return 'result' in v || 'error' in v;
}

function extractId(value: unknown): string | number | null {
  if (typeof value !== 'object' || value === null) return null;
  const id = (value as { id?: unknown }).id;
  return typeof id === 'string' || typeof id === 'number' ? id : null;
}

async function safeClose(server: McpServer, transport: InMemoryTransport): Promise<void> {
  // Order matters: close the client side first so any in-flight server
  // send() observes the disconnect and unblocks. Then close the server,
  // which also tears down the server-side transport.
  try {
    await transport.close();
  } catch {
    /* ignore: best-effort cleanup */
  }
  try {
    await server.close();
  } catch {
    /* ignore: best-effort cleanup */
  }
}
