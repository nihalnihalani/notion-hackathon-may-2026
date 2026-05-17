/**
 * Pure presentation formatters for the dashboard.
 *
 * Rules:
 *   - No IO, no React imports. These run in both Server and Client components.
 *   - Locale-aware via `Intl.*` (caller may pin `en-US` via the second arg
 *     to keep deterministic output in screenshots / tests).
 *   - Inputs are intentionally permissive — `number | string | Decimal | null
 *     | undefined` — because Prisma's Decimal columns serialize as strings
 *     across the server↔client boundary, and we want a single call site to
 *     handle "no value" instead of forcing every component to coalesce.
 */

const DEFAULT_LOCALE = 'en-US';

// ─────────────────────────────────────────────────────────────────────────────
// Money
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Format a USD amount.
 *
 * - Values below $0.01 are rendered as "<$0.01" so micro-cost generations
 *   don't show "$0.00", which incorrectly reads as "free".
 * - Returns "—" for null/undefined so empty cells in tables don't shift the
 *   eye toward a meaningful zero.
 */
export function formatUsd(
  value: number | string | null | undefined,
  locale: string = DEFAULT_LOCALE,
): string {
  if (value === null || value === undefined || value === '') return '—';
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(n)) return '—';

  if (n === 0) return '$0.00';
  if (Math.abs(n) > 0 && Math.abs(n) < 0.01) return '<$0.01';

  // Use 4 decimals for amounts < $1 (where 2-dp loses signal) and 2 elsewhere.
  const digits = Math.abs(n) < 1 ? 4 : 2;
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(n);
}

// ─────────────────────────────────────────────────────────────────────────────
// Durations
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Format a millisecond duration as a short human string ("1.2s", "350ms",
 * "2m 14s"). Returns "—" for null/undefined and "0ms" for exact zero.
 *
 * Compact by design — used in dense tables where vertical alignment matters.
 */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (!Number.isFinite(ms)) return '—';
  if (ms === 0) return '0ms';
  const abs = Math.abs(ms);

  if (abs < 1000) return `${Math.round(ms)}ms`;
  if (abs < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;

  const totalSec = Math.round(ms / 1000);
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;

  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  return `${hours}h ${remMin}m`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Relative dates
// ─────────────────────────────────────────────────────────────────────────────

const RELATIVE_DIVISIONS: readonly {
  amount: number;
  unit: Intl.RelativeTimeFormatUnit;
}[] = [
  { amount: 60, unit: 'second' },
  { amount: 60, unit: 'minute' },
  { amount: 24, unit: 'hour' },
  { amount: 7, unit: 'day' },
  { amount: 4.345_24, unit: 'week' },
  { amount: 12, unit: 'month' },
  { amount: Number.POSITIVE_INFINITY, unit: 'year' },
];

/**
 * Format a date as a relative-time string ("2 minutes ago", "in 3 days").
 *
 * Accepts Date | string | number for ergonomics (Prisma DateTime columns
 * sometimes arrive as ISO strings depending on how they cross the wire).
 *
 * Returns "—" for null/undefined or unparseable input.
 */
export function formatRelativeDate(
  input: Date | string | number | null | undefined,
  options?: { now?: Date; locale?: string },
): string {
  if (input === null || input === undefined) return '—';
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return '—';

  const now = options?.now ?? new Date();
  const locale = options?.locale ?? DEFAULT_LOCALE;
  const fmt = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });

  let duration = (d.getTime() - now.getTime()) / 1000; // seconds

  for (const division of RELATIVE_DIVISIONS) {
    if (Math.abs(duration) < division.amount) {
      return fmt.format(Math.round(duration), division.unit);
    }
    duration /= division.amount;
  }
  return fmt.format(Math.round(duration), 'year');
}

/**
 * Absolute date/time, suitable for tooltips on a relative date.
 */
export function formatAbsoluteDate(
  input: Date | string | number | null | undefined,
  locale: string = DEFAULT_LOCALE,
): string {
  if (input === null || input === undefined) return '—';
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return '—';

  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(d);
}

// ─────────────────────────────────────────────────────────────────────────────
// Bytes
// ─────────────────────────────────────────────────────────────────────────────

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const;

/**
 * Format a byte count as a short human-readable string ("12.4 KB").
 *
 * Uses base-1024 to match how engineers think about file sizes; if you need
 * SI base-1000 (MB-as-megabytes-of-disk-marketing) wrap and divide upstream.
 */
export function formatBytes(
  bytes: number | null | undefined,
  options?: { decimals?: number },
): string {
  if (bytes === null || bytes === undefined) return '—';
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes === 0) return '0 B';

  const decimals = options?.decimals ?? 1;
  const k = 1024;
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), BYTE_UNITS.length - 1);
  const value = bytes / Math.pow(k, i);
  const unit = BYTE_UNITS[i] ?? 'B';
  return `${value.toFixed(decimals)} ${unit}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Counts / percentages
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Format an integer with locale-aware separators ("1,234"). Returns "—" for
 * null/undefined.
 */
export function formatCount(n: number | null | undefined, locale: string = DEFAULT_LOCALE): string {
  if (n === null || n === undefined) return '—';
  if (!Number.isFinite(n)) return '—';
  return new Intl.NumberFormat(locale).format(n);
}

/**
 * Format a 0-1 ratio as a percentage ("98.2%"). Returns "—" for null/undefined.
 *
 * Caller is responsible for division-by-zero handling (pass `null` to render
 * a dash rather than "NaN%").
 */
export function formatPercent(ratio: number | null | undefined, decimals = 1): string {
  if (ratio === null || ratio === undefined) return '—';
  if (!Number.isFinite(ratio)) return '—';
  return `${(ratio * 100).toFixed(decimals)}%`;
}

/**
 * Convert a Generation's status-counter pair to a success rate.
 * Returns `null` (not 0) when there are no generations so the caller can
 * render a dash; rendering "0%" would falsely suggest 100% failure.
 */
export function computeSuccessRate(succeeded: number, total: number): number | null {
  if (!Number.isFinite(succeeded) || !Number.isFinite(total)) return null;
  if (total <= 0) return null;
  return Math.max(0, Math.min(1, succeeded / total));
}
