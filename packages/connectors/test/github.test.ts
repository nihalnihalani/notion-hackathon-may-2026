import { describe, expect, it } from 'vitest';
import { createGithubClient } from '../src/github/index.js';
import { NotFoundError } from '../src/errors.js';
import { mockFetch } from './helpers.js';

const pr = {
  id: 1,
  number: 42,
  title: 'Fix bug',
  state: 'open',
  body: '',
  user: { id: 1, login: 'octocat' },
  labels: [],
  html_url: 'https://github.com/o/r/pull/42',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  closed_at: null,
};

describe('GithubClient', () => {
  it('listOpenPRs hits the right URL and parses', async () => {
    const { fetch, calls } = mockFetch({ status: 200, body: [pr] });
    const c = createGithubClient({ apiKey: 'k', fetch });
    const out = await c.listOpenPRs('o/r');
    expect(out).toHaveLength(1);
    expect(out[0]!.number).toBe(42);
    expect(calls[0]!.url).toContain('/repos/o/r/pulls?state=open&per_page=100');
  });

  it('validate=true round-trips through zod', async () => {
    const { fetch } = mockFetch({ status: 200, body: pr });
    const c = createGithubClient({ apiKey: 'k', fetch });
    const out = await c.getPR('o/r', 42, { validate: true });
    expect(out.title).toBe('Fix bug');
  });

  it('rejects malformed repo identifier', async () => {
    const { fetch } = mockFetch({ status: 200, body: [] });
    const c = createGithubClient({ apiKey: 'k', fetch });
    await expect(c.listOpenPRs('badrepo')).rejects.toThrow(/owner\/name/);
  });

  it('translates 404 to NotFoundError', async () => {
    const { fetch } = mockFetch({ status: 404, body: { message: 'Not Found' } });
    const c = createGithubClient({ apiKey: 'k', fetch });
    await expect(c.getRepo('o', 'r')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('addPRComment POSTs to the issues endpoint with body wrapper', async () => {
    const { fetch, calls } = mockFetch({
      status: 201,
      body: {
        id: 1,
        body: 'hi',
        user: null,
        html_url: 'https://github.com/o/r/issues/42#c',
        created_at: '2026-01-01T00:00:00Z',
      },
    });
    const c = createGithubClient({ apiKey: 'k', fetch });
    await c.addPRComment('o/r', 42, 'hi');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toContain('/issues/42/comments');
    expect(JSON.parse(calls[0]!.body!)).toEqual({ body: 'hi' });
  });
});
