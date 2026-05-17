import { describe, expect, it } from 'vitest';
import { search } from '../src/search.js';
import { mockFetch } from './helpers.js';

describe('search', () => {
  it('POSTs /v1/search with the query body', async () => {
    const { fetch, calls } = mockFetch({
      status: 200,
      body: { object: 'list', results: [], next_cursor: null, has_more: false },
    });
    await search(
      { token: 'k', fetch },
      {
        query: 'Forge',
        filter: { value: 'page' },
        sort: { direction: 'descending', timestamp: 'last_edited_time' },
      },
    );
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toMatch(/\/v1\/search$/);
    const sent = JSON.parse(calls[0]!.body!);
    expect(sent.query).toBe('Forge');
    // We normalise the filter so callers don't have to remember the inner `property: 'object'`.
    expect(sent.filter).toEqual({ property: 'object', value: 'page' });
    expect(sent.sort.timestamp).toBe('last_edited_time');
  });

  it('omits filter when not provided', async () => {
    const { fetch, calls } = mockFetch({
      status: 200,
      body: { object: 'list', results: [], next_cursor: null, has_more: false },
    });
    await search({ token: 'k', fetch }, {});
    const sent = JSON.parse(calls[0]!.body!);
    expect(sent.filter).toBeUndefined();
  });
});
