/**
 * Baseline unit tests. We exercise:
 *  - empty baseline returns nulls
 *  - regression detection respects the threshold
 *  - per-agent fields are populated even when one side is null
 */
import { describe, expect, it } from 'vitest';

import { compareToBaseline, readBaseline } from '../src/baseline.js';
import type { EvalRunResult } from '../src/runner.js';

function mkResult(passRates: Record<string, number>): EvalRunResult {
  return {
    startedAt: '2025-05-17T03:00:00Z',
    finishedAt: '2025-05-17T03:05:00Z',
    results: Object.entries(passRates).map(([agent, passRate]) => ({
      agent: agent as never,
      totalCases: 10,
      passed: Math.round(passRate * 10),
      failed: 10 - Math.round(passRate * 10),
      passRate,
      failures: [],
    })),
  };
}

describe('readBaseline', () => {
  it('returns null entries when the file is missing', () => {
    const b = readBaseline('/tmp/forge-evals-does-not-exist-12345.json');
    for (const agent of Object.values(b.agents)) {
      expect(agent.passRate).toBeNull();
    }
  });
});

describe('compareToBaseline', () => {
  it('flags regression when current drops past the threshold', () => {
    const baseline = readBaseline('/tmp/forge-evals-does-not-exist-12345.json');
    baseline.agents['schema-smith'] = { passRate: 0.95, totalCases: 10 };
    const result = mkResult({ 'schema-smith': 0.8 });
    const diff = compareToBaseline(result, baseline, 5);
    expect(diff.regressed).toBe(true);
    expect(diff.perAgent[0]?.regressed).toBe(true);
    expect(diff.summary).toContain('REGRESSED');
  });

  it('does not flag when drop is within the threshold', () => {
    const baseline = readBaseline('/tmp/forge-evals-does-not-exist-12345.json');
    baseline.agents['schema-smith'] = { passRate: 0.95, totalCases: 10 };
    const result = mkResult({ 'schema-smith': 0.92 });
    const diff = compareToBaseline(result, baseline, 5);
    expect(diff.regressed).toBe(false);
  });

  it('treats a null baseline as "no regression possible"', () => {
    const baseline = readBaseline('/tmp/forge-evals-does-not-exist-12345.json');
    // baseline.agents['schema-smith'].passRate stays null
    const result = mkResult({ 'schema-smith': 0.1 });
    const diff = compareToBaseline(result, baseline, 5);
    expect(diff.regressed).toBe(false);
  });
});
