/**
 * Unit tests for `ts-validation`.
 *
 * Both helpers are pure — no IO, no globals, no model calls.
 */

import { describe, expect, it } from 'vitest';
import { extractTsCodeFromResponse, parseGeneratedTs } from '../src/ts-validation.js';

describe('parseGeneratedTs', () => {
  it('accepts simple valid TS', () => {
    const out = parseGeneratedTs(`export const x: number = 1;`);
    expect(out.ok).toBe(true);
  });

  it('rejects an obvious syntax error', () => {
    const out = parseGeneratedTs(`export const = `);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.errors[0]).toMatch(/.+/u);
  });

  it('accepts ESM imports + async functions', () => {
    const src = `
      import { foo } from 'bar';
      export async function run(): Promise<void> {
        await foo();
      }
    `;
    expect(parseGeneratedTs(src).ok).toBe(true);
  });

  it('accepts type-only constructs', () => {
    const src = `
      type Result<T> = { ok: true; value: T } | { ok: false; error: string };
      export const r: Result<number> = { ok: true, value: 1 };
    `;
    expect(parseGeneratedTs(src).ok).toBe(true);
  });
});

describe('extractTsCodeFromResponse', () => {
  it('extracts a ```typescript block', () => {
    const text = "Here you go:\n```typescript\nconst x = 1;\n```\nThanks!";
    expect(extractTsCodeFromResponse(text)).toBe('const x = 1;');
  });

  it('extracts a ```ts block', () => {
    const text = "```ts\nconst x = 2;\n```";
    expect(extractTsCodeFromResponse(text)).toBe('const x = 2;');
  });

  it('extracts a bare fenced block when it parses standalone', () => {
    const text = "```\nconst y: number = 3;\n```";
    expect(extractTsCodeFromResponse(text)).toBe('const y: number = 3;');
  });

  it('rejects a bare fenced block that is not TS', () => {
    const text = "```\nthis is not valid javascript at all !@#$%\n```";
    expect(extractTsCodeFromResponse(text)).toBeNull();
  });

  it('accepts raw TS when it parses', () => {
    const text = "const z = 7;";
    expect(extractTsCodeFromResponse(text)).toBe('const z = 7;');
  });

  it('returns null on empty input', () => {
    expect(extractTsCodeFromResponse('')).toBeNull();
  });

  it('returns null on prose-only input', () => {
    expect(extractTsCodeFromResponse('I will write the code soon')).toBeNull();
  });

  it('prefers the ```typescript block when both fence styles are present', () => {
    const text = '```\nnoise\n```\n```typescript\nconst real = 1;\n```';
    expect(extractTsCodeFromResponse(text)).toBe('const real = 1;');
  });
});
