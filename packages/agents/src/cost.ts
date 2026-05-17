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
 */
export const ANTHROPIC_PRICES_USD_PER_MTOK = {
  'claude-opus-4-7': {
    input: 3,
    output: 15,
    cacheWrite: 3.75,
    cacheRead: 0.3,
  },
  // Sonnet 4.5 — used if the gateway routes there for cost.
  'claude-sonnet-4-5': {
    input: 3,
    output: 15,
    cacheWrite: 3.75,
    cacheRead: 0.3,
  },
  // Haiku — cheaper fallback option.
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
 * Conservative estimates. GPT-5 pricing is provisional pending GA.
 */
export const OPENAI_PRICES_USD_PER_MTOK = {
  'gpt-5': {
    input: 5,
    output: 15,
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
  const completion = usage.completion_tokens ?? 0;
  const inputCost = (usage.prompt_tokens / 1_000_000) * price.input;
  const outputCost = (completion / 1_000_000) * price.output;
  return inputCost + outputCost;
}
