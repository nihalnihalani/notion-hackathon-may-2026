import { describe, expect, it } from 'vitest';

import {
  computeSuccessRate,
  formatBytes,
  formatCount,
  formatDuration,
  formatPercent,
  formatRelativeDate,
  formatUsd,
} from '../lib/formatters';

describe('formatUsd', () => {
  it('renders null/undefined as em-dash', () => {
    expect(formatUsd(null)).toBe('—');
    expect(formatUsd(undefined)).toBe('—');
    expect(formatUsd('')).toBe('—');
    expect(formatUsd(Number.NaN)).toBe('—');
  });

  it('renders zero explicitly', () => {
    expect(formatUsd(0)).toBe('$0.00');
  });

  it('uses the <$0.01 sentinel for micro-amounts', () => {
    expect(formatUsd(0.0009)).toBe('<$0.01');
    expect(formatUsd(-0.005)).toBe('<$0.01');
  });

  it('uses 4 decimals under $1, 2 above', () => {
    expect(formatUsd(0.1234)).toBe('$0.1234');
    expect(formatUsd(12.5)).toBe('$12.50');
    expect(formatUsd(1234.567)).toBe('$1,234.57');
  });

  it('accepts numeric strings (Prisma Decimal serialization)', () => {
    expect(formatUsd('2.5')).toBe('$2.50');
  });
});

describe('formatDuration', () => {
  it('returns em-dash for null/undefined/infinite', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(undefined)).toBe('—');
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('—');
  });

  it('renders zero literally', () => {
    expect(formatDuration(0)).toBe('0ms');
  });

  it('uses ms / s / m s / h m units', () => {
    expect(formatDuration(450)).toBe('450ms');
    expect(formatDuration(1500)).toBe('1.50s');
    expect(formatDuration(45_000)).toBe('45.0s');
    expect(formatDuration(125_000)).toBe('2m 5s');
    expect(formatDuration(3_700_000)).toBe('1h 1m');
  });
});

describe('formatRelativeDate', () => {
  const now = new Date('2026-01-01T12:00:00Z');

  it('returns em-dash for missing/bad input', () => {
    expect(formatRelativeDate(null, { now })).toBe('—');
    expect(formatRelativeDate(undefined, { now })).toBe('—');
    expect(formatRelativeDate('not-a-date', { now })).toBe('—');
  });

  it('formats past and future', () => {
    expect(
      formatRelativeDate(new Date('2026-01-01T11:59:30Z'), { now })
    ).toContain('seconds');
    expect(
      formatRelativeDate(new Date('2026-01-02T12:00:00Z'), { now })
    ).toContain('tomorrow');
  });
});

describe('formatBytes', () => {
  it('handles edge cases', () => {
    expect(formatBytes(null)).toBe('—');
    expect(formatBytes(undefined)).toBe('—');
    expect(formatBytes(-1)).toBe('—');
    expect(formatBytes(Number.NaN)).toBe('—');
    expect(formatBytes(0)).toBe('0 B');
  });

  it('scales base-1024', () => {
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    expect(formatBytes(1500, { decimals: 2 })).toBe('1.46 KB');
  });
});

describe('formatCount', () => {
  it('locale-separates thousands', () => {
    expect(formatCount(1234567)).toBe('1,234,567');
    expect(formatCount(null)).toBe('—');
  });
});

describe('formatPercent', () => {
  it('handles ratios + edge cases', () => {
    expect(formatPercent(0.953)).toBe('95.3%');
    expect(formatPercent(null)).toBe('—');
    expect(formatPercent(Number.NaN)).toBe('—');
  });
});

describe('computeSuccessRate', () => {
  it('returns null when no data', () => {
    expect(computeSuccessRate(0, 0)).toBeNull();
    expect(computeSuccessRate(5, 0)).toBeNull();
  });

  it('clamps to 0-1', () => {
    expect(computeSuccessRate(8, 10)).toBe(0.8);
    expect(computeSuccessRate(10, 10)).toBe(1);
    expect(computeSuccessRate(11, 10)).toBe(1);
    expect(computeSuccessRate(-1, 10)).toBe(0);
  });
});
