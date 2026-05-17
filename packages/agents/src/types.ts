/**
 * Shared types for every Forge sub-agent.
 *
 * Design decisions documented in-line:
 *
 *  1. **`AgentPattern` is a string-literal union, not a Prisma enum re-export.**
 *     Prisma names the enum values in snake_case (`database_query`) which is
 *     awkward at the agent API boundary where PLAN.md §4.1 specifies kebab-case
 *     (`database-query`). The serialized output shipped to Notion + stored in
 *     `Generation.pattern` uses the kebab-case form; conversion to/from the
 *     Prisma enum is the orchestrator's job, not the sub-agent's. Decoupling
 *     here keeps the sub-agents portable across the (eventual) MCP server +
 *     dashboard surfaces too.
 *
 *  2. **`SubAgentConfig` accepts pre-built clients** (`anthropicClient`,
 *     `openaiClient`) as optional injections. This is what makes the agents
 *     testable without monkey-patching `globalThis.fetch`. When omitted, the
 *     factory at the top of each agent builds a client from `anthropicApiKey`
 *     / `openaiApiKey` + `aiGatewayUrl`.
 *
 *  3. **`JSchemaSpec` is a hand-written discriminated union, not zod-derived.**
 *     This is the *restricted subset* of `j` builder ops Tool Coder can render.
 *     Keeping the union narrow is a security feature — any field the sub-agent
 *     emits but Tool Coder can't render is a hallucination, surfaced loudly.
 */

import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────────
// Agent pattern
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The 5 supported tool patterns Forge can ship (see PLAN.md §4 + §XVI).
 *
 * Kebab-case at the agent boundary. The orchestrator converts to the Prisma
 * `AgentPattern` snake_case enum (`database_query`, …) before persisting.
 */
export type AgentPattern =
  | 'database-query'
  | 'webhook-trigger'
  | 'sync-source'
  | 'external-api-call'
  | 'multi-step';

export const agentPatternSchema = z.enum([
  'database-query',
  'webhook-trigger',
  'sync-source',
  'external-api-call',
  'multi-step',
]);

/** Full set of pattern values — useful for prompt rendering + validation. */
export const ALL_AGENT_PATTERNS: readonly AgentPattern[] = [
  'database-query',
  'webhook-trigger',
  'sync-source',
  'external-api-call',
  'multi-step',
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Notion scopes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Notion API scopes a generated agent can request. Schema Smith returns the
 * minimum set; the user is prompted to grant only what's required.
 *
 * NOTE: This list is a constrained subset of Notion's full scope space. If the
 * platform later exposes additional scopes, append here — adding values is
 * non-breaking; removing values is.
 */
export type NotionScope =
  | 'pages.read'
  | 'pages.write'
  | 'databases.read'
  | 'databases.write'
  | 'comments.read'
  | 'comments.write'
  | 'users.read'
  | 'workspace.read';

export const notionScopeSchema = z.enum([
  'pages.read',
  'pages.write',
  'databases.read',
  'databases.write',
  'comments.read',
  'comments.write',
  'users.read',
  'workspace.read',
]);

// ─────────────────────────────────────────────────────────────────────────────
// Provider names
// ─────────────────────────────────────────────────────────────────────────────

/**
 * First-party connector names. Matches the directory layout under
 * `packages/connectors/src/` and the entries in PLAN.md Part XI.
 *
 * Defined here (not re-exported from `@forge/connectors`) because the
 * sub-agents reason about provider *intent* — not the underlying client
 * factory — and we want sub-agents to keep typechecking even if the connectors
 * package adds a provider before Tool Coder's prompt cache is updated.
 */
export type ProviderName =
  | 'github'
  | 'linear'
  | 'stripe'
  | 'slack'
  | 'google'
  | 'sentry'
  | 'vercel'
  | 'anthropic'
  | 'openai'
  | 'minimax';

export const providerNameSchema = z.enum([
  'github',
  'linear',
  'stripe',
  'slack',
  'google',
  'sentry',
  'vercel',
  'anthropic',
  'openai',
  'minimax',
]);

// ─────────────────────────────────────────────────────────────────────────────
// JSchemaSpec — restricted subset of `j` builder ops
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Recursive discriminated union describing the JSON Schema we let Schema Smith
 * emit. Each variant maps 1:1 to a `j` builder method renderable by Tool
 * Coder.
 *
 * Why a hand-written type vs zod-derived: zod's recursive inference is brittle
 * at strict-mode TS settings (`exactOptionalPropertyTypes`). Hand-writing
 * keeps inference predictable.
 */
export type JSchemaSpec =
  | {
      kind: 'string' | 'number' | 'integer' | 'boolean' | 'email' | 'uuid' | 'datetime';
      describe: string;
      nullable?: boolean | undefined;
      enum?: readonly string[] | undefined;
    }
  | {
      kind: 'object';
      describe: string;
      properties: Record<string, JSchemaSpec>;
      required?: readonly string[] | undefined;
      nullable?: boolean | undefined;
    }
  | {
      kind: 'array';
      describe: string;
      items: JSchemaSpec;
      nullable?: boolean | undefined;
    };

/**
 * Zod schema for {@link JSchemaSpec}. Uses `z.lazy` for recursion.
 *
 * NOTE: `exactOptionalPropertyTypes` means we explicitly tag `nullable` /
 * `enum` / `required` as `.optional()` and never write `undefined` into the
 * shape. The runtime check still mirrors {@link JSchemaSpec}.
 */
export const jSchemaSpecSchema: z.ZodType<JSchemaSpec> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z.object({
      kind: z.enum(['string', 'number', 'integer', 'boolean', 'email', 'uuid', 'datetime']),
      describe: z.string().min(1),
      nullable: z.boolean().optional(),
      enum: z.array(z.string()).optional(),
    }),
    z.object({
      kind: z.literal('object'),
      describe: z.string().min(1),
      properties: z.record(jSchemaSpecSchema),
      required: z.array(z.string()).optional(),
      nullable: z.boolean().optional(),
    }),
    z.object({
      kind: z.literal('array'),
      describe: z.string().min(1),
      items: jSchemaSpecSchema,
      nullable: z.boolean().optional(),
    }),
  ]),
);

// ─────────────────────────────────────────────────────────────────────────────
// Workspace context (fed into Schema Smith)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Snapshot of the user's Notion workspace passed to Schema Smith so it can
 * reason about existing databases + already-shipped agents. Populated by the
 * caller from `ntn datasources query` + a DB lookup.
 */
export interface WorkspaceContext {
  databases: readonly {
    id: string;
    name: string;
    properties: readonly { name: string; type: string }[];
  }[];
  existingAgents: readonly {
    name: string;
    pattern: AgentPattern;
    description: string;
  }[];
}

export const workspaceContextSchema: z.ZodType<WorkspaceContext> = z.object({
  databases: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      properties: z.array(
        z.object({
          name: z.string(),
          type: z.string(),
        }),
      ),
    }),
  ),
  existingAgents: z.array(
    z.object({
      name: z.string(),
      pattern: agentPatternSchema,
      description: z.string(),
    }),
  ),
});

// ─────────────────────────────────────────────────────────────────────────────
// Logger
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Minimal structured logger surface shared by every sub-agent.
 *
 * Why a custom interface (vs pino/winston): sub-agents run in three runtimes
 * (Node, Edge, Vercel Sandbox) and we don't want a transitive logger
 * dependency that breaks the Edge bundle. Callers wire their preferred logger
 * by adapting it to this shape.
 *
 * Default is no-op (silent) — provided by {@link noopLogger}.
 */
export interface SubAgentLogger {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
}

/**
 * Silent default logger used when {@link SubAgentConfig.logger} is omitted.
 * Side-effect free; safe for any runtime.
 */
export const noopLogger: SubAgentLogger = {
  info: () => {
    /* no-op */
  },
  error: () => {
    /* no-op */
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// SubAgentConfig — accepted by every sub-agent
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The minimal shape of an Anthropic client that sub-agents call.
 *
 * Defined structurally (not by importing `AnthropicClient` from
 * `@forge/connectors`) so test code can supply a small stub matching only the
 * `complete` surface. The runtime `createAnthropicClient` output trivially
 * satisfies this shape.
 */
export interface AnthropicClientLike {
  complete: (
    params: {
      model: string;
      messages: { role: 'user' | 'assistant'; content: string }[];
      system?:
        | string
        | {
            type: 'text';
            text: string;
            cache_control?: { type: 'ephemeral' };
          }[];
      maxTokens: number;
      temperature?: number;
      cacheControl?: boolean;
    },
    opts?: { signal?: AbortSignal },
  ) => Promise<{
    id: string;
    content: readonly ({ type: 'text'; text: string } | { type: string; [key: string]: unknown })[];
    model: string;
    usage: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens?: number | undefined;
      cache_read_input_tokens?: number | undefined;
    };
  }>;
}

/**
 * Minimal shape of an OpenAI client used as the Schema Smith fallback.
 * Mirrors `OpenaiClient.complete` from `@forge/connectors`.
 */
export interface OpenaiClientLike {
  complete: (
    params: {
      model: string;
      messages: {
        role: 'system' | 'user' | 'assistant' | 'tool';
        content: string | null;
      }[];
      maxTokens?: number;
      temperature?: number;
      responseFormat?: { type: 'json_object' | 'text' };
    },
    opts?: { signal?: AbortSignal },
  ) => Promise<{
    id: string;
    model: string;
    choices: readonly {
      index: number;
      message: { role: string; content: string | null };
      finish_reason?: string | null | undefined;
    }[];
    usage: {
      prompt_tokens: number;
      completion_tokens?: number | undefined;
      total_tokens: number;
    };
  }>;
}

/**
 * Configuration common to every sub-agent call.
 *
 * Field semantics:
 *
 *  - `primaryProvider`: which provider runs the primary attempt. Defaults to
 *    `'anthropic'` to match PLAN.md, unless the `FORGE_PRIMARY_PROVIDER` env
 *    var is set to `'openai'`. Set to `'openai'` for deployments that have
 *    no Anthropic credits — both the primary and fallback paths route
 *    through `runWithOpenai` with `primaryModel` and `fallbackModel`.
 *  - `anthropicApiKey`: optional. Required only when the Anthropic path will
 *    actually run (i.e. `primaryProvider === 'anthropic'` OR — in the OpenAI
 *    mode — never, since the Anthropic path is skipped entirely).
 *  - `aiGatewayUrl`: optional Vercel AI Gateway base URL; when set,
 *    `createAnthropicClient` routes through it for multi-model failover + cost
 *    tracking (PLAN.md Part II).
 *  - `openaiApiKey`: required when the fallback path can be triggered OR when
 *    `primaryProvider === 'openai'`. Schema Smith degrades to "no fallback"
 *    when missing in Anthropic mode.
 *  - `primaryModel` / `fallbackModel`: model ids. Defaults depend on
 *    `primaryProvider`:
 *      * `'anthropic'` → `claude-opus-4-7` + `gpt-5-thinking-mini`
 *      * `'openai'`    → `gpt-5-thinking-mini` + `gpt-4o`
 *    Note: the bare `gpt-5` id is NOT a real OpenAI model — only the
 *    reasoning-tier `gpt-5-thinking*` SKUs ship.
 *  - `logger`: structured logger; defaults to {@link noopLogger}.
 *  - `abortSignal`: propagated into every HTTP call so the Workflow can cancel
 *    mid-step.
 *  - `anthropicClient` / `openaiClient`: pre-built clients for tests. When
 *    supplied, the API keys are ignored for that provider.
 */
export interface SubAgentConfig {
  primaryProvider?: 'anthropic' | 'openai';
  anthropicApiKey?: string;
  aiGatewayUrl?: string;
  openaiApiKey?: string;
  primaryModel?: string;
  fallbackModel?: string;
  logger?: SubAgentLogger;
  abortSignal?: AbortSignal;
  anthropicClient?: AnthropicClientLike;
  openaiClient?: OpenaiClientLike;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-agent outputs (Schema Smith owns drafting all four; siblings refine)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Schema Smith's structured output.
 *
 * `pattern: null` means the input is ambiguous and the pipeline halts — the
 * `rationale` field carries the clarifying question shown in Notion.
 */
export interface SchemaSmithOutput {
  pattern: AgentPattern | null;
  inputSchema: JSchemaSpec;
  outputSchema: JSchemaSpec;
  requiredScopes: readonly NotionScope[];
  requiredOAuth: readonly ProviderName[];
  rationale: string;
}

export const schemaSmithOutputSchema: z.ZodType<SchemaSmithOutput> = z.object({
  pattern: agentPatternSchema.nullable(),
  inputSchema: jSchemaSpecSchema,
  outputSchema: jSchemaSpecSchema,
  requiredScopes: z.array(notionScopeSchema),
  requiredOAuth: z.array(providerNameSchema),
  rationale: z.string().min(1),
});

/**
 * Tool Coder's structured output — placeholder for sibling implementation.
 */
export interface ToolCoderOutput {
  source: string;
  sourceLines: number;
  packageJsonPatch: { dependencies: Record<string, string> };
  workerName: string;
}

export const toolCoderOutputSchema: z.ZodType<ToolCoderOutput> = z.object({
  source: z.string(),
  sourceLines: z.number().int().nonnegative(),
  packageJsonPatch: z.object({
    dependencies: z.record(z.string()),
  }),
  workerName: z.string().min(1),
});

/**
 * Inspector's structured output — placeholder for sibling implementation.
 *
 * Note `pass: false` is a normal terminal state (not an error); only sandbox
 * failures throw {@link InspectorError}.
 */
export interface InspectionResult {
  pass: boolean;
  stage: 'parse' | 'safety' | 'tsc' | 'dryrun' | 'exec';
  errors: readonly string[];
  output?: unknown;
  durationMs: number;
}

export const inspectionResultSchema: z.ZodType<InspectionResult> = z.object({
  pass: z.boolean(),
  stage: z.enum(['parse', 'safety', 'tsc', 'dryrun', 'exec']),
  errors: z.array(z.string()),
  output: z.unknown().optional(),
  durationMs: z.number().int().nonnegative(),
});

/**
 * Shipper's structured output — placeholder for sibling implementation.
 *
 * `customAgentId` may be `null` if the Notion Custom Agent REST API isn't
 * reachable and we fall back to a deep-link wire-up (see PLAN.md §4.4 Devil's
 * Advocate response).
 */
export interface ShipperResult {
  /** Local GeneratedAgent.id persisted in PlanetScale; use this for Forge URLs. */
  generatedAgentId: string;
  customAgentId: string | null;
  deployUrl: string;
  ntnWorkerName: string;
  webhookUrl?: string | undefined;
  oauthRedirectUrl?: string | undefined;
  artifactBlobUrl: string;
  capabilitiesDiscovered: number;
}

export const shipperResultSchema: z.ZodType<ShipperResult> = z.object({
  generatedAgentId: z.string(),
  customAgentId: z.string().nullable(),
  deployUrl: z.string(),
  ntnWorkerName: z.string(),
  webhookUrl: z.string().optional(),
  oauthRedirectUrl: z.string().optional(),
  artifactBlobUrl: z.string(),
  capabilitiesDiscovered: z.number().int().nonnegative(),
});

// ─────────────────────────────────────────────────────────────────────────────
// Tracing / cost-event shape (emitted by every sub-agent via logger.info)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Structured payload attached to `logger.info('<agent>.complete', meta)`. The
 * orchestrator forwards this to PostHog + the `GenerationStep` row in
 * PlanetScale.
 */
export interface SubAgentCompleteEvent {
  agent: 'schema_smith' | 'tool_coder' | 'inspector' | 'shipper';
  model: string;
  attempt: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd: number;
  latencyMs: number;
}
