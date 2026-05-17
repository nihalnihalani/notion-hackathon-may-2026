import { describe, expect, it } from 'vitest';
import { renderJSchemaAsTS, validateJSchema } from '../src/schema/j-spec.js';
import type { JSchemaSpec } from '../src/types.js';

describe('validateJSchema', () => {
  it('accepts a simple scalar', () => {
    const r = validateJSchema({ kind: 'string', describe: 'A name' });
    expect(r.ok).toBe(true);
  });

  it('accepts every scalar kind', () => {
    for (const kind of [
      'string',
      'number',
      'integer',
      'boolean',
      'email',
      'uuid',
      'datetime',
    ] as const) {
      const r = validateJSchema({ kind, describe: 'd' });
      expect(r.ok).toBe(true);
    }
  });

  it('accepts an object with nested array of enum scalars', () => {
    const spec: JSchemaSpec = {
      kind: 'object',
      describe: 'Issue',
      properties: {
        id: { kind: 'uuid', describe: 'Issue id' },
        labels: {
          kind: 'array',
          describe: 'Labels',
          items: {
            kind: 'string',
            describe: 'Label',
            enum: ['bug', 'feature', 'chore'],
          },
        },
      },
      required: ['id'],
    };
    const r = validateJSchema(spec);
    expect(r.ok).toBe(true);
  });

  it('rejects an empty describe', () => {
    const r = validateJSchema({ kind: 'string', describe: '' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('describe');
  });

  it('rejects an unknown kind', () => {
    const r = validateJSchema({ kind: 'magical', describe: 'oops' });
    expect(r.ok).toBe(false);
  });

  it('rejects an object whose property has a bad shape', () => {
    const r = validateJSchema({
      kind: 'object',
      describe: 'thing',
      properties: { x: { kind: 'string' } },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/properties\.x/);
  });

  it('accepts nullable + enum scalar', () => {
    const r = validateJSchema({
      kind: 'string',
      describe: 'Status',
      nullable: true,
      enum: ['open', 'closed'],
    });
    expect(r.ok).toBe(true);
  });

  it('accepts deeply nested objects', () => {
    const spec: JSchemaSpec = {
      kind: 'object',
      describe: 'outer',
      properties: {
        inner: {
          kind: 'object',
          describe: 'inner',
          properties: {
            deeper: {
              kind: 'array',
              describe: 'list',
              items: {
                kind: 'object',
                describe: 'row',
                properties: {
                  v: { kind: 'integer', describe: 'value' },
                },
              },
            },
          },
        },
      },
    };
    expect(validateJSchema(spec).ok).toBe(true);
  });
});

describe('renderJSchemaAsTS', () => {
  it('renders a scalar with describe', () => {
    expect(renderJSchemaAsTS({ kind: 'string', describe: 'Hello' })).toBe(
      'j.string().describe("Hello")',
    );
  });

  it('renders enum + nullable in canonical order', () => {
    expect(
      renderJSchemaAsTS({
        kind: 'string',
        describe: 'Status',
        enum: ['open', 'closed'],
        nullable: true,
      }),
    ).toBe('j.string().enum(["open", "closed"]).nullable().describe("Status")');
  });

  it('renders email/uuid/datetime as their own builder methods', () => {
    expect(renderJSchemaAsTS({ kind: 'email', describe: 'e' })).toBe('j.email().describe("e")');
    expect(renderJSchemaAsTS({ kind: 'uuid', describe: 'u' })).toBe('j.uuid().describe("u")');
    expect(renderJSchemaAsTS({ kind: 'datetime', describe: 'd' })).toBe(
      'j.datetime().describe("d")',
    );
  });

  it('renders an object with required + bare-identifier keys', () => {
    const out = renderJSchemaAsTS({
      kind: 'object',
      describe: 'Row',
      properties: {
        id: { kind: 'uuid', describe: 'id' },
        title: { kind: 'string', describe: 'title' },
      },
      required: ['id'],
    });
    expect(out).toBe(
      'j.object({ id: j.uuid().describe("id"), title: j.string().describe("title") }).required(["id"]).describe("Row")',
    );
  });

  it('quotes non-identifier keys', () => {
    const out = renderJSchemaAsTS({
      kind: 'object',
      describe: 'Row',
      properties: {
        'weird-key': { kind: 'string', describe: 'x' },
      },
    });
    expect(out).toContain('"weird-key": j.string()');
  });

  it('escapes describe text via JSON.stringify', () => {
    const out = renderJSchemaAsTS({
      kind: 'string',
      describe: 'has "quotes" and \\ slashes',
    });
    expect(out).toBe('j.string().describe("has \\"quotes\\" and \\\\ slashes")');
  });

  it('renders an array of objects', () => {
    const out = renderJSchemaAsTS({
      kind: 'array',
      describe: 'Issues',
      items: {
        kind: 'object',
        describe: 'Issue',
        properties: { id: { kind: 'uuid', describe: 'id' } },
        required: ['id'],
      },
    });
    expect(out).toBe(
      'j.array(j.object({ id: j.uuid().describe("id") }).required(["id"]).describe("Issue")).describe("Issues")',
    );
  });

  it('emits empty-properties object cleanly', () => {
    const out = renderJSchemaAsTS({
      kind: 'object',
      describe: 'empty',
      properties: {},
    });
    expect(out).toBe('j.object({}).describe("empty")');
  });
});
