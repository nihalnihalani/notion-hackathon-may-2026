import { describe, expect, it } from 'vitest';
import { createSentryClient } from '../src/sentry/index.js';
import { mockFetch } from './helpers.js';

describe('SentryClient', () => {
  it('listIssues uses org/project URL pattern', async () => {
    const { fetch, calls } = mockFetch({
      status: 200,
      body: [
        { id: 'iss_1', title: 'TypeError', status: 'unresolved' },
      ],
    });
    const c = createSentryClient({ apiKey: 'k', fetch });
    const out = await c.listIssues('acme/web');
    expect(out).toHaveLength(1);
    expect(calls[0]!.url).toContain('/projects/acme/web/issues/');
  });

  it('resolveIssue PUTs status=resolved', async () => {
    const { fetch, calls } = mockFetch({
      status: 200,
      body: { id: 'iss_1', title: 'TypeError', status: 'resolved' },
    });
    const c = createSentryClient({ apiKey: 'k', fetch });
    const out = await c.resolveIssue('iss_1');
    expect(out.status).toBe('resolved');
    expect(calls[0]!.method).toBe('PUT');
    expect(JSON.parse(calls[0]!.body!)).toEqual({ status: 'resolved' });
  });
});
