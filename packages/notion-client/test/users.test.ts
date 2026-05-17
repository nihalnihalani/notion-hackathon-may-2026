import { describe, expect, it } from 'vitest';
import { getMe, getUser, listUsers } from '../src/users.js';
import { asUserId } from '../src/types.js';
import { mockFetch } from './helpers.js';

describe('users', () => {
  it('getMe GETs /v1/users/me', async () => {
    const { fetch, calls } = mockFetch({
      status: 200,
      body: { object: 'user', id: 'u1', type: 'bot' },
    });
    await getMe({ token: 'k', fetch });
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.url).toMatch(/\/v1\/users\/me$/);
    expect(calls[0]!.headers['authorization']).toBe('Bearer k');
  });

  it('getUser GETs /v1/users/{id}', async () => {
    const { fetch, calls } = mockFetch({
      status: 200,
      body: { object: 'user', id: 'u9', type: 'person' },
    });
    await getUser({ token: 'k', fetch }, asUserId('u9'));
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.url).toMatch(/\/v1\/users\/u9$/);
  });

  it('listUsers paginates via start_cursor + page_size', async () => {
    const { fetch, calls } = mockFetch({
      status: 200,
      body: { object: 'list', results: [], next_cursor: null, has_more: false },
    });
    await listUsers({ token: 'k', fetch }, { start_cursor: 'c1', page_size: 10 });
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.url).toContain('start_cursor=c1');
    expect(calls[0]!.url).toContain('page_size=10');
  });
});
