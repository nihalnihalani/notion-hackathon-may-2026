import { describe, expect, it } from 'vitest';
import {
  createDatabase,
  getDatabase,
  queryDatabase,
  updateDatabase,
} from '../src/databases.js';
import { asDatabaseId } from '../src/types.js';
import { mockFetch } from './helpers.js';

const ID = asDatabaseId('d1');

describe('databases', () => {
  it('createDatabase POSTs /v1/databases', async () => {
    const { fetch, calls } = mockFetch({
      status: 200,
      body: { object: 'database', id: 'd1' },
    });
    await createDatabase(
      { token: 'k', fetch },
      {
        parent: { type: 'page_id', page_id: 'p1' },
        title: [{ type: 'text', text: { content: 'Forge Requests', link: null } }],
        properties: { Name: { title: {} } },
      },
    );
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toMatch(/\/v1\/databases$/);
  });

  it('getDatabase GETs /v1/databases/{id}', async () => {
    const { fetch, calls } = mockFetch({
      status: 200,
      body: { object: 'database', id: 'd1' },
    });
    await getDatabase({ token: 'k', fetch }, ID);
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.url).toMatch(/\/v1\/databases\/d1$/);
  });

  it('updateDatabase PATCHes /v1/databases/{id}', async () => {
    const { fetch, calls } = mockFetch({
      status: 200,
      body: { object: 'database', id: 'd1' },
    });
    await updateDatabase({ token: 'k', fetch }, ID, {
      title: [{ type: 'text', text: { content: 'renamed', link: null } }],
    });
    expect(calls[0]!.method).toBe('PATCH');
    expect(calls[0]!.url).toMatch(/\/v1\/databases\/d1$/);
  });

  it('queryDatabase POSTs /v1/databases/{id}/query with filter+sorts', async () => {
    const { fetch, calls } = mockFetch({
      status: 200,
      body: { object: 'list', results: [], next_cursor: null, has_more: false },
    });
    await queryDatabase({ token: 'k', fetch }, ID, {
      filter: { property: 'Status', select: { equals: 'Done' } },
      sorts: [{ property: 'Name', direction: 'ascending' }],
      page_size: 25,
    });
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toMatch(/\/v1\/databases\/d1\/query$/);
    const sent = JSON.parse(calls[0]!.body!);
    expect(sent.filter.property).toBe('Status');
    expect(sent.sorts[0].property).toBe('Name');
    expect(sent.page_size).toBe(25);
  });
});
