import { describe, expect, it } from 'vitest';

import {
  costExceedsBudget,
  sumGenerationCost,
  sumGenerationLatency,
} from '../src/cost-accounting.js';

describe('sumGenerationCost', () => {
  it('returns 0 for an empty array', () => {
    expect(sumGenerationCost([])).toBe(0);
  });

  it('sums a mix of number, null, undefined values', () => {
    const steps = [
      { costUsd: 0.1234 },
      { costUsd: null },
      { costUsd: undefined as unknown as number },
      { costUsd: 0.5 },
    ];
    expect(sumGenerationCost(steps as never)).toBe(0.6234);
  });

  it('coerces Prisma.Decimal-shaped objects via .toNumber()', () => {
    const decimalLike = { toNumber: () => 0.42 };
    const steps = [
      { costUsd: decimalLike as never },
      { costUsd: 0.08 as unknown as never },
    ];
    expect(sumGenerationCost(steps)).toBeCloseTo(0.5, 6);
  });

  it('coerces numeric strings safely', () => {
    const steps = [{ costUsd: '0.25' as unknown as number }, { costUsd: 0.1 }];
    expect(sumGenerationCost(steps as never)).toBeCloseTo(0.35, 6);
  });

  it('treats malformed values as 0 (defensive)', () => {
    const steps = [
      { costUsd: NaN as unknown as number },
      { costUsd: 'not a number' as unknown as number },
      { costUsd: 0.5 },
    ];
    expect(sumGenerationCost(steps as never)).toBe(0.5);
  });

  it('rounds to 4 decimal places (no floating-point artifacts)', () => {
    // 0.1 + 0.2 in IEEE 754 is 0.30000000000000004.
    const steps = [{ costUsd: 0.1 }, { costUsd: 0.2 }];
    expect(sumGenerationCost(steps as never)).toBe(0.3);
  });
});

describe('sumGenerationLatency', () => {
  it('returns 0 for an empty array', () => {
    expect(sumGenerationLatency([])).toBe(0);
  });

  it('sums positive latencies and treats nulls as 0', () => {
    const steps = [
      { latencyMs: 1200 },
      { latencyMs: null },
      { latencyMs: 800 },
    ];
    expect(sumGenerationLatency(steps as never)).toBe(2000);
  });
});

describe('costExceedsBudget', () => {
  it('returns false when budget is 0 (kill switch)', () => {
    expect(costExceedsBudget(100, 0)).toBe(false);
  });

  it('returns false when budget is negative', () => {
    expect(costExceedsBudget(1, -5)).toBe(false);
  });

  it('returns false when budget is Infinity / NaN', () => {
    expect(costExceedsBudget(1, Infinity)).toBe(false);
    expect(costExceedsBudget(1, NaN)).toBe(false);
  });

  it('returns true when current >= budget (>= semantics)', () => {
    expect(costExceedsBudget(1.0, 1.0)).toBe(true);
    expect(costExceedsBudget(1.0001, 1.0)).toBe(true);
  });

  it('returns false when current < budget', () => {
    expect(costExceedsBudget(0.99, 1.0)).toBe(false);
  });

  it('returns false for malformed current (defensive)', () => {
    expect(costExceedsBudget(NaN, 1.0)).toBe(false);
    expect(costExceedsBudget(-1, 1.0)).toBe(false);
  });
});
