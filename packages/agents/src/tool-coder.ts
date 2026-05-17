/**
 * Tool Coder — the second of the four Forge sub-agents.
 *
 * Job (per PLAN.md §4.2):
 *   Given a description + Schema Smith's structured output, generate a
 *   single Worker `src/index.ts`. Output is a {@link ToolCoderOutput}: the
 *   raw TS source, line count, a `package.json` patch (deps the Worker
 *   needs beyond the workspace floor), and the derived Worker name.
 *
 * Production behavior:
 *
 *  1. Call Anthropic Messages (Opus 4.7 by default). The system prompt is
 *     LARGE — it carries the Worker-template reference + the j-builder
 *     cheatsheet + all eight {@link FEW_SHOT_EXAMPLES} — and is wrapped
 *     in `cache_control: { type: 'ephemeral' }`. Cache hit rate is the
 *     dominant cost driver for this sub-agent.
 *
 *  2. Extended thinking budget = 4096 tokens; max_output = 4096. We pass
 *     `maxTokens: 4096` to the connector. Extended thinking is REQUESTED
 *     in the system prompt directive (see {@link buildSystemPrompt})
 *     because the connector's `complete` surface doesn't expose a
 *     first-class `thinking` field at this revision — when it does
 *     (planned: Q1 2026), we wire it as an explicit param.
 *
 *  3. The user message carries the description, the schemas, and the
 *     OAuth/scope requirements. On retry the previous parse error is
 *     appended verbatim — the model corrects its own bug rather than
 *     guessing what we wanted.
 *
 *  4. Self-eval: parse the extracted TS with @typescript-eslint/parser
 *     (see `./ts-validation`). On parse failure retry ONCE. After 2
 *     retries throw {@link ToolCoderError}.
 *
 *  5. Fallback: on Anthropic RateLimitError or 5xx, switch to OpenAI
 *     (`config.fallbackModel ?? 'gpt-5'`). Extended thinking is NOT
 *     requested on the fallback — GPT-5's surface differs. Both
 *     providers failing → {@link ProviderFallbackError}.
 *
 *  6. The `packageJsonPatch` is computed deterministically from the
 *     IMPORTS in the generated source (so the model can't sneak in a
 *     dep the safety scanner will reject). Inspector / Shipper merge
 *     this patch into the Worker scaffold's `package.json`.
 *
 *  7. The `workerName` is derived via {@link deriveWorkerName} —
 *     deterministic on the description so re-runs upsert.
 *
 *  8. Cost + latency emitted via `logger.info('tool-coder.complete', …)`.
 *
 * What we deliberately do NOT do:
 *
 *  - No outer-loop retries — Inngest / Workflow DevKit owns retries
 *    across sub-agents.
 *  - No streaming. The Worker source fits in one response window.
 *  - No safety scan here. The Inspector runs `@forge/safety/scan`
 *    against the output; on `block` violations we re-enter Tool Coder
 *    with the errors as `prevErrors`.
 */

import { createAnthropicClient, type AnthropicClient } from '@forge/connectors/anthropic';
import { createOpenaiClient, type OpenaiClient } from '@forge/connectors/openai';
import { RateLimitError, ConnectorError } from '@forge/connectors';
import { ToolCoderError, ProviderFallbackError } from './errors.js';
import { anthropicCostUsd, openaiCostUsd } from './cost.js';
import { extractTsCodeFromResponse, parseGeneratedTs } from './ts-validation.js';
import { deriveWorkerName } from './worker-name.js';
import { FEW_SHOT_EXAMPLES, type FewShotExample } from './few-shot/index.js';
import {
  noopLogger,
  type AnthropicClientLike,
  type OpenaiClientLike,
  type SchemaSmithOutput,
  type SubAgentConfig,
  type ToolCoderOutput,
} from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Public input + entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Input shape for {@link toolCoder}.
 *
 * `prevErrors` is non-empty when the Orchestrator is re-entering Tool Coder
 * after the Inspector found a safety violation OR a tsc failure — we
 * surface those errors into the model's user message so the second pass
 * sees them.
 */
export interface ToolCoderInput {
  description: string;
  schema: SchemaSmithOutput;
  prevErrors?: readonly string[];
  config: SubAgentConfig;
}

/**
 * Extended thinking budget. PLAN.md §4.2 pins both at 4096 tokens — this
 * keeps the cap symmetric so we can charge the user against a single
 * "thinking + output" budget line in PostHog.
 */
const THINKING_BUDGET_TOKENS = 4096;
const MAX_OUTPUT_TOKENS = 4096;

/**
 * Run Tool Coder. Returns the structured output; throws
 * {@link ToolCoderError} on exhausted retries or {@link ProviderFallbackError}
 * when both primary + fallback providers fail.
 */
export async function toolCoder(input: ToolCoderInput): Promise<ToolCoderOutput> {
  const startedAt = Date.now();
  const logger = input.config.logger ?? noopLogger;
  const primaryModel = input.config.primaryModel ?? 'claude-opus-4-7';
  const fallbackModel = input.config.fallbackModel ?? 'gpt-5';

  const workerName = deriveWorkerName(input.description);

  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt({
    description: input.description,
    schema: input.schema,
    workerName,
    prevErrors: input.prevErrors ?? [],
  });

  try {
    return await runWithAnthropic({
      input,
      systemPrompt,
      userPrompt,
      model: primaryModel,
      startedAt,
      logger,
      workerName,
    });
  } catch (error) {
    if (isFallbackEligible(error)) {
      logger.info('tool-coder.fallback', {
        from: primaryModel,
        to: fallbackModel,
        reason: errReason(error),
      });
      try {
        return await runWithOpenai({
          input,
          systemPrompt,
          userPrompt,
          model: fallbackModel,
          startedAt,
          logger,
          workerName,
        });
      } catch (fallbackError) {
        throw new ProviderFallbackError('Tool Coder: primary + fallback both failed', {
          agentName: 'tool_coder',
          cause: fallbackError,
          detail: {
            primaryModel,
            fallbackModel,
            primaryError: errReason(error),
            fallbackError: errReason(fallbackError),
          },
        });
      }
    }
    if (error instanceof ToolCoderError) throw error;
    throw new ToolCoderError(`Tool Coder failed on primary provider: ${errReason(error)}`, {
      cause: error,
      detail: { primaryModel },
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Anthropic primary path
// ─────────────────────────────────────────────────────────────────────────────

interface RunContext {
  input: ToolCoderInput;
  systemPrompt: string;
  userPrompt: string;
  model: string;
  startedAt: number;
  logger: { info: (msg: string, meta?: Record<string, unknown>) => void };
  workerName: string;
}

async function runWithAnthropic(ctx: RunContext): Promise<ToolCoderOutput> {
  const client: AnthropicClientLike =
    ctx.input.config.anthropicClient ?? buildAnthropicClient(ctx.input.config);

  let lastError: string | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const userMessage =
      lastError === null
        ? ctx.userPrompt
        : `${ctx.userPrompt}\n\nPREVIOUS_ATTEMPT_PARSE_ERROR:\n${lastError}\n\nRegenerate the FULL src/index.ts with the parse error corrected. Output only one fenced \`\`\`typescript code block.`;

    const res = await client.complete(
      {
        model: ctx.model,
        maxTokens: MAX_OUTPUT_TOKENS,
        temperature: 0,
        cacheControl: true,
        system: ctx.systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      },
      ctx.input.config.abortSignal === undefined
        ? undefined
        : { signal: ctx.input.config.abortSignal },
    );

    const raw = extractText(res.content);
    const parsed = tryExtractAndParse(raw);
    if (parsed.ok) {
      const costUsd = anthropicCostUsd(res.usage, ctx.model);
      ctx.logger.info('tool-coder.complete', {
        agent: 'tool_coder',
        model: ctx.model,
        attempt,
        inputTokens: res.usage.input_tokens,
        outputTokens: res.usage.output_tokens,
        cacheReadTokens: res.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: res.usage.cache_creation_input_tokens ?? 0,
        thinkingBudgetTokens: THINKING_BUDGET_TOKENS,
        costUsd,
        latencyMs: Date.now() - ctx.startedAt,
        workerName: ctx.workerName,
      });
      return buildOutput(parsed.source, ctx.workerName);
    }
    lastError = parsed.error;
  }

  throw new ToolCoderError('Tool Coder: response failed parse after retry', {
    detail: { model: ctx.model, lastError: lastError ?? 'unknown' },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// OpenAI fallback path
// ─────────────────────────────────────────────────────────────────────────────

async function runWithOpenai(ctx: RunContext): Promise<ToolCoderOutput> {
  const client: OpenaiClientLike | undefined =
    ctx.input.config.openaiClient ?? maybeBuildOpenaiClient(ctx.input.config);
  if (!client) {
    throw new ToolCoderError(
      'Tool Coder fallback unavailable: no OpenAI client + no openaiApiKey',
      { detail: { fallbackModel: ctx.model } },
    );
  }

  let lastError: string | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const userMessage =
      lastError === null
        ? ctx.userPrompt
        : `${ctx.userPrompt}\n\nPREVIOUS_ATTEMPT_PARSE_ERROR:\n${lastError}\n\nRegenerate the FULL src/index.ts with the parse error corrected. Output only one fenced \`\`\`typescript code block.`;

    const res = await client.complete(
      {
        model: ctx.model,
        maxTokens: MAX_OUTPUT_TOKENS,
        temperature: 0,
        responseFormat: { type: 'text' },
        messages: [
          { role: 'system', content: ctx.systemPrompt },
          { role: 'user', content: userMessage },
        ],
      },
      ctx.input.config.abortSignal === undefined
        ? undefined
        : { signal: ctx.input.config.abortSignal },
    );

    const raw = res.choices[0]?.message.content ?? '';
    const parsed = tryExtractAndParse(raw);
    if (parsed.ok) {
      const costUsd = openaiCostUsd(res.usage, ctx.model);
      ctx.logger.info('tool-coder.complete', {
        agent: 'tool_coder',
        model: ctx.model,
        attempt,
        inputTokens: res.usage.prompt_tokens,
        outputTokens: res.usage.completion_tokens ?? 0,
        costUsd,
        latencyMs: Date.now() - ctx.startedAt,
        workerName: ctx.workerName,
      });
      return buildOutput(parsed.source, ctx.workerName);
    }
    lastError = parsed.error;
  }

  throw new ToolCoderError('Tool Coder fallback: response failed parse after retry', {
    detail: { model: ctx.model, lastError: lastError ?? 'unknown' },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Output construction
// ─────────────────────────────────────────────────────────────────────────────

function buildOutput(source: string, workerName: string): ToolCoderOutput {
  return {
    source,
    sourceLines: source.split(/\r?\n/u).length,
    packageJsonPatch: { dependencies: derivePackageJsonPatch(source) },
    workerName,
  };
}

/**
 * Scan the generated source for `import ... from '<pkg>'` and emit a
 * dependency patch for `package.json`. Pinned to caret-major against the
 * versions Forge currently supports — Inspector overrides if the workspace
 * has a newer floor.
 *
 * Why static-string-only: dynamic imports are blocked by `no-eval`. Any
 * non-allowlisted dep would also be rejected by `@forge/safety/scan`, so
 * this function only emits the SUBSET the templates approve.
 */
function derivePackageJsonPatch(source: string): Record<string, string> {
  const versions: Record<string, string> = {};
  // Match `from '<package>'` — single OR double quotes. We deliberately
  // don't try to parse the whole AST here; the safety scanner is the
  // source of truth, this is just a fast-path for the package.json patch.
  const importRegex = /from\s+['"]([^'"]+)['"]/gu;
  for (const match of source.matchAll(importRegex)) {
    const spec = match[1];
    if (!spec) continue;
    const pkgName = packageNameOf(spec);
    if (pkgName === null) continue;
    const version = PINNED_DEP_VERSIONS[pkgName];
    if (version === undefined) continue; // not on the allowlist — Inspector rejects later
    versions[pkgName] = version;
  }
  return versions;
}

/**
 * Strip the subpath from an import spec to get the dep name.
 *
 *   '@forge/connectors/github' → '@forge/connectors'
 *   '@notionhq/client'          → '@notionhq/client'
 *   'date-fns/subDays'          → 'date-fns'
 *   './local'                   → null   (not an npm dep)
 *   'node:crypto'               → null
 */
function packageNameOf(spec: string): string | null {
  if (spec.startsWith('.') || spec.startsWith('/')) return null;
  if (spec.startsWith('node:')) return null;
  const parts = spec.split('/');
  if (parts[0] === undefined) return null;
  if (parts[0].startsWith('@')) {
    if (parts[1] === undefined) return null;
    return `${parts[0]}/${parts[1]}`;
  }
  return parts[0];
}

/**
 * Versions Tool Coder pins in the emitted patch. The Inspector's package
 * normalizer may upgrade caret ranges based on the workspace floor — these
 * are the lower bounds.
 *
 * Adding a new package here is a security review item (it expands the
 * dependency attack surface).
 */
const PINNED_DEP_VERSIONS: Readonly<Record<string, string>> = Object.freeze({
  '@notionhq/client': '^2.2.15',
  '@notion/workers-sdk': '^0.1.0',
  '@forge/connectors': 'workspace:*',
  zod: '^3.23.8',
  'date-fns': '^4.1.0',
});

// ─────────────────────────────────────────────────────────────────────────────
// Parse-and-extract helper
// ─────────────────────────────────────────────────────────────────────────────

type ExtractResult = { ok: true; source: string } | { ok: false; error: string };

function tryExtractAndParse(raw: string): ExtractResult {
  const code = extractTsCodeFromResponse(raw);
  if (code === null) {
    return {
      ok: false,
      error:
        'Response did not contain a TypeScript code block. Emit exactly one ```typescript ... ``` block.',
    };
  }
  const parsed = parseGeneratedTs(code);
  if (!parsed.ok) {
    return {
      ok: false,
      error: parsed.errors.join('; '),
    };
  }
  return { ok: true, source: code };
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
// Prompt construction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * System prompt — large, stable, and wrapped in an ephemeral cache block by
 * the Anthropic client. Contains:
 *
 *  - Role + output contract
 *  - The Worker SDK & j-builder reference
 *  - The full {@link FEW_SHOT_EXAMPLES} catalog
 *
 * Workspace-specific context does NOT live here (unlike Schema Smith). Tool
 * Coder is fully driven by the schema; the cache key is therefore stable
 * across users which maximises hit rate.
 */
function buildSystemPrompt(): string {
  return `You are Tool Coder, the second sub-agent in the Forge pipeline.
You convert a Notion-Custom-Agent specification (a JSON schema + a pattern)
into one production-grade \`src/index.ts\` for a Notion Worker.

# Reasoning

Use extended thinking to plan before writing code. Budget up to
${THINKING_BUDGET_TOKENS} tokens of internal reasoning, but keep visible
output to ONE fenced \`\`\`typescript code block — no prose before, no
prose after.

# Output contract

Return exactly ONE fenced TypeScript code block. The block IS the entire
\`src/index.ts\`. No commentary, no markdown headers, no second block.

The file MUST:
  - Be valid TypeScript (no syntax errors).
  - Use ES module imports only.
  - Import from the dep allowlist ONLY:
      '@notion/workers-sdk', '@notionhq/client', 'zod', 'date-fns',
      and any '@forge/connectors/<provider>' subpath.
  - Register exactly one handler — \`worker.tool({...})\`,
    \`worker.sync({...})\`, or \`worker.webhook({...})\` — matching the
    declared pattern.
  - Wrap external calls in try/catch and return a STRUCTURED result:
      { ok: true,  ...payload }
      { ok: false, error: string }
    The handler MUST NOT throw to the runtime.
  - Read secrets from \`process.env['KEY']\` (bracket form). Never
    WRITE process.env. Never use eval / new Function / dynamic import.
  - Never use \`console.log\`. Use the returned result for diagnostics.
  - Never use \`child_process\`, raw \`fs\` outside /tmp, raw network
    calls (\`fetch\`, \`http\`, \`axios\`). Use the connector SDKs.

# Worker SDK reference

The \`@notion/workers-sdk\` exports:
  - \`worker.tool({ name, description, input, output, handler })\`
  - \`worker.sync({ name, description, input, output, handler })\`
      handler signature: \`(input, ctx: { cursor: string|null }) => ...\`
  - \`worker.webhook({ name, description, input, output, handler })\`
      handler signature: \`(event) => ...\`
  - \`j\` — schema builder.

# j-builder reference

\`j.string()\` / \`j.number()\` / \`j.integer()\` / \`j.boolean()\` /
\`j.email()\` / \`j.uuid()\` / \`j.datetime()\` — scalar kinds. Chain
\`.enum([...])\` (string scalars), \`.nullable()\`, \`.describe(text)\`.

\`j.object({ field: j.string()... }).required(['field']).describe(text)\` —
objects.

\`j.array(j.string()...).describe(text)\` — arrays.

# Connector imports

\`@forge/connectors/<provider>\` exposes \`create<Provider>Client({ apiKey })\`.
Each client returns parsed JSON; methods throw typed errors
(ConnectorError, RateLimitError, AuthError) that bubble into your try/catch
naturally.

Providers + env-var conventions:
  - github  → createGithubClient   → GITHUB_TOKEN
  - linear  → createLinearClient   → LINEAR_API_KEY
  - stripe  → createStripeClient   → STRIPE_API_KEY
  - slack   → createSlackClient    → SLACK_BOT_TOKEN
  - google  → createGmailClient    → GOOGLE_ACCESS_TOKEN
  - sentry  → createSentryClient   → SENTRY_API_TOKEN
  - vercel  → createVercelClient   → VERCEL_API_TOKEN
  - anthropic → createAnthropicClient → ANTHROPIC_API_KEY
  - openai  → createOpenaiClient   → OPENAI_API_KEY
  - minimax → createMinimaxClient  → MINIMAX_API_KEY

The Notion client is constructed as:
  new NotionClient({ auth: process.env['NOTION_API_KEY'] ?? '' })

# Pattern templates

  - database-query: one \`worker.tool()\` reading/writing a Notion DB.
  - external-api-call: one \`worker.tool()\` calling a connector method.
  - webhook-trigger: one \`worker.webhook()\` consuming a provider event
    and writing into Notion.
  - sync-source: one \`worker.sync()\` polling a connector and upserting
    into Notion. Honor the \`ctx.cursor\` argument.
  - multi-step: one \`worker.tool()\` chaining 2-3 sub-operations.

# Few-shot examples

${renderFewShots(FEW_SHOT_EXAMPLES)}
`;
}

function renderFewShots(examples: readonly FewShotExample[]): string {
  return examples
    .map((ex, idx) => {
      return `## Example ${idx + 1}: ${ex.description}

Pattern: ${ex.schema.pattern ?? 'unspecified'}
requiredOAuth: ${JSON.stringify(ex.schema.requiredOAuth)}

Expected output:
\`\`\`typescript
${ex.expectedSource.trim()}
\`\`\`
`;
    })
    .join('\n');
}

function buildUserPrompt(args: {
  description: string;
  schema: SchemaSmithOutput;
  workerName: string;
  prevErrors: readonly string[];
}): string {
  const prevBlock =
    args.prevErrors.length === 0
      ? ''
      : `PREVIOUS_INSPECTOR_ERRORS (fix these in this attempt):
${args.prevErrors.map((e) => `  - ${e}`).join('\n')}

`;
  return `${prevBlock}USER_DESCRIPTION:
"""
${args.description.trim()}
"""

WORKER_NAME: ${args.workerName}
PATTERN: ${args.schema.pattern ?? '<unspecified>'}

INPUT_SCHEMA:
${JSON.stringify(args.schema.inputSchema, null, 2)}

OUTPUT_SCHEMA:
${JSON.stringify(args.schema.outputSchema, null, 2)}

REQUIRED_NOTION_SCOPES: ${JSON.stringify(args.schema.requiredScopes)}
REQUIRED_OAUTH_PROVIDERS: ${JSON.stringify(args.schema.requiredOAuth)}

Emit the complete src/index.ts now. Use the exact WORKER_NAME above as the
\`name\` field of your worker.tool/sync/webhook call. Output ONE
\`\`\`typescript code block.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Misc helpers
// ─────────────────────────────────────────────────────────────────────────────

function extractText(
  content: readonly ({ type: 'text'; text: string } | { type: string; [key: string]: unknown })[],
): string {
  return content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

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
