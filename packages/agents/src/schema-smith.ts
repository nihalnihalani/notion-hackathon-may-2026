/**
 * Schema Smith — the first of the four Forge sub-agents.
 *
 * Job (per PLAN.md §4.1):
 *   Convert an English description + a snapshot of the user's Notion workspace
 *   into a {@link SchemaSmithOutput}: a `pattern`, an `inputSchema`, an
 *   `outputSchema`, the minimal Notion scopes + provider OAuth needed, and a
 *   `rationale` shown in the Notion Build Log.
 *
 * Production behavior:
 *
 *  1. Call Anthropic Messages (Opus 4.7 by default) via either the direct API
 *     or the Vercel AI Gateway (`aiGatewayUrl`).
 *
 *  2. The system prompt is sent as TWO blocks: the first (static) block
 *     — role, output contract, JSchemaSpec reference, pattern hints, scope
 *     vocabulary — is wrapped in `cache_control: { type: 'ephemeral' }`
 *     so it shares one cache key across every workspace + every call. The
 *     second block carries the per-call `WorkspaceContext` (database ids,
 *     existing-agent list) and is NOT cached. This is the fix for the
 *     previous "interpolated workspace context into the cached prompt"
 *     bug, which broke cache reuse per workspace and per database-added.
 *
 *  3. Parse the response → strict JSON → zod-validate against
 *     {@link schemaSmithOutputSchema}. On validation failure, retry ONCE with
 *     the zod errors appended to the user message. On a second failure throw
 *     {@link SchemaSmithError}.
 *
 *  4. Self-eval: the returned `inputSchema` + `outputSchema` must each pass
 *     {@link validateJSchema}. On failure, retry once with the validator error
 *     appended (counts against the same retry budget).
 *
 *  5. Fallback: if the primary provider throws a `RateLimitError` or a 5xx,
 *     auto-fall-back to OpenAI (`gpt-5-thinking-mini` by default — the
 *     August-2025 reasoning mini SKU; the bare `gpt-5` id is not a real
 *     model). Same prompt, same parsing. Both providers failing →
 *     {@link ProviderFallbackError}.
 *
 *  6. Cost + latency are emitted via `logger.info('schema-smith.complete', …)`
 *     so the orchestrator can persist a `GenerationStep` row + push a
 *     PostHog event.
 *
 * What we deliberately do NOT do here:
 *
 *  - No outer-loop retries — Inngest / Workflow DevKit own those (PLAN.md §4
 *    "Common configuration"). We retry at most ONCE for parse/validate, and at
 *    most ONCE for fallback.
 *  - No DB writes. Persistence is the orchestrator's job.
 *  - No streaming. Schema Smith returns a small structured payload; streaming
 *    adds parsing complexity for ~no UX win.
 */

import { createAnthropicClient, type AnthropicClient } from '@forge/connectors/anthropic';
import { createOpenaiClient, type OpenaiClient } from '@forge/connectors/openai';
import { RateLimitError, ConnectorError } from '@forge/connectors';
import { SchemaSmithError, ProviderFallbackError } from './errors.js';
import { validateJSchema } from './schema/j-spec.js';
import { anthropicCostUsd, openaiCostUsd } from './cost.js';
import {
  ALL_AGENT_PATTERNS,
  noopLogger,
  schemaSmithOutputSchema,
  type AnthropicClientLike,
  type OpenaiClientLike,
  type SchemaSmithOutput,
  type SubAgentConfig,
  type WorkspaceContext,
} from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Public input + entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Input shape for {@link schemaSmith}.
 */
export interface SchemaSmithInput {
  /** Free-text description typed by the user into the Forge Requests DB row. */
  description: string;
  /** Snapshot of the user's workspace — populated by the orchestrator. */
  workspaceContext: WorkspaceContext;
  /** Shared sub-agent config (clients, models, logger, abort signal). */
  config: SubAgentConfig;
}

/**
 * Run Schema Smith on `input` and return the structured output.
 *
 * Throws {@link SchemaSmithError} if both attempts on the primary provider
 * fail, or {@link ProviderFallbackError} if both primary and fallback fail.
 *
 * Honors `config.abortSignal` — the call propagates the signal into every
 * HTTP request so a Workflow cancellation aborts in-flight without leaking
 * the request.
 */
export async function schemaSmith(input: SchemaSmithInput): Promise<SchemaSmithOutput> {
  const startedAt = Date.now();
  const logger = input.config.logger ?? noopLogger;
  const primaryModel = input.config.primaryModel ?? 'claude-opus-4-7';
  const fallbackModel = input.config.fallbackModel ?? 'gpt-5-thinking-mini';

  const staticSystem = buildStaticSystemPrompt();
  const workspaceSystem = buildWorkspaceContextPrompt(input.workspaceContext);
  const userPrompt = buildUserPrompt(input.description);

  // Attempt 1 + (on parse/validate failure) Attempt 2 on the primary provider.
  try {
    const out = await runWithAnthropic({
      input,
      staticSystem,
      workspaceSystem,
      userPrompt,
      model: primaryModel,
      startedAt,
      logger,
    });
    return out;
  } catch (error) {
    if (isFallbackEligible(error)) {
      logger.info('schema-smith.fallback', {
        from: primaryModel,
        to: fallbackModel,
        reason: errReason(error),
      });
      try {
        const out = await runWithOpenai({
          input,
          staticSystem,
          workspaceSystem,
          userPrompt,
          model: fallbackModel,
          startedAt,
          logger,
        });
        return out;
      } catch (error_) {
        throw new ProviderFallbackError('Schema Smith: primary + fallback both failed', {
          agentName: 'schema_smith',
          cause: error_,
          detail: {
            primaryModel,
            fallbackModel,
            primaryError: errReason(error),
            fallbackError: errReason(error_),
          },
        });
      }
    }
    if (error instanceof SchemaSmithError) throw error;
    throw new SchemaSmithError(`Schema Smith failed on primary provider: ${errReason(error)}`, {
      cause: error,
      detail: { primaryModel },
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Anthropic primary path
// ─────────────────────────────────────────────────────────────────────────────

interface RunContext {
  input: SchemaSmithInput;
  /** Stable, large, cacheable. Renders once per process. */
  staticSystem: string;
  /** Per-call: contains workspace ids + agent list. Never cached. */
  workspaceSystem: string;
  userPrompt: string;
  model: string;
  startedAt: number;
  logger: { info: (msg: string, meta?: Record<string, unknown>) => void };
}

async function runWithAnthropic(ctx: RunContext): Promise<SchemaSmithOutput> {
  const client: AnthropicClientLike =
    ctx.input.config.anthropicClient ?? buildAnthropicClient(ctx.input.config);

  let lastError: string | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const userMessage =
      lastError === null
        ? ctx.userPrompt
        : `${ctx.userPrompt}\n\nPREVIOUS_ATTEMPT_ERROR:\n${lastError}\n\nRespond again with corrected JSON.`;

    // Two-block system: first block is cacheable; second is per-call.
    // `cacheControl: false` on the per-call block prevents accidental
    // cache-write billing on workspace-context bytes.
    const res = await client.complete(
      {
        model: ctx.model,
        maxTokens: 2048,
        temperature: 0,
        // Note: we DO NOT pass `cacheControl: true` here — that flag only
        // wraps a string `system` and would defeat our explicit two-block
        // shape. We attach cache_control on the static block directly.
        system: [
          {
            type: 'text',
            text: ctx.staticSystem,
            cache_control: { type: 'ephemeral' },
          },
          { type: 'text', text: ctx.workspaceSystem },
        ],
        messages: [{ role: 'user', content: userMessage }],
      },
      ctx.input.config.abortSignal === undefined
        ? undefined
        : { signal: ctx.input.config.abortSignal },
    );

    const raw = extractText(res.content);
    const parsed = tryParseAndValidate(raw);
    if (parsed.ok) {
      const costUsd = anthropicCostUsd(res.usage, ctx.model);
      ctx.logger.info('schema-smith.complete', {
        agent: 'schema_smith',
        model: ctx.model,
        attempt,
        inputTokens: res.usage.input_tokens,
        outputTokens: res.usage.output_tokens,
        cacheReadTokens: res.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: res.usage.cache_creation_input_tokens ?? 0,
        costUsd,
        latencyMs: Date.now() - ctx.startedAt,
      });
      return parsed.output;
    }
    lastError = parsed.error;
  }

  throw new SchemaSmithError(`Schema Smith: response failed validation after retry`, {
    detail: { model: ctx.model, lastError: lastError ?? 'unknown' },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// OpenAI fallback path
// ─────────────────────────────────────────────────────────────────────────────

async function runWithOpenai(ctx: RunContext): Promise<SchemaSmithOutput> {
  const client: OpenaiClientLike | undefined =
    ctx.input.config.openaiClient ?? maybeBuildOpenaiClient(ctx.input.config);
  if (!client) {
    throw new SchemaSmithError(
      'Schema Smith fallback unavailable: no OpenAI client + no openaiApiKey',
      { detail: { fallbackModel: ctx.model } },
    );
  }

  let lastError: string | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const userMessage =
      lastError === null
        ? ctx.userPrompt
        : `${ctx.userPrompt}\n\nPREVIOUS_ATTEMPT_ERROR:\n${lastError}\n\nRespond again with corrected JSON.`;

    // OpenAI Chat Completions takes a single `system` string — no caching
    // hook to preserve, so we concatenate the static + workspace blocks
    // exactly in order. The model sees identical content to the Anthropic
    // path; only the wire format differs.
    const openaiSystem = `${ctx.staticSystem}\n\n${ctx.workspaceSystem}`;
    const res = await client.complete(
      {
        model: ctx.model,
        maxTokens: 2048,
        temperature: 0,
        responseFormat: { type: 'json_object' },
        messages: [
          { role: 'system', content: openaiSystem },
          { role: 'user', content: userMessage },
        ],
      },
      ctx.input.config.abortSignal === undefined
        ? undefined
        : { signal: ctx.input.config.abortSignal },
    );

    const raw = res.choices[0]?.message.content ?? '';
    const parsed = tryParseAndValidate(raw);
    if (parsed.ok) {
      const costUsd = openaiCostUsd(res.usage, ctx.model);
      ctx.logger.info('schema-smith.complete', {
        agent: 'schema_smith',
        model: ctx.model,
        attempt,
        inputTokens: res.usage.prompt_tokens,
        outputTokens: res.usage.completion_tokens ?? 0,
        costUsd,
        latencyMs: Date.now() - ctx.startedAt,
      });
      return parsed.output;
    }
    lastError = parsed.error;
  }

  throw new SchemaSmithError(`Schema Smith fallback: response failed validation after retry`, {
    detail: { model: ctx.model, lastError: lastError ?? 'unknown' },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Client builders (only used when caller didn't pre-build one)
// ─────────────────────────────────────────────────────────────────────────────

function buildAnthropicClient(config: SubAgentConfig): AnthropicClient {
  return createAnthropicClient({
    apiKey: config.anthropicApiKey,
    ...(config.aiGatewayUrl === undefined ? {} : { gatewayUrl: config.aiGatewayUrl }),
  });
}

function maybeBuildOpenaiClient(config: SubAgentConfig): OpenaiClient | undefined {
  if (!config.openaiApiKey) return undefined;
  return createOpenaiClient({
    apiKey: config.openaiApiKey,
    ...(config.aiGatewayUrl === undefined ? {} : { gatewayUrl: config.aiGatewayUrl }),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Parsing / validation
// ─────────────────────────────────────────────────────────────────────────────

type ParseResult = { ok: true; output: SchemaSmithOutput } | { ok: false; error: string };

function tryParseAndValidate(raw: string): ParseResult {
  const jsonText = extractJsonBlock(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    return {
      ok: false,
      error: `Response is not valid JSON: ${(error as Error).message}`,
    };
  }

  const z = schemaSmithOutputSchema.safeParse(parsed);
  if (!z.success) {
    const summary = z.error.issues
      .slice(0, 8)
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    return { ok: false, error: `JSON shape invalid: ${summary}` };
  }

  // Self-eval (PLAN.md §4.1) — round-trip both schemas through validateJSchema.
  const inOk = validateJSchema(z.data.inputSchema);
  if (!inOk.ok) {
    return { ok: false, error: `inputSchema invalid: ${inOk.error}` };
  }
  const outOk = validateJSchema(z.data.outputSchema);
  if (!outOk.ok) {
    return { ok: false, error: `outputSchema invalid: ${outOk.error}` };
  }

  return { ok: true, output: z.data };
}

/**
 * Extract a JSON object from a possibly-decorated model response (the model
 * sometimes wraps JSON in a ```json fenced block).
 */
function extractJsonBlock(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) return trimmed;

  // Look for ```json … ``` first, then plain ``` … ```.
  const fenced = /```(?:json)?\s*([\s\S]*?)```/u.exec(trimmed);
  if (fenced?.[1]) return fenced[1].trim();

  // Last resort: first `{` to last `}`.
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first !== -1 && last > first) {
    return trimmed.slice(first, last + 1);
  }
  return trimmed;
}

function extractText(
  content: readonly ({ type: 'text'; text: string } | { type: string; [key: string]: unknown })[],
): string {
  return content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt construction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * STATIC system prompt for Schema Smith.
 *
 * This is the cacheable block — role, output contract, JSchemaSpec
 * reference, pattern hints, scope vocabulary, quality bar. Contains
 * NOTHING workspace-specific. Stable across every workspace, every call,
 * every retry, so it hits the 5-minute ephemeral cache for the price of
 * one write per ~5min window.
 *
 * Quality trade-off: Schema Smith no longer sees the workspace inline as
 * part of the cached prompt. We compensate by passing the workspace as a
 * second (non-cached) system block — the model still receives it before
 * the user prompt, just at a different cache tier. Anthropic's docs
 * confirm only blocks BEFORE the first `cache_control` boundary are
 * cached, so the contract here is: static first, workspace second.
 */
function buildStaticSystemPrompt(): string {
  const patternsBlock = ALL_AGENT_PATTERNS.map((p) => `- ${p}: ${PATTERN_HINTS[p]}`).join('\n');

  return `You are Schema Smith, the first sub-agent in the Forge pipeline.
You convert ONE English description of a Notion Custom Agent into a strict JSON
specification that the next sub-agent (Tool Coder) will turn into TypeScript.

# Output format

Return EXACTLY one JSON object — no prose, no markdown fences, no commentary.
The object MUST match this TypeScript type:

  type Output = {
    pattern:
      | "database-query" | "webhook-trigger" | "sync-source"
      | "external-api-call" | "multi-step"
      | null,
    inputSchema: JSchemaSpec,
    outputSchema: JSchemaSpec,
    requiredScopes: NotionScope[],
    requiredOAuth: ProviderName[],
    rationale: string,
  }

If the user's description is ambiguous OR doesn't fit any of the five patterns,
return \`pattern: null\` and put your clarifying question in \`rationale\`. In
this case still return minimal stub schemas (\`{kind:"object", describe:"...",
properties:{}}\`) for inputSchema/outputSchema — the pipeline will halt before
they are used.

# The five patterns

${patternsBlock}

# JSchemaSpec — the only shapes allowed

JSchemaSpec is a discriminated union on \`kind\`. ANY field outside this
specification will be rejected as a hallucination.

Scalar kinds: "string" | "number" | "integer" | "boolean" | "email" | "uuid" | "datetime"
  {
    kind: <scalar>,
    describe: string,            // human-readable, required, ≥1 char
    nullable?: boolean,
    enum?: string[],             // string-valued enums only
  }

Object kind:
  {
    kind: "object",
    describe: string,
    properties: { [name: string]: JSchemaSpec },
    required?: string[],         // subset of property names
    nullable?: boolean,
  }

Array kind:
  {
    kind: "array",
    describe: string,
    items: JSchemaSpec,
    nullable?: boolean,
  }

# Scopes & OAuth

requiredScopes is the MINIMUM set of Notion scopes the generated worker needs.
Allowed values: pages.read, pages.write, databases.read, databases.write,
comments.read, comments.write, users.read, workspace.read.

requiredOAuth lists external providers (GitHub, Linear, Stripe, Slack, Google,
Sentry, Vercel, Anthropic, OpenAI, MiniMax) the worker calls. Omit Notion —
it's the always-implicit host. Empty array if none.

# Quality bar

- Prefer reusing an existing database's id over inventing a new shape.
- Match property names exactly when referring to a database column.
- \`rationale\` is shown to the user in the Notion Build Log — keep it under
  400 characters, plain English, no jargon.
- Use \`email\` / \`uuid\` / \`datetime\` over \`string\` when the value has
  that shape.
- For \`webhook-trigger\` agents, the inputSchema describes the incoming
  webhook payload; for \`sync-source\` it describes the per-tick input
  (usually empty: \`{kind:"object", describe:"...", properties:{}}\`).
- For \`database-query\` agents, requiredScopes MUST include at least
  databases.read.

The user message will be preceded by a "WORKSPACE CONTEXT" block carrying the
caller's databases and existing agents — read that block carefully and do
not invent IDs.
`;
}

/**
 * Per-call WORKSPACE CONTEXT system prompt for Schema Smith.
 *
 * Built fresh per generation; NEVER cached. Anthropic prompt-cache rules
 * say only the blocks before the first `cache_control` are cached, so
 * this block sits second in the system array.
 */
function buildWorkspaceContextPrompt(ctx: WorkspaceContext): string {
  const dbBlock =
    ctx.databases.length === 0
      ? 'No databases in this workspace yet.'
      : ctx.databases
          .map((db) => {
            const props = db.properties.map((p) => `      - ${p.name} (${p.type})`).join('\n');
            return `  - id=${db.id}  name=${db.name}\n${props}`;
          })
          .join('\n');

  const agentsBlock =
    ctx.existingAgents.length === 0
      ? 'No agents shipped yet.'
      : ctx.existingAgents
          .map((a) => `  - ${a.name} [${a.pattern}] — ${truncate(a.description, 160)}`)
          .join('\n');

  return `# WORKSPACE CONTEXT (read carefully — do not invent IDs)

Databases:
${dbBlock}

Existing agents (do NOT duplicate behavior; reference them in your rationale
if relevant):
${agentsBlock}
`;
}

const PATTERN_HINTS: Record<(typeof ALL_AGENT_PATTERNS)[number], string> = {
  'database-query':
    'Read from / write to a Notion database. No external systems. One worker.tool() call.',
  'webhook-trigger':
    'Receives a webhook from an external provider and writes the result into Notion. One worker.webhook() handler.',
  'sync-source':
    'Polls an external system on a schedule and upserts rows into a Notion database. One worker.sync() with cursor state.',
  'external-api-call':
    'A single outbound HTTP call to an external API, returning the result. One worker.tool().',
  'multi-step':
    'Combines two of the above sequentially (e.g. read DB → call API → write DB). Up to three steps.',
};

function buildUserPrompt(description: string): string {
  return `Describe the agent the user wants, then output the JSON.

USER_DESCRIPTION:
"""
${description.trim()}
"""

Output the single JSON object now.`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Error classification
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Should we fall back to OpenAI when the primary path threw this error?
 *
 * Yes for rate limits, 5xx server errors, and network errors. No for 4xx
 * client errors (auth failures, validation errors raised by the connector)
 * because the fallback would just hit the same misconfiguration.
 */
function isFallbackEligible(err: unknown): boolean {
  if (err instanceof RateLimitError) return true;
  if (err instanceof ConnectorError) {
    if (err.status >= 500 && err.status <= 599) return true;
    if (err.status === 0) return true; // network error
  }
  return false;
}

function errReason(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}
