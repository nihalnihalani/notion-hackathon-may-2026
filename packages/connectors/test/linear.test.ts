import { describe, expect, it } from 'vitest';
import { ConnectorError } from '../src/errors.js';
import { createLinearClient } from '../src/linear/index.js';
import { mockFetch } from './helpers.js';

const issueNode = {
  id: 'iss_1',
  identifier: 'ENG-1',
  title: 'Fix',
  description: null,
  priority: 1,
  url: 'https://linear.app/x/issue/ENG-1',
  state: { id: 's', name: 'Todo', type: 'unstarted' },
  assignee: null,
  team: { id: 't', key: 'ENG', name: 'Engineering' },
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

describe('LinearClient', () => {
  it('listMyIssues posts GraphQL and returns nodes', async () => {
    const { fetch, calls } = mockFetch({
      status: 200,
      body: { data: { issues: { nodes: [issueNode] } } },
    });
    const c = createLinearClient({ apiKey: 'k', fetch });
    const out = await c.listMyIssues();
    expect(out).toHaveLength(1);
    expect(out[0]!.identifier).toBe('ENG-1');
    const body = JSON.parse(calls[0]!.body!);
    expect(body.query).toContain('issues');
    expect(body.variables.filter.assignee.isMe.eq).toBe(true);
  });

  it('createIssue throws when issueCreate.success is false', async () => {
    const { fetch } = mockFetch({
      status: 200,
      body: { data: { issueCreate: { success: false, issue: null } } },
    });
    const c = createLinearClient({ apiKey: 'k', fetch });
    await expect(
      c.createIssue({ teamId: 't', title: 'x' }),
    ).rejects.toBeInstanceOf(ConnectorError);
  });

  it('surfaces graphql errors as ConnectorError', async () => {
    const { fetch } = mockFetch({
      status: 200,
      body: { errors: [{ message: 'unauthorized' }] },
    });
    const c = createLinearClient({ apiKey: 'k', fetch });
    await expect(c.getIssue('x')).rejects.toThrow(/unauthorized/);
  });
});
