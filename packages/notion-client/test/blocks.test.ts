import { describe, expect, it } from 'vitest';
import {
  appendBlocks,
  deleteBlock,
  getBlock,
  getBlockChildren,
  updateBlock,
} from '../src/blocks.js';
import { asBlockId } from '../src/types.js';
import { mockFetch } from './helpers.js';

const ID = asBlockId('b1');

describe('blocks', () => {
  it('appendBlocks PATCHes /v1/blocks/{id}/children', async () => {
    const { fetch, calls } = mockFetch({
      status: 200,
      body: { object: 'list', results: [], next_cursor: null, has_more: false },
    });
    await appendBlocks({ token: 'k', fetch }, ID, [
      {
        object: 'block',
        type: 'paragraph',
        paragraph: { rich_text: [{ type: 'text', text: { content: 'hi', link: null } }] },
      } as unknown as Parameters<typeof appendBlocks>[2][number],
    ]);
    expect(calls[0]!.method).toBe('PATCH');
    expect(calls[0]!.url).toMatch(/\/v1\/blocks\/b1\/children$/);
    expect(calls[0]!.headers['authorization']).toBe('Bearer k');
  });

  it('getBlockChildren GETs /v1/blocks/{id}/children', async () => {
    const { fetch, calls } = mockFetch({
      status: 200,
      body: { object: 'list', results: [], next_cursor: null, has_more: false },
    });
    await getBlockChildren({ token: 'k', fetch }, ID, {
      page_size: 50,
      start_cursor: 'c0',
    });
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.url).toMatch(/\/v1\/blocks\/b1\/children\?/);
    expect(calls[0]!.url).toContain('page_size=50');
    expect(calls[0]!.url).toContain('start_cursor=c0');
  });

  it('getBlock GETs /v1/blocks/{id}', async () => {
    const { fetch, calls } = mockFetch({
      status: 200,
      body: { object: 'block', id: 'b1', type: 'paragraph' },
    });
    await getBlock({ token: 'k', fetch }, ID);
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.url).toMatch(/\/v1\/blocks\/b1$/);
  });

  it('updateBlock PATCHes /v1/blocks/{id}', async () => {
    const { fetch, calls } = mockFetch({
      status: 200,
      body: { object: 'block', id: 'b1' },
    });
    await updateBlock({ token: 'k', fetch }, ID, {
      paragraph: { rich_text: [{ type: 'text', text: { content: 'x', link: null } }] },
    });
    expect(calls[0]!.method).toBe('PATCH');
    expect(calls[0]!.url).toMatch(/\/v1\/blocks\/b1$/);
  });

  it('deleteBlock DELETEs /v1/blocks/{id}', async () => {
    const { fetch, calls } = mockFetch({
      status: 200,
      body: { object: 'block', id: 'b1', in_trash: true },
    });
    await deleteBlock({ token: 'k', fetch }, ID);
    expect(calls[0]!.method).toBe('DELETE');
    expect(calls[0]!.url).toMatch(/\/v1\/blocks\/b1$/);
  });
});
