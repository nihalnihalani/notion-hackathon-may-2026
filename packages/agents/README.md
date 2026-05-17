# @forge/agents

The four Forge sub-agents plus shared types, errors, and pure helpers used by all of them. Sequenced from the `@forge/workflows` orchestrator (Vercel Workflow DevKit DAG) on every Forge generation.

```
description ─▶ Schema Smith ─▶ Tool Coder ─▶ Inspector ─▶ Shipper ─▶ Custom Agent
```

## Sub-agents

| Agent        | Entry point                                  | Job                                                                                                                                            | Status          |
| ------------ | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| Schema Smith | `@forge/agents/schema-smith` → `schemaSmith` | English + workspace context → `{pattern, inputSchema, outputSchema, requiredScopes, requiredOAuth, rationale}` ([PLAN.md §4.1](../../PLAN.md)) | ✅ shipped      |
| Tool Coder   | `@forge/agents/tool-coder` (TBD)             | Schema Smith output + description → `src/index.ts` using `worker.tool/sync/webhook` ([PLAN.md §4.2](../../PLAN.md))                            | 🚧 sibling owns |
| Inspector    | `@forge/agents/inspector` (TBD)              | AST safety + `tsc --noEmit` + `ntn workers exec` against synthetic input; feeds failures back to Tool Coder ([PLAN.md §4.3](../../PLAN.md))    | 🚧 sibling owns |
| Shipper      | `@forge/agents/shipper` (TBD)                | `ntn workers deploy` → discover capabilities → wire Custom Agent → archive source → email user ([PLAN.md §4.4](../../PLAN.md))                 | 🚧 sibling owns |

The orchestrator (`@forge/workflows`) sequences all four with durable retries.

## Common configuration

Every sub-agent accepts a `SubAgentConfig`:

```ts
interface SubAgentConfig {
  anthropicApiKey: string; // required (primary provider)
  aiGatewayUrl?: string; // when set, routes via Vercel AI Gateway
  openaiApiKey?: string; // required to enable the fallback path
  primaryModel?: string; // default 'claude-opus-4-7'
  fallbackModel?: string; // default 'gpt-5'
  logger?: SubAgentLogger; // default noopLogger
  abortSignal?: AbortSignal; // propagated into every HTTP call
  anthropicClient?: AnthropicClientLike; // pre-built (testing); overrides key
  openaiClient?: OpenaiClientLike; // pre-built (testing); overrides key
}
```

Defaults:

- Primary model: **`claude-opus-4-7`** via Anthropic direct or Vercel AI Gateway.
- Fallback: **`gpt-5`** via OpenAI, triggered on Anthropic 5xx / rate-limit.
- Prompt caching: the Schema Smith system prompt is marked `cache_control: { type: 'ephemeral' }` so repeated calls within 5min hit the cache.

## Error hierarchy

All sub-agents throw a typed subclass of `SubAgentError`:

```
SubAgentError
├── SchemaSmithError       (parse/validate failed after retry)
├── ToolCoderError         (code-gen + AST retry exhausted)
├── InspectorError         (sandbox orchestration failure — not validation fail)
├── ShipperError           (deploy or wire-up failed)
└── ProviderFallbackError  (primary + fallback both failed)
```

Validation-failed-but-completed results (e.g. `InspectionResult.pass === false`) are returned, **not** thrown. Only platform / model errors throw.

## Tracing

Every sub-agent emits a structured `logger.info('<agent>.complete', meta)` event on success. The orchestrator forwards this to PostHog and persists it to the `GenerationStep` row. The shape is `SubAgentCompleteEvent` in `./types.ts`.

## Public helpers

- `validateJSchema(spec)` — round-trip check for the restricted `j` subset.
- `renderJSchemaAsTS(spec)` — emits the `j.<kind>().describe(...)` chain (Tool Coder consumes this).
- `anthropicCostUsd(usage, model)` / `openaiCostUsd(usage, model)` — pure pricing helpers.

## Testing

```sh
pnpm --filter @forge/agents test
```

Tests mock the Anthropic + OpenAI client interfaces directly (no fetch interception). Run against `vitest@2.1.8`.
