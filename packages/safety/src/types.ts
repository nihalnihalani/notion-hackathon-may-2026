import type { TSESTree } from '@typescript-eslint/utils';

/**
 * Violation severity.
 * - `block`: the scanner MUST refuse the generated code; pipeline halts.
 * - `warn`: surfaced in the build log but does not block deploy.
 */
export type Severity = 'block' | 'warn';

/**
 * A single rule violation found in a source file.
 *
 * `line` / `column` are 1-indexed (matching `tsc` / editor convention).
 * `snippet` is the offending source slice, trimmed to one line for log readability.
 */
export interface Violation {
  rule: string;
  severity: Severity;
  message: string;
  line: number;
  column: number;
  snippet: string;
}

/**
 * Scanner configuration.
 *
 * The caller (Inspector agent) MUST supply both allowlists; we refuse to
 * provide defaults here because the effective allowlist depends on which
 * OAuth providers the user has connected.
 *
 * `networkAllowlist` — hosts (no protocol) that fetch / http.request may reach.
 *   Subdomain matching is exact; callers should pass `'api.notion.com'`
 *   not `'notion.com'`.
 * `depAllowlist` — package names allowed in `dependencies` / `devDependencies`.
 */
export interface ScanOptions {
  networkAllowlist: string[];
  depAllowlist: string[];
}

/**
 * Result of scanning a source file.
 *
 * `pass` is true iff no `block`-severity violation was found.
 * Callers should still surface `warn`-severity violations in the build log.
 */
export interface ScanResult {
  pass: boolean;
  violations: Violation[];
  meta: {
    rulesRun: string[];
    durationMs: number;
  };
}

/**
 * A single AST rule.
 *
 * Each rule is a pure function — no IO, no global state, no caching of
 * mutable values. Rules receive the parsed Program node + the original
 * source string (used for snippet extraction).
 */
export interface Rule {
  name: string;
  check: (
    ast: TSESTree.Program,
    source: string,
    opts: ScanOptions,
  ) => Violation[];
}

/**
 * Thrown when the scanner cannot even parse the supplied source.
 *
 * Inspector treats this as a `parse`-stage failure (same as a `tsc` syntax
 * error) and feeds the message back to Tool Coder for a retry.
 */
export class ScannerParseError extends Error {
  public override readonly cause: unknown;
  public override readonly name = 'ScannerParseError';

  constructor(message: string, cause?: unknown) {
    super(message);
    this.cause = cause;
  }
}
