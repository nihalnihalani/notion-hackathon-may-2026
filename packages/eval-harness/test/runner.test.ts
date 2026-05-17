/**
 * Runner / validator tests. We only exercise the dry-run validator here —
 * `runEvals` requires the (heavy) Promptfoo runtime + real API keys, so
 * it's covered by the nightly workflow rather than unit tests.
 */
import { describe, expect, it } from 'vitest';

import { AGENT_NAMES } from '../src/agents.js';
import { validateEvalConfigs } from '../src/runner.js';

describe('validateEvalConfigs', () => {
  it('returns one entry per sub-agent with a positive case count', () => {
    const summary = validateEvalConfigs();
    expect(summary).toHaveLength(AGENT_NAMES.length);
    for (const entry of summary) {
      expect(AGENT_NAMES).toContain(entry.agent);
      expect(entry.cases).toBeGreaterThan(0);
    }
  });

  it('every agent has the expected minimum number of test cases', () => {
    // Mirrors evals/baselines.json totals — when you add cases, bump both.
    const minCases: Record<string, number> = {
      'schema-smith': 10,
      'tool-coder': 10,
      'inspector': 10,
      'shipper': 10,
    };
    const summary = validateEvalConfigs();
    for (const entry of summary) {
      expect(entry.cases).toBeGreaterThanOrEqual(minCases[entry.agent] ?? 1);
    }
  });
});
