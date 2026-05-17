/**
 * Per-call LLM cost helpers.
 *
 * Pure functions: no IO, no module state. Used by every sub-agent to compute
 * `costUsd` from the provider response's usage block, then forwarded into the
 * `logger.info('<agent>.complete', { costUsd, … })` trace event.
 *
 * VERIFY: prices below are sourced from Anthropic + OpenAI public docs as of
 * 2026-01-15. Rate-check on first invocation in production — pricing changes
 * are silent. A drift here under-bills the user (acceptable) or over-warns
 * (cosmetic), but never affects correctness.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Anthropic
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Per-MTok prices for Anthropic models, in USD. Keys are exact model ids.
 *
 * "input" = uncached input tokens
 * "cacheWrite" = tokens written to the cache this request (5m TTL ephemeral)
 * "cacheRead" = tokens served from the cache this request
 * "output" = completion tokens
 *
 * Opus 4.7 is the Forge primary model; the Sonnet/Haiku entries exist so the
 * gateway can route to a cheaper SKU without our cost helper returning 0.
 *
 * Pricing sourced from https://www.anthropic.com/pricing#anthropic-api as of
 * 2026-05. Opus 4.x family is $5/$25 with 5-minute ephemeral cache at $6.25
 * write / $0.50 read; Sonnet 4.x family is $3/$15 with $3.75 / $0.30.
 */
export const ANTHROPIC_PRICES_USD_PER_MTOK = {
  // Opus 4.7 — primary generation model. Do NOT collapse these into Sonnet's
  // prices; the previous commit had this row at Sonnet values, which silently
  // under-charged by ~40% on every Tool Coder call.
  'claude-opus-4-7': {
    input: 5,
    output: 25,
    cacheWrite: 6.25,
    cacheRead: 0.5,
  },
  // Sonnet 4.6 — mid-tier; cheaper fallback for non-codegen sub-agents.
  'claude-sonnet-4-6': {
    input: 3,
    output: 15,
    cacheWrite: 3.75,
    cacheRead: 0.3,
  },
  // Sonnet 4.7 — current flagship Sonnet; same per-MTok schedule as 4.6.
  'claude-sonnet-4-7': {
    input: 3,
    output: 15,
    cacheWrite: 3.75,
    cacheRead: 0.3,
  },
  // Sonnet 4.5 — legacy, kept for gateway routing parity.
  'claude-sonnet-4-5': {
    input: 3,
    output: 15,
    cacheWrite: 3.75,
    cacheRead: 0.3,
  },
  // Haiku — cheapest fallback.
  'claude-haiku-4': {
    input: 0.8,
    output: 4,
    cacheWrite: 1,
    cacheRead: 0.08,
  },
} as const satisfies Record<
  string,
  { input: number; output: number; cacheWrite: number; cacheRead: number }
>;

/**
 * Token usage block as returned by the Anthropic Messages API. Mirrors
 * `AnthropicUsage` in `@forge/connectors/anthropic` but kept structural here
 * to avoid a hard import cycle in `cost.ts`.
 */
export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | undefined;
  cache_read_input_tokens?: number | undefined;
}

/**
 * Compute USD cost for an Anthropic Messages response.
 *
 * Unknown models return `0` — callers should branch on the result if they need
 * to enforce a budget. The sub-agents log a `costUsd: 0` event in that case
 * which surfaces visibly in PostHog dashboards (so we notice the gap).
 */
export function anthropicCostUsd(usage: AnthropicUsage, model: string): number {
  // `noUncheckedIndexedAccess` is on at the workspace level, but TS still
  // narrows the indexed lookup when the key is cast to `keyof typeof <obj>`.
  // We deliberately widen back to `unknown` to keep the unknown-model branch
  // truthful: at runtime, `model` is an arbitrary string from the caller.
  const price = (
    ANTHROPIC_PRICES_USD_PER_MTOK as Record<
      string,
      | {
          input: number;
          output: number;
          cacheWrite: number;
          cacheRead: number;
        }
      | undefined
    >
  )[model];
  if (!price) return 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const billedInput = usage.input_tokens; // input_tokens already excludes cache hits
  const inputCost = (billedInput / 1_000_000) * price.input;
  const outputCost = (usage.output_tokens / 1_000_000) * price.output;
  const cacheReadCost = (cacheRead / 1_000_000) * price.cacheRead;
  const cacheWriteCost = (cacheWrite / 1_000_000) * price.cacheWrite;
  return inputCost + outputCost + cacheReadCost + cacheWriteCost;
}

// ─────────────────────────────────────────────────────────────────────────────
// OpenAI
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Per-MTok prices for OpenAI models, in USD.
 *
 * Verified against https://developers.openai.com/api/docs/pricing on
 * 2026-05-17. The `gpt-5-thinking*` ids are the Forge-chosen routing keys for
 * Vercel AI Gateway → OpenAI reasoning SKUs. Prices below match the closest
 * standard OpenAI SKUs as of that date:
 *
 *   - `gpt-5-thinking-mini` ≈ gpt-5.4-mini ($0.75 / $4.50)
 *   - `gpt-5-thinking`      ≈ gpt-5.5      ($5 / $30)
 *
 * `gpt-5` is intentionally NOT a key here: that bare id was never released
 * by OpenAI. Callers that hand it in will get `0` from {@link openaiCostUsd}
 * — a loud signal that the model id is wrong.
 */
export const OPENAI_PRICES_USD_PER_MTOK = {
  // Routes to gpt-5.4-mini via Vercel AI Gateway. $0.75 in / $4.50 out per
  // developers.openai.com/api/docs/pricing (verified 2026-05-17).
  'gpt-5-thinking-mini': {
    input: 0.75,
    output: 4.5,
  },
  // Routes to gpt-5.5 via Vercel AI Gateway. $5 in / $30 out per
  // developers.openai.com/api/docs/pricing (verified 2026-05-17).
  'gpt-5-thinking': {
    input: 5,
    output: 30,
  },
  'gpt-4o': {
    input: 2.5,
    output: 10,
  },
  'gpt-4o-mini': {
    input: 0.15,
    output: 0.6,
  },
  'text-embedding-3-large': {
    input: 0.13,
    output: 0, // embeddings have no completion side
  },
} as const satisfies Record<string, { input: number; output: number }>;

/**
 * Model ids whose prices in {@link OPENAI_PRICES_USD_PER_MTOK} are still
 * pending an authoritative refresh. Empty after the 2026-05-17 verification;
 * keep the indirection so we can re-add ids without restoring the warning
 * machinery from scratch.
 */
const OPENAI_UNVERIFIED_PRICES: ReadonlySet<string> = new Set();

const OPENAI_UNVERIFIED_WARNED = new Set<string>();

function warnUnverifiedOpenaiPrice(model: string): void {
  if (!OPENAI_UNVERIFIED_PRICES.has(model)) return;
  if (OPENAI_UNVERIFIED_WARNED.has(model)) return;
  OPENAI_UNVERIFIED_WARNED.add(model);
  // Single warning per model id per process — chatter-free in tests, loud
  // enough to notice in CI logs and production stdout.
   
  console.warn(
    `[forge/agents/cost] OpenAI model '${model}' is priced from a placeholder. ` +
      `Verify against openai.com/api/pricing and update OPENAI_PRICES_USD_PER_MTOK.`,
  );
}

/**
 * Token usage block as returned by the OpenAI Chat Completions API.
 */
export interface OpenaiUsage {
  prompt_tokens: number;
  completion_tokens?: number | undefined;
  total_tokens: number;
}

/**
 * Compute USD cost for an OpenAI Chat Completions response.
 *
 * Unknown models return `0` (see {@link anthropicCostUsd} for rationale).
 */
export function openaiCostUsd(usage: OpenaiUsage, model: string): number {
  // See note in `anthropicCostUsd` re: the `unknown` widen.
  const price = (
    OPENAI_PRICES_USD_PER_MTOK as Record<
      string,
      | {
          input: number;
          output: number;
        }
      | undefined
    >
  )[model];
  if (!price) return 0;
  warnUnverifiedOpenaiPrice(model);
  const completion = usage.completion_tokens ?? 0;
  const inputCost = (usage.prompt_tokens / 1_000_000) * price.input;
  const outputCost = (completion / 1_000_000) * price.output;
  return inputCost + outputCost;
}
