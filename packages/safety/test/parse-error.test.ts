import { describe, it, expect } from 'vitest';
import { scan } from '../src/scanner.js';
import { ScannerParseError } from '../src/types.js';
import { TEST_OPTS } from './helpers.js';

describe('scanner — parse error handling', () => {
  it('throws ScannerParseError on truncated source', () => {
    const src = `
      function foo( {
    `;
    expect(() => scan(src, TEST_OPTS)).toThrow(ScannerParseError);
  });

  it('throws ScannerParseError on stray punctuation', () => {
    const src = `const x = @@@@;`;
    expect(() => scan(src, TEST_OPTS)).toThrow(ScannerParseError);
  });

  it('preserves underlying parser message', () => {
    try {
      scan('const = ;', TEST_OPTS);
      throw new Error('expected ScannerParseError');
    } catch (err) {
      expect(err).toBeInstanceOf(ScannerParseError);
      expect((err as ScannerParseError).message).toMatch(/Failed to parse source/);
      expect((err as ScannerParseError).cause).toBeDefined();
    }
  });

  it('does NOT throw on syntactically-valid TS with type errors (those are tsc problems)', () => {
    // `tsc --noEmit` catches type errors. We accept any parseable TS.
    const src = `const x: number = 'string-not-number';`;
    expect(() => scan(src, TEST_OPTS)).not.toThrow();
  });

  it('does NOT throw on empty source', () => {
    expect(() => scan('', TEST_OPTS)).not.toThrow();
    const r = scan('', TEST_OPTS);
    expect(r.pass).toBe(true);
    expect(r.violations).toHaveLength(0);
  });
});
