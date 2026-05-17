import { describe, expect, it } from 'vitest';
import {
  anthropicCostUsd,
  openaiCostUsd,
  ANTHROPIC_PRICES_USD_PER_MTOK,
  OPENAI_PRICES_USD_PER_MTOK,
} from '../src/cost.js';

describe('anthropicCostUsd', () => {
  it('prices a plain Opus 4.7 call correctly', () => {
    const cost = anthropicCostUsd(
      { input_tokens: 1_000_000, output_tokens: 1_000_000 },
      'claude-opus-4-7',
    );
    expect(cost).toBeCloseTo(
      ANTHROPIC_PRICES_USD_PER_MTOK['claude-opus-4-7'].input +
        ANTHROPIC_PRICES_USD_PER_MTOK['claude-opus-4-7'].output,
      6,
    );
  });

  it('pins the Opus 4.7 numbers — regression guard against the old Sonnet typo', () => {
    // This test exists because commit 5e98e6e shipped Opus 4.7 pointing at
    // Sonnet's $3/$15 schedule, which silently under-billed every Tool Coder
    // generation by ~40%. Do NOT loosen these values without a public
    // pricing change reference.
    expect(ANTHROPIC_PRICES_USD_PER_MTOK['claude-opus-4-7']).toEqual({
      input: 5,
      output: 25,
      cacheWrite: 6.25,
      cacheRead: 0.5,
    });
    expect(ANTHROPIC_PRICES_USD_PER_MTOK['claude-sonnet-4-7']).toEqual({
      input: 3,
      output: 15,
      cacheWrite: 3.75,
      cacheRead: 0.3,
    });
    expect(ANTHROPIC_PRICES_USD_PER_MTOK['claude-sonnet-4-6']).toEqual({
      input: 3,
      output: 15,
      cacheWrite: 3.75,
      cacheRead: 0.3,
    });
  });

  it('computes Opus 4.7 1M-input + 1M-output at $30', () => {
    // 1M input × $5 + 1M output × $25 = $5 + $25 = $30.
    const cost = anthropicCostUsd(
      { input_tokens: 1_000_000, output_tokens: 1_000_000 },
      'claude-opus-4-7',
    );
    expect(cost).toBeCloseTo(30, 6);
  });

  it('adds cache-read + cache-write line items', () => {
    const cost = anthropicCostUsd(
      {
        input_tokens: 100,
        output_tokens: 100,
        cache_read_input_tokens: 1_000_000,
        cache_creation_input_tokens: 1_000_000,
      },
      'claude-opus-4-7',
    );
    const expectedCache =
      ANTHROPIC_PRICES_USD_PER_MTOK['claude-opus-4-7'].cacheRead +
      ANTHROPIC_PRICES_USD_PER_MTOK['claude-opus-4-7'].cacheWrite;
    // The 100 input + 100 output tokens contribute a vanishingly small amount.
    expect(cost).toBeGreaterThanOrEqual(expectedCache);
    expect(cost - expectedCache).toBeLessThan(0.01);
  });

  it('returns 0 for unknown model', () => {
    expect(
      anthropicCostUsd({ input_tokens: 1_000_000, output_tokens: 1_000_000 }, 'made-up-model'),
    ).toBe(0);
  });

  it('handles zero tokens', () => {
    expect(anthropicCostUsd({ input_tokens: 0, output_tokens: 0 }, 'claude-opus-4-7')).toBe(0);
  });

  it('handles missing cache fields as zero', () => {
    const cost = anthropicCostUsd({ input_tokens: 1000, output_tokens: 1000 }, 'claude-opus-4-7');
    expect(cost).toBeGreaterThan(0);
  });
});

describe('openaiCostUsd', () => {
  it('prices the default gpt-5.5 primary model', () => {
    const cost = openaiCostUsd(
      { prompt_tokens: 1_000_000, completion_tokens: 1_000_000, total_tokens: 2_000_000 },
      'gpt-5.5',
    );
    expect(cost).toBeCloseTo(
      OPENAI_PRICES_USD_PER_MTOK['gpt-5.5'].input + OPENAI_PRICES_USD_PER_MTOK['gpt-5.5'].output,
      6,
    );
  });

  it('prices the default gpt-5.4-mini fallback model', () => {
    const cost = openaiCostUsd(
      { prompt_tokens: 1_000_000, completion_tokens: 1_000_000, total_tokens: 2_000_000 },
      'gpt-5.4-mini',
    );
    expect(cost).toBeCloseTo(
      OPENAI_PRICES_USD_PER_MTOK['gpt-5.4-mini'].input +
        OPENAI_PRICES_USD_PER_MTOK['gpt-5.4-mini'].output,
      6,
    );
  });

  it('prices a gpt-5-thinking-mini call', () => {
    const cost = openaiCostUsd(
      { prompt_tokens: 1_000_000, completion_tokens: 1_000_000, total_tokens: 2_000_000 },
      'gpt-5-thinking-mini',
    );
    expect(cost).toBeCloseTo(
      OPENAI_PRICES_USD_PER_MTOK['gpt-5-thinking-mini'].input +
        OPENAI_PRICES_USD_PER_MTOK['gpt-5-thinking-mini'].output,
      6,
    );
  });

  it('returns 0 for unknown model', () => {
    expect(
      openaiCostUsd({ prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 }, 'mystery'),
    ).toBe(0);
  });

  it('handles missing completion_tokens (embeddings)', () => {
    const cost = openaiCostUsd(
      { prompt_tokens: 1_000_000, total_tokens: 1_000_000 },
      'text-embedding-3-large',
    );
    expect(cost).toBeCloseTo(OPENAI_PRICES_USD_PER_MTOK['text-embedding-3-large'].input, 6);
  });
});
