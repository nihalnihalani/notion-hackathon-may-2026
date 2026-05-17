import { describe, expect, it } from 'vitest';

import { InstallerError } from '../src/errors.js';
import { reconcileForgePage } from '../src/reconciler.js';
import type { InstallOptions } from '../src/types.js';
import { fakeDb, mockNotion } from './helpers.js';

function baseOpts(overrides: Partial<InstallOptions> = {}): InstallOptions {
  return {
    workspaceId: 'ws_forge_1',
    notionWorkspaceId: 'notion_ws_1',
    notionToken: 'secret_xyz',
    parentPageId: 'parent-page-id',
    appUrl: 'https://forge.example',
    ...overrides,
  };
}

describe('reconcileForgePage', () => {
  it('returns no changes when everything is healthy', async () => {
    const { fetch } = mockNotion({
      'GET /v1/pages/page-1': {
        status: 200,
        body: {
          object: 'page',
          id: 'page-1',
          archived: false,
          in_trash: false,
        },
      },
      'GET /v1/blocks/button-1': {
        status: 200,
        body: {
          object: 'block',
          id: 'button-1',
          type: 'bookmark',
          archived: false,
          in_trash: false,
        },
      },
      'GET /v1/blocks/buildlog-1': {
        status: 200,
        body: {
          object: 'block',
          id: 'buildlog-1',
          type: 'synced_block',
          archived: false,
          in_trash: false,
        },
      },
    });
    const db = fakeDb({
      forgePageId: 'page-1',
      forgeDbId: 'req-1',
      forgeAgentsDbId: 'ag-1',
      forgeButtonBlockId: 'button-1',
      forgeBuildLogBlockId: 'buildlog-1',
      webhookSecret: 'a'.repeat(64),
    });

    const result = await reconcileForgePage(
      baseOpts({ notion: { fetch } }),
      db.client,
    );
    expect(result.changes).toEqual([]);
  });

  it('mints a webhook secret if missing from older installs', async () => {
    const { fetch } = mockNotion({
      'GET /v1/pages/page-1': {
        status: 200,
        body: {
          object: 'page',
          id: 'page-1',
          archived: false,
          in_trash: false,
        },
      },
      'GET /v1/blocks/button-1': {
        status: 200,
        body: {
          object: 'block',
          id: 'button-1',
          archived: false,
          in_trash: false,
        },
      },
      'GET /v1/blocks/buildlog-1': {
        status: 200,
        body: {
          object: 'block',
          id: 'buildlog-1',
          archived: false,
          in_trash: false,
        },
      },
    });
    const db = fakeDb({
      forgePageId: 'page-1',
      forgeDbId: 'req-1',
      forgeAgentsDbId: 'ag-1',
      forgeButtonBlockId: 'button-1',
      forgeBuildLogBlockId: 'buildlog-1',
      webhookSecret: null,
    });

    const result = await reconcileForgePage(
      baseOpts({ notion: { fetch } }),
      db.client,
    );
    expect(result.changes).toContain('minted webhook secret');
    expect(db.state.webhookSecret).toMatch(/^[0-9a-f]{64}$/);
  });

  it('re-appends the button block if it returned 404', async () => {
    const { fetch, calls } = mockNotion({
      'GET /v1/pages/page-1': {
        status: 200,
        body: {
          object: 'page',
          id: 'page-1',
          archived: false,
          in_trash: false,
        },
      },
      'GET /v1/blocks/button-stale': {
        status: 404,
        body: { object: 'error', code: 'object_not_found' },
      },
      'GET /v1/blocks/buildlog-1': {
        status: 200,
        body: {
          object: 'block',
          id: 'buildlog-1',
          archived: false,
          in_trash: false,
        },
      },
      'PATCH /v1/blocks/page-1/children': {
        status: 200,
        body: {
          object: 'list',
          next_cursor: null,
          has_more: false,
          results: [{ object: 'block', id: 'button-fresh', type: 'bookmark' }],
        },
      },
    });
    const db = fakeDb({
      forgePageId: 'page-1',
      forgeDbId: 'req-1',
      forgeAgentsDbId: 'ag-1',
      forgeButtonBlockId: 'button-stale',
      forgeBuildLogBlockId: 'buildlog-1',
      webhookSecret: 'a'.repeat(64),
    });

    const result = await reconcileForgePage(
      baseOpts({ notion: { fetch } }),
      db.client,
    );

    expect(result.changes).toContain('re-added forge button block');
    expect(db.state.forgeButtonBlockId).toBe('button-fresh');

    // Verify the PATCH carries our webhook URL in the bookmark.
    const appendCall = calls.find(
      (c) => c.method === 'PATCH' && c.url.includes('/blocks/page-1/children'),
    );
    expect(appendCall).toBeDefined();
    expect(appendCall!.body).toContain('forge.example');
    expect(appendCall!.body).toContain('bookmark');
  });

  it('throws when the row is missing core IDs (caller routes to install)', async () => {
    const { fetch } = mockNotion({});
    const db = fakeDb({
      forgePageId: null,
      forgeDbId: null,
      forgeAgentsDbId: null,
      forgeButtonBlockId: null,
      forgeBuildLogBlockId: null,
      webhookSecret: 'a'.repeat(64),
    });

    let caught: unknown;
    try {
      await reconcileForgePage(baseOpts({ notion: { fetch } }), db.client);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(InstallerError);
    expect((caught as InstallerError).step).toBe('reconcile');
  });

  it('throws when the root page is archived', async () => {
    const { fetch } = mockNotion({
      'GET /v1/pages/page-1': {
        status: 200,
        body: {
          object: 'page',
          id: 'page-1',
          archived: true,
          in_trash: false,
        },
      },
    });
    const db = fakeDb({
      forgePageId: 'page-1',
      forgeDbId: 'req-1',
      forgeAgentsDbId: 'ag-1',
      forgeButtonBlockId: 'button-1',
      forgeBuildLogBlockId: 'buildlog-1',
      webhookSecret: 'a'.repeat(64),
    });

    let caught: unknown;
    try {
      await reconcileForgePage(baseOpts({ notion: { fetch } }), db.client);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(InstallerError);
  });
});
