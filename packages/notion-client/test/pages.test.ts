import { describe, expect, it } from 'vitest';
import {
  archivePage,
  createPage,
  getPage,
  getPageProperty,
  updatePage,
} from '../src/pages.js';
import { asPageId, asPropertyId } from '../src/types.js';
import { mockFetch } from './helpers.js';

const cfg = (fetch: ReturnType<typeof mockFetch>['fetch']) => ({
  token: 'k',
  fetch,
});

describe('pages', () => {
  it('createPage POSTs /v1/pages with the body', async () => {
    const { fetch, calls } = mockFetch({
      status: 200,
      body: { object: 'page', id: 'p1' },
    });
    await createPage(cfg(fetch), {
      parent: { type: 'database_id', database_id: 'd1' },
      properties: { Name: { title: [{ type: 'text', text: { content: 'hi' } }] } },
    });
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toMatch(/\/v1\/pages$/);
    expect(calls[0]!.headers['authorization']).toBe('Bearer k');
    const sent = JSON.parse(calls[0]!.body!);
    expect(sent.parent.database_id).toBe('d1');
  });

  it('getPage GETs /v1/pages/{id}', async () => {
    const { fetch, calls } = mockFetch({
      status: 200,
      body: { object: 'page', id: 'p1' },
    });
    await getPage(cfg(fetch), asPageId('p1'));
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.url).toMatch(/\/v1\/pages\/p1$/);
  });

  it('updatePage PATCHes /v1/pages/{id}', async () => {
    const { fetch, calls } = mockFetch({
      status: 200,
      body: { object: 'page', id: 'p1' },
    });
    await updatePage(cfg(fetch), asPageId('p1'), {
      properties: { Status: { select: { name: 'Done' } } },
    });
    expect(calls[0]!.method).toBe('PATCH');
    expect(calls[0]!.url).toMatch(/\/v1\/pages\/p1$/);
  });

  it('archivePage sends `archived: true`', async () => {
    const { fetch, calls } = mockFetch({
      status: 200,
      body: { object: 'page', id: 'p1' },
    });
    await archivePage(cfg(fetch), asPageId('p1'));
    const sent = JSON.parse(calls[0]!.body!);
    expect(sent.archived).toBe(true);
  });

  it('getPageProperty GETs the property item', async () => {
    const { fetch, calls } = mockFetch({
      status: 200,
      body: { object: 'property_item', type: 'number', number: 42 },
    });
    await getPageProperty(
      cfg(fetch),
      asPageId('p1'),
      asPropertyId('prop_x'),
      { page_size: 10 },
    );
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.url).toMatch(
      /\/v1\/pages\/p1\/properties\/prop_x\?page_size=10$/,
    );
  });
});
