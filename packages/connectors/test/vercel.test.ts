import { describe, expect, it } from 'vitest';
import { createVercelClient } from '../src/vercel/index.js';
import { mockFetch } from './helpers.js';

describe('VercelClient', () => {
  it('listDeployments unwraps deployments[]', async () => {
    const { fetch, calls } = mockFetch({
      status: 200,
      body: {
        deployments: [{ uid: 'dpl_1', name: 'web', readyState: 'READY' }],
      },
    });
    const c = createVercelClient({ apiKey: 'k', fetch });
    const out = await c.listDeployments('prj_1', 3);
    expect(out).toHaveLength(1);
    expect(out[0]!.uid).toBe('dpl_1');
    expect(calls[0]!.url).toContain('projectId=prj_1');
    expect(calls[0]!.url).toContain('limit=3');
  });

  it('getProject reads from v10', async () => {
    const { fetch, calls } = mockFetch({
      status: 200,
      body: { id: 'prj_1', name: 'web' },
    });
    const c = createVercelClient({ apiKey: 'k', fetch });
    const out = await c.getProject('prj_1');
    expect(out.id).toBe('prj_1');
    expect(calls[0]!.url).toContain('/v10/projects/prj_1');
  });
});
