/**
 * Pure tests for the synthetic-input generator + output-schema validator.
 *
 * Every JSchemaSpec kind has at least one shape test + one validator round-trip.
 */

import { describe, expect, it } from 'vitest';
import { generateSynthetic, validateAgainstOutputSchema } from '../src/synthetic.js';
import type { JSchemaSpec } from '../src/types.js';

describe('generateSynthetic — scalar kinds', () => {
  it('returns the canonical string for kind=string', () => {
    expect(generateSynthetic({ kind: 'string', describe: 'name' })).toBe('synthetic-test-input');
  });

  it('returns 0 for kind=number', () => {
    expect(generateSynthetic({ kind: 'number', describe: 'count' })).toBe(0);
  });

  it('returns 0 for kind=integer', () => {
    expect(generateSynthetic({ kind: 'integer', describe: 'count' })).toBe(0);
  });

  it('returns false for kind=boolean', () => {
    expect(generateSynthetic({ kind: 'boolean', describe: 'flag' })).toBe(false);
  });

  it('returns a canonical email for kind=email', () => {
    expect(generateSynthetic({ kind: 'email', describe: 'email' })).toBe('test@forge.example');
  });

  it('returns the canonical zero-uuid for kind=uuid', () => {
    expect(generateSynthetic({ kind: 'uuid', describe: 'id' })).toBe(
      '00000000-0000-0000-0000-000000000000',
    );
  });

  it('returns a canonical ISO-8601 datetime for kind=datetime', () => {
    expect(generateSynthetic({ kind: 'datetime', describe: 'when' })).toBe(
      '2026-01-01T00:00:00.000Z',
    );
  });
});

describe('generateSynthetic — nullable + enum', () => {
  it('returns null when nullable=true (wins over kind)', () => {
    expect(generateSynthetic({ kind: 'string', describe: 'maybe', nullable: true })).toBeNull();
    expect(
      generateSynthetic({
        kind: 'object',
        describe: 'maybe-obj',
        nullable: true,
        properties: { x: { kind: 'string', describe: 'x' } },
        required: ['x'],
      }),
    ).toBeNull();
  });

  it('returns the first enum value when enum is present', () => {
    expect(
      generateSynthetic({
        kind: 'string',
        describe: 'severity',
        enum: ['low', 'med', 'high'],
      }),
    ).toBe('low');
  });

  it('falls back to canonical scalar when enum is empty', () => {
    expect(
      generateSynthetic({
        kind: 'string',
        describe: 'x',
        enum: [],
      }),
    ).toBe('synthetic-test-input');
  });
});

describe('generateSynthetic — object', () => {
  it('emits only required properties', () => {
    const spec: JSchemaSpec = {
      kind: 'object',
      describe: 'user',
      properties: {
        id: { kind: 'uuid', describe: 'id' },
        name: { kind: 'string', describe: 'name' },
        nickname: { kind: 'string', describe: 'nickname' },
      },
      required: ['id', 'name'],
    };
    expect(generateSynthetic(spec)).toEqual({
      id: '00000000-0000-0000-0000-000000000000',
      name: 'synthetic-test-input',
    });
  });

  it('returns an empty object when no required properties', () => {
    expect(
      generateSynthetic({
        kind: 'object',
        describe: 'empty',
        properties: { a: { kind: 'string', describe: 'a' } },
      }),
    ).toEqual({});
  });

  it('recurses through nested objects', () => {
    const spec: JSchemaSpec = {
      kind: 'object',
      describe: 'outer',
      properties: {
        inner: {
          kind: 'object',
          describe: 'inner',
          properties: { val: { kind: 'integer', describe: 'val' } },
          required: ['val'],
        },
      },
      required: ['inner'],
    };
    expect(generateSynthetic(spec)).toEqual({ inner: { val: 0 } });
  });
});

describe('generateSynthetic — array', () => {
  it('emits a single-element array with the recursed inner type', () => {
    expect(
      generateSynthetic({
        kind: 'array',
        describe: 'tags',
        items: { kind: 'string', describe: 'tag' },
      }),
    ).toEqual(['synthetic-test-input']);
  });

  it('handles arrays of objects', () => {
    expect(
      generateSynthetic({
        kind: 'array',
        describe: 'rows',
        items: {
          kind: 'object',
          describe: 'row',
          properties: { id: { kind: 'uuid', describe: 'id' } },
          required: ['id'],
        },
      }),
    ).toEqual([{ id: '00000000-0000-0000-0000-000000000000' }]);
  });
});

describe('validateAgainstOutputSchema — happy paths', () => {
  it('accepts a matching string', () => {
    expect(validateAgainstOutputSchema('hi', { kind: 'string', describe: 'x' })).toEqual({
      ok: true,
    });
  });

  it('accepts a matching number, integer, boolean', () => {
    expect(validateAgainstOutputSchema(1.5, { kind: 'number', describe: 'x' })).toEqual({ ok: true });
    expect(validateAgainstOutputSchema(2, { kind: 'integer', describe: 'x' })).toEqual({ ok: true });
    expect(validateAgainstOutputSchema(true, { kind: 'boolean', describe: 'x' })).toEqual({
      ok: true,
    });
  });

  it('accepts a uuid / email / datetime', () => {
    expect(
      validateAgainstOutputSchema('00000000-0000-0000-0000-000000000000', {
        kind: 'uuid',
        describe: 'id',
      }),
    ).toEqual({ ok: true });
    expect(validateAgainstOutputSchema('a@b.co', { kind: 'email', describe: 'e' })).toEqual({
      ok: true,
    });
    expect(
      validateAgainstOutputSchema('2026-01-01T00:00:00.000Z', { kind: 'datetime', describe: 'd' }),
    ).toEqual({ ok: true });
  });

  it('accepts enum values', () => {
    expect(
      validateAgainstOutputSchema('low', {
        kind: 'string',
        describe: 'severity',
        enum: ['low', 'med', 'high'],
      }),
    ).toEqual({ ok: true });
  });

  it('round-trips object + array shapes', () => {
    const spec: JSchemaSpec = {
      kind: 'array',
      describe: 'rows',
      items: {
        kind: 'object',
        describe: 'row',
        properties: { id: { kind: 'uuid', describe: 'id' } },
        required: ['id'],
      },
    };
    const value = generateSynthetic(spec);
    expect(validateAgainstOutputSchema(value, spec)).toEqual({ ok: true });
  });

  it('accepts null when nullable=true', () => {
    expect(
      validateAgainstOutputSchema(null, { kind: 'string', describe: 'maybe', nullable: true }),
    ).toEqual({ ok: true });
  });
});

describe('validateAgainstOutputSchema — failures', () => {
  it('rejects a number where a string is required', () => {
    const result = validateAgainstOutputSchema(123, { kind: 'string', describe: 'x' });
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.error).toMatch(/string/i);
    }
  });

  it('rejects integers that are non-int numbers', () => {
    const result = validateAgainstOutputSchema(1.5, { kind: 'integer', describe: 'x' });
    expect(result.ok).toBe(false);
  });

  it('rejects extra properties on strict objects', () => {
    const spec: JSchemaSpec = {
      kind: 'object',
      describe: 'user',
      properties: { id: { kind: 'uuid', describe: 'id' } },
      required: ['id'],
    };
    const result = validateAgainstOutputSchema(
      { id: '00000000-0000-0000-0000-000000000000', extra: 'no' },
      spec,
    );
    expect(result.ok).toBe(false);
  });

  it('rejects null when not nullable', () => {
    expect(validateAgainstOutputSchema(null, { kind: 'string', describe: 'x' }).ok).toBe(false);
  });

  it('reports a path in the error', () => {
    const spec: JSchemaSpec = {
      kind: 'object',
      describe: 'outer',
      properties: {
        inner: {
          kind: 'object',
          describe: 'inner',
          properties: { v: { kind: 'integer', describe: 'v' } },
          required: ['v'],
        },
      },
      required: ['inner'],
    };
    const result = validateAgainstOutputSchema({ inner: { v: 'bad' } }, spec);
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.error).toContain('inner.v');
    }
  });
});
