import { readFile } from 'node:fs/promises';
import { parse } from '@typescript-eslint/parser';
import type { TSESTree } from '@typescript-eslint/utils';
import type { ScanOptions, ScanResult, Violation } from './types.js';
import { ScannerParseError } from './types.js';
import { ALL_RULES, checkPackageJson } from './rules/index.js';

const PARSER_OPTIONS = Object.freeze({
  // Enable JSX so the parser doesn't bail on TSX-shaped source. Worker code
  // shouldn't include JSX but we want a forgiving parse so we can still
  // run security rules over edge-case generated output.
  jsx: true,
  loc: true,
  range: true,
  // Match modern Node 20+ semantics — generated Workers target ES2022.
  ecmaVersion: 2022 as const,
  sourceType: 'module' as const,
  // No type-checking; we only need the AST. `tsc --noEmit` runs separately.
});

/**
 * Parse source with `@typescript-eslint/parser`. Throws `ScannerParseError`
 * on failure. Returns a typed Program node.
 */
function parseSource(source: string): TSESTree.Program {
  try {
    // `parse` returns AST.Program; cast to the TSESTree type used by rules.
    return parse(source, PARSER_OPTIONS) as TSESTree.Program;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'unknown parser error';
    throw new ScannerParseError(`Failed to parse source: ${message}`, error);
  }
}

/**
 * Scan a TypeScript source string.
 *
 * Pure function — no IO, no globals mutated. Caller supplies allowlists.
 */
export function scan(source: string, opts: ScanOptions): ScanResult {
  const started = performance.now();
  const ast = parseSource(source);

  const violations: Violation[] = [];
  const rulesRun: string[] = [];

  for (const rule of ALL_RULES) {
    rulesRun.push(rule.name);
    const result = rule.check(ast, source, opts);
    for (const v of result) violations.push(v);
  }

  const pass = violations.every((v) => v.severity !== 'block');
  return {
    pass,
    violations,
    meta: {
      rulesRun,
      durationMs: performance.now() - started,
    },
  };
}

/**
 * Read a file and scan it. Convenience wrapper for the Inspector's batch path.
 *
 * Caller is responsible for file existence / permissions. A read failure
 * propagates as a normal `fs` error (NOT a ScannerParseError) so the
 * Inspector can distinguish "couldn't find the file" from "file isn't
 * parseable".
 */
export async function scanFile(
  path: string,
  opts: ScanOptions,
): Promise<ScanResult> {
  const source = await readFile(path, 'utf8');
  return scan(source, opts);
}

/**
 * Scan a parsed package.json object. Returns violations only (no AST,
 * nothing to time around — caller aggregates into its own report).
 */
export function scanPackageJson(
  packageJson: object,
  opts: ScanOptions,
): Violation[] {
  return checkPackageJson(packageJson, opts);
}
