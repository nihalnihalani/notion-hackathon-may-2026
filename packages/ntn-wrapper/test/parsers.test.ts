/**
 * Unit tests for JSON + stdout parsers. Cover edge cases that bit us in
 * dev: empty stdout, banner-prefixed JSON, embedded strings with braces,
 * arrays at the top level, malformed JSON.
 */

import { describe, expect, it } from 'vitest';

import {
  extractDeployUrl,
  extractWorkerId,
  findJsonSlice,
  looksLikeAuthFailure,
  NtnJsonParseError,
  parseNtnJson,
} from '../src/index';

describe('parseNtnJson', () => {
  it('parses a plain JSON object', () => {
    expect(parseNtnJson<{ a: number }>('{"a":1}', ['workers', 'list'])).toEqual({
      a: 1,
    });
  });

  it('parses a JSON array', () => {
    expect(
      parseNtnJson<number[]>('[1,2,3]', ['workers', 'runs', 'list']),
    ).toEqual([1, 2, 3]);
  });

  it('trims surrounding whitespace', () => {
    expect(parseNtnJson<{ a: number }>('   \n {"a":1}\n  ', ['x'])).toEqual({
      a: 1,
    });
  });

  it('extracts JSON from stdout with a banner preamble', () => {
    const stdout = `Logged in as user@example.com\n{"workers":[]}\n`;
    expect(
      parseNtnJson<{ workers: unknown[] }>(stdout, ['workers', 'list']),
    ).toEqual({ workers: [] });
  });

  it('handles nested objects with strings containing braces', () => {
    const stdout = `{"a":{"b":"contains } brace"}}`;
    expect(parseNtnJson<{ a: { b: string } }>(stdout, ['x'])).toEqual({
      a: { b: 'contains } brace' },
    });
  });

  it('handles strings with escaped quotes', () => {
    const stdout = `{"msg":"she said \\"hi\\""}`;
    expect(parseNtnJson<{ msg: string }>(stdout, ['x'])).toEqual({
      msg: 'she said "hi"',
    });
  });

  it('throws NtnJsonParseError on empty stdout', () => {
    expect(() => parseNtnJson('', ['workers', 'list'])).toThrow(
      NtnJsonParseError,
    );
    expect(() => parseNtnJson('   \n  ', ['x'])).toThrow(NtnJsonParseError);
  });

  it('throws NtnJsonParseError on malformed JSON', () => {
    expect(() => parseNtnJson('{not json}', ['x'])).toThrow(NtnJsonParseError);
  });

  it('throws NtnJsonParseError when no JSON token is found', () => {
    expect(() => parseNtnJson('just a banner line', ['x'])).toThrow(
      NtnJsonParseError,
    );
  });
});

describe('findJsonSlice', () => {
  it('finds an object at the start', () => {
    expect(findJsonSlice('{"a":1}')).toBe('{"a":1}');
  });

  it('finds an array', () => {
    expect(findJsonSlice('[1,2]')).toBe('[1,2]');
  });

  it('finds the first balanced object after a preamble', () => {
    expect(findJsonSlice('banner\n{"a":1} trailing')).toBe('{"a":1}');
  });

  it('returns null when nothing balances', () => {
    expect(findJsonSlice('{ unbalanced')).toBeNull();
  });

  it('returns null when no opener is present', () => {
    expect(findJsonSlice('just text')).toBeNull();
  });
});

describe('extractDeployUrl', () => {
  it('returns the first https URL', () => {
    expect(
      extractDeployUrl('Deployed to https://example.notion.app/agent\nDone.'),
    ).toBe('https://example.notion.app/agent');
  });

  it('stops at whitespace and quotes', () => {
    expect(extractDeployUrl('Deploy: "https://foo.bar/x"')).toBe(
      'https://foo.bar/x',
    );
  });

  it('returns undefined when no URL is present', () => {
    expect(extractDeployUrl('Deploy failed')).toBeUndefined();
  });
});

describe('extractWorkerId', () => {
  it('parses labeled "Worker ID:" line', () => {
    expect(extractWorkerId('Worker ID: wk_abc123\n')).toBe('wk_abc123');
  });

  it('parses key=value style', () => {
    expect(extractWorkerId('worker_id=wk_xyz789 status=ok')).toBe('wk_xyz789');
  });

  it('falls back to a bare wk_ slug', () => {
    expect(extractWorkerId('Deployed wk_deadbeef0 OK')).toBe('wk_deadbeef0');
  });

  it('returns undefined when no id is present', () => {
    expect(extractWorkerId('something unrelated')).toBeUndefined();
  });
});

describe('looksLikeAuthFailure', () => {
  it('matches "not logged in"', () => {
    expect(looksLikeAuthFailure('Error: not logged in')).toBe(true);
  });

  it('matches "please run ntn login"', () => {
    expect(looksLikeAuthFailure('please run `ntn login` first')).toBe(true);
  });

  it('matches "token expired"', () => {
    expect(looksLikeAuthFailure('your token expired')).toBe(true);
  });

  it('matches "401 unauthorized"', () => {
    expect(looksLikeAuthFailure('HTTP 401 Unauthorized')).toBe(true);
  });

  it('does not match unrelated errors', () => {
    expect(looksLikeAuthFailure('worker not found')).toBe(false);
    expect(looksLikeAuthFailure('')).toBe(false);
  });
});
