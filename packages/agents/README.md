# @forge/agents

The four Forge sub-agents plus shared types, errors, and pure helpers used by all of them. Sequenced from the `@forge/workflows` orchestrator (Vercel Workflow DevKit DAG) on every Forge generation.

```
description ─▶ Schema Smith ─▶ Tool Coder ─▶ Inspector ─▶ Shipper ─▶ Custom Agent
```

## Sub-agents

| Agent        | Entry point                                  | Job                                                                                                                                            | Status     |
| ------------ | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| Schema Smith | `@forge/agents/schema-smith` → `schemaSmith` | English + workspace context → `{pattern, inputSchema, outputSchema, requiredScopes, requiredOAuth, rationale}` ([PLAN.md §4.1](../../PLAN.md)) | ✅ shipped |
| Tool Coder   | `@forge/agents/tool-coder` → `toolCoder`     | Schema Smith output + description → `src/index.ts` using `worker.tool/sync/webhook` ([PLAN.md §4.2](../../PLAN.md))                            | ✅ shipped |
| Inspector    | `@forge/agents/inspector` → `inspector`      | AST safety + `tsc --noEmit` + `ntn workers exec` against synthetic input; feeds failures back to Tool Coder ([PLAN.md §4.3](../../PLAN.md))    | ✅ shipped |
| Shipper      | `@forge/agents/shipper` → `shipper`          | `ntn workers deploy` → discover capabilities → wire Custom Agent → archive source → email user ([PLAN.md §4.4](../../PLAN.md))                 | ✅ shipped |

The orchestrator (`@forge/workflows`) sequences all four with durable retries.

## Common configuration

Every sub-agent accepts a `SubAgentConfig`:

```ts
interface SubAgentConfig {
  primaryProvider?: 'openai' | 'anthropic'; // default 'openai'
  anthropicApiKey?: string; // required only when primaryProvider='anthropic'
  aiGatewayUrl?: string; // when set, routes via Vercel AI Gateway
  openaiApiKey: string; // required by default and for fallback
  primaryModel?: string; // default 'gpt-5.5'
  fallbackModel?: string; // default 'gpt-5.4-mini'
  logger?: SubAgentLogger; // default noopLogger
  abortSignal?: AbortSignal; // propagated into every HTTP call
  anthropicClient?: AnthropicClientLike; // pre-built (testing); overrides key
  openaiClient?: OpenaiClientLike; // pre-built (testing); overrides key
}
```

Defaults:

- Primary model: **`gpt-5.5`** via OpenAI direct or Vercel AI Gateway.
- Fallback: **`gpt-5.4-mini`** via OpenAI, triggered on primary-provider 5xx / rate-limit.
- Prompt caching: Anthropic override mode uses provider prompt caching; the
  database prompt cache can also short-circuit repeated or semantically similar
  descriptions through `@forge/db`.

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
