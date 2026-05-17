import { describe, expect, it } from 'vitest';
import { addComment, listComments } from '../src/comments.js';
import { asBlockId } from '../src/types.js';
import { mockFetch } from './helpers.js';

describe('comments', () => {
  it('addComment POSTs /v1/comments with page parent', async () => {
    const { fetch, calls } = mockFetch({
      status: 200,
      body: { object: 'comment', id: 'c1', discussion_id: 'd1' },
    });
    await addComment(
      { token: 'k', fetch },
      {
        parent: { page_id: 'p1' },
        rich_text: [{ type: 'text', text: { content: 'first!', link: null } }],
      },
    );
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toMatch(/\/v1\/comments$/);
    const sent = JSON.parse(calls[0]!.body!);
    expect(sent.parent.page_id).toBe('p1');
  });

  it('addComment POSTs /v1/comments with discussion_id', async () => {
    const { fetch, calls } = mockFetch({
      status: 200,
      body: { object: 'comment', id: 'c2', discussion_id: 'd2' },
    });
    await addComment(
      { token: 'k', fetch },
      {
        discussion_id: 'd2',
        rich_text: [{ type: 'text', text: { content: 'reply', link: null } }],
      },
    );
    const sent = JSON.parse(calls[0]!.body!);
    expect(sent.discussion_id).toBe('d2');
    expect(sent.parent).toBeUndefined();
  });

  it('listComments GETs /v1/comments?block_id=...', async () => {
    const { fetch, calls } = mockFetch({
      status: 200,
      body: { object: 'list', results: [], next_cursor: null, has_more: false },
    });
    await listComments({ token: 'k', fetch }, asBlockId('b1'));
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.url).toContain('block_id=b1');
  });
});
