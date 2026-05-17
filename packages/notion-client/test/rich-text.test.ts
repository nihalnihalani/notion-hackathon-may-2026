/**
 * Pure helper tests for rich-text.ts. No fetch, no IO.
 */

import { describe, expect, it } from 'vitest';
import {
  bulletedListItem,
  callout,
  code,
  divider,
  heading,
  numberedListItem,
  paragraph,
  plainText,
  toDo,
  toggle,
} from '../src/rich-text.js';

describe('plainText', () => {
  it('wraps a string in a single text run with null link', () => {
    expect(plainText('hello')).toEqual([
      { type: 'text', text: { content: 'hello', link: null } },
    ]);
  });
});

describe('paragraph', () => {
  it('builds a paragraph block', () => {
    const b = paragraph('hi');
    expect(b.type).toBe('paragraph');
    if (b.type !== 'paragraph') throw new Error('unreachable');
    expect(b.paragraph.rich_text[0]!.text.content).toBe('hi');
    expect(b.paragraph.color).toBeUndefined();
  });

  it('applies a color when provided', () => {
    const b = paragraph('hi', 'red');
    if (b.type !== 'paragraph') throw new Error('unreachable');
    expect(b.paragraph.color).toBe('red');
  });
});

describe('heading', () => {
  it.each([1, 2, 3] as const)('builds heading_%d', (lvl) => {
    const b = heading(lvl, 'X');
    expect(b.type).toBe(`heading_${lvl}`);
  });
});

describe('code', () => {
  it('embeds language', () => {
    const b = code("console.log('hi')", 'typescript');
    if (b.type !== 'code') throw new Error('unreachable');
    expect(b.code.language).toBe('typescript');
    expect(b.code.rich_text[0]!.text.content).toBe("console.log('hi')");
  });
});

describe('callout', () => {
  it('builds a callout with optional emoji + color', () => {
    const b = callout('important!', '🔔', 'yellow_background');
    if (b.type !== 'callout') throw new Error('unreachable');
    expect(b.callout.icon).toEqual({ type: 'emoji', emoji: '🔔' });
    expect(b.callout.color).toBe('yellow_background');
  });

  it('omits icon/color when not provided', () => {
    const b = callout('important!');
    if (b.type !== 'callout') throw new Error('unreachable');
    expect(b.callout.icon).toBeUndefined();
    expect(b.callout.color).toBeUndefined();
  });
});

describe('divider', () => {
  it('builds a divider', () => {
    const b = divider();
    expect(b.type).toBe('divider');
  });
});

describe('list items + to_do + toggle', () => {
  it('builds bulleted/numbered list items', () => {
    expect(bulletedListItem('a').type).toBe('bulleted_list_item');
    expect(numberedListItem('b').type).toBe('numbered_list_item');
  });

  it('builds to_do with `checked` flag', () => {
    const b = toDo('done', true);
    if (b.type !== 'to_do') throw new Error('unreachable');
    expect(b.to_do.checked).toBe(true);
  });

  it('to_do defaults checked to false', () => {
    const b = toDo('open');
    if (b.type !== 'to_do') throw new Error('unreachable');
    expect(b.to_do.checked).toBe(false);
  });

  it('builds a toggle', () => {
    expect(toggle('show more').type).toBe('toggle');
  });
});
