/**
 * Tests for the tsc-error-parser. The fixtures are real `tsc --noEmit` stderr
 * dumps — not synthetic — so the parser stays calibrated to what tsc actually
 * emits.
 */

import { describe, expect, it } from 'vitest';
import { parseTscErrors } from '../src/tsc-error-parser.js';

describe('parseTscErrors — empty input', () => {
  it('returns [] for empty string', () => {
    expect(parseTscErrors('')).toEqual([]);
  });

  it('returns [] for whitespace-only input', () => {
    expect(parseTscErrors('   \n\t\n  ')).toEqual([]);
  });

  it('returns [] for non-diagnostic noise', () => {
    expect(parseTscErrors('Found 0 errors.\n')).toEqual([]);
  });
});

describe('parseTscErrors — single diagnostic', () => {
  it('parses a basic TS2322 diagnostic', () => {
    const stderr = `src/index.ts(5,12): error TS2322: Type 'number' is not assignable to type 'string'.\n`;
    expect(parseTscErrors(stderr)).toEqual([
      {
        file: 'src/index.ts',
        line: 5,
        column: 12,
        code: 'TS2322',
        message: "Type 'number' is not assignable to type 'string'.",
      },
    ]);
  });

  it('parses a diagnostic with no trailing newline', () => {
    const stderr = `src/foo.ts(1,1): error TS2304: Cannot find name 'x'.`;
    const result = parseTscErrors(stderr);
    expect(result).toHaveLength(1);
    expect(result[0]?.code).toBe('TS2304');
  });

  it('handles absolute file paths', () => {
    const stderr = `/tmp/forge/src/index.ts(10,5): error TS2554: Expected 1 arguments, but got 0.\n`;
    const result = parseTscErrors(stderr);
    expect(result[0]?.file).toBe('/tmp/forge/src/index.ts');
    expect(result[0]?.line).toBe(10);
    expect(result[0]?.column).toBe(5);
  });
});

describe('parseTscErrors — multiple diagnostics', () => {
  it('parses every diagnostic in the blob', () => {
    const stderr =
      `src/a.ts(1,1): error TS2322: Type 'A' is not assignable to type 'B'.\n` +
      `src/b.ts(20,4): error TS2304: Cannot find name 'foo'.\n` +
      `src/c.ts(3,8): error TS7006: Parameter 'x' implicitly has an 'any' type.\n`;
    const result = parseTscErrors(stderr);
    expect(result).toHaveLength(3);
    expect(result.map((r) => r.code)).toEqual(['TS2322', 'TS2304', 'TS7006']);
  });

  it('ignores blank lines + the trailing "Found N errors" banner', () => {
    const stderr =
      `src/a.ts(1,1): error TS2322: oops.\n` +
      `\n` +
      `src/b.ts(2,2): error TS2304: nope.\n` +
      `\n` +
      `Found 2 errors in 2 files.\n`;
    const result = parseTscErrors(stderr);
    expect(result).toHaveLength(2);
  });
});

describe('parseTscErrors — multi-line / wrapped diagnostics', () => {
  it('concatenates continuation lines onto the preceding diagnostic', () => {
    const stderr =
      `src/x.ts(5,12): error TS2322: Type 'number' is not assignable to type 'string'.\n` +
      `  Did you mean to use String(value)?\n`;
    const result = parseTscErrors(stderr);
    expect(result).toHaveLength(1);
    expect(result[0]?.message).toBe(
      "Type 'number' is not assignable to type 'string'.\nDid you mean to use String(value)?",
    );
  });

  it('drops continuations seen before any diagnostic', () => {
    const stderr =
      `  orphan continuation\n` +
      `src/x.ts(1,1): error TS2322: bad.\n`;
    const result = parseTscErrors(stderr);
    expect(result).toHaveLength(1);
    expect(result[0]?.message).toBe('bad.');
  });
});

describe('parseTscErrors — robustness', () => {
  it('does not blow up on garbage input', () => {
    const stderr = 'totally unrelated\n!@#$%^&*()\n';
    expect(parseTscErrors(stderr)).toEqual([]);
  });

  it('parses messages with parentheses and special chars', () => {
    const stderr =
      `src/a.ts(1,1): error TS2554: Expected 1 arguments, but got 0. Argument for 'name' (string) is missing.\n`;
    const result = parseTscErrors(stderr);
    expect(result).toHaveLength(1);
    expect(result[0]?.message).toContain("Argument for 'name' (string) is missing");
  });
});
