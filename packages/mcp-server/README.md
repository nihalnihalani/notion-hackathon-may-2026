# @forge/mcp-server

Exposes Forge as a Model Context Protocol (MCP) server so external agents (Claude Code, Cursor, ChatGPT, other LLM clients) can invoke `forge_agent`, read deployed agents, and diagnose failures without going through the Notion UI.

Built against [`@modelcontextprotocol/sdk@^1.29`](https://www.npmjs.com/package/@modelcontextprotocol/sdk) targeting MCP spec version `2025-06-18` (Streamable HTTP transport, JSON-mode framing).

## Public API surface

| Symbol | Purpose |
|---|---|
| `createForgeMcpServer(ctx, config)` | Build a stateless `McpServer` with Forge's tools/prompts/resource. |
| `handleMcpHttpRequest(req, server, ctx)` | Web-standard (Edge-safe) adapter from `Request` to `Response`. |
| `forgeAgent`, `getGenerationStatus`, `listMyAgents` | Pure handler functions (also re-exported for tests). |
| `PROMPT_CATALOG`, `renderDescribeAgentPrompt`, `renderDiagnoseFailurePrompt` | Prompt templates + metadata. |
| `readForgeAgentsResource`, `FORGE_AGENTS_URI` | The `forge://agents` resource handler. |
| `ForgeMcpError` (+ subclasses) | Typed error hierarchy mapped to `{isError: true, structuredContent: {error: ...}}` MCP responses. |
| `ForgeMcpContext`, `ForgeMcpConfig` | Per-request principal + dependency-injection contracts. |

## What the server exposes to MCP clients

**Tools (3):**

- `forge_agent` — compile a plain-English description into a deployed Notion Custom Agent. Mutating; `readOnlyHint: false`, `openWorldHint: true`. Clients SHOULD prompt for user confirmation per the spec's Trust & Safety guidance.
- `get_generation_status` — read-only poll of a `Generation` + its step trail.
- `list_my_agents` — read-only list of the workspace's `active`/`paused` agents.

**Prompts (2):**

- `forge_describe_agent` — scaffold a high-quality `description` from input/output/triggers slots.
- `forge_diagnose_failure` — walk through a failed generation step-by-step.

**Resources (1):**

- `forge://agents` — JSON dump of the workspace's deployed agents (parallel surface to `list_my_agents`).

## Auth model

Authentication is the route handler's responsibility. By the time anything in this package runs, the bearer token has been validated against the `ApiKey` table in `apps/web` and a `ForgeMcpContext` has been minted. The server itself never touches the API key.

## Statelessness

The server holds **no per-request state**. A new `McpServer` is created per `/api/mcp` invocation; the in-memory transport pair is torn down at the end of every request. This matches Vercel's Edge function model and means there are zero session-management bugs to worry about.

## Tests

- `test/tools.test.ts` — unit tests on the pure handlers (happy + error paths for all three tools).
- `test/prompts.test.ts` — template rendering, slot-fill, schema validation.
- `test/server.test.ts` — end-to-end via the SDK's `Client` + `InMemoryTransport`, plus `handleMcpHttpRequest` round-trips.

Run with `pnpm --filter @forge/mcp-server test`.
