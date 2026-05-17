import { describe, expect, it } from 'vitest';

import { InstallerError } from '../src/errors.js';
import { installForgePage } from '../src/installer.js';
import type { InstallOptions } from '../src/types.js';
import { fakeDb, mockNotion } from './helpers.js';

const PARENT_PAGE = 'parent-page-id';

function baseOpts(overrides: Partial<InstallOptions> = {}): InstallOptions {
  return {
    workspaceId: 'ws_forge_1',
    notionWorkspaceId: 'notion_ws_1',
    notionToken: 'secret_xyz',
    parentPageId: PARENT_PAGE,
    appUrl: 'https://forge.example',
    ...overrides,
  };
}

/** Build the standard happy-path Notion route table. */
function happyRoutes() {
  return {
    'POST /v1/pages': {
      status: 200,
      body: {
        object: 'page',
        id: 'page-forge-root',
        archived: false,
        in_trash: false,
      },
    },
    // Agents DB created first, then Requests DB. Queue two responses so
    // the second create call gets a different id.
    'POST /v1/databases': [
      {
        status: 200,
        body: { object: 'database', id: 'db-agents' },
      },
      {
        status: 200,
        body: { object: 'database', id: 'db-requests' },
      },
    ],
    // Append calls in order:
    //  1) bookmark (button fallback)            → button-block
    //  2) divider + heading + synced_block       → buildlog container is last
    //  3) divider + settings toggle              → settings toggle
    //  4) settings children appended to toggle   → settings children
    'PATCH /v1/blocks/[^/]+/children': [
      {
        status: 200,
        body: {
          object: 'list',
          next_cursor: null,
          has_more: false,
          results: [{ object: 'block', id: 'block-button', type: 'bookmark' }],
        },
      },
      {
        status: 200,
        body: {
          object: 'list',
          next_cursor: null,
          has_more: false,
          results: [
            { object: 'block', id: 'block-divider-1', type: 'divider' },
            { object: 'block', id: 'block-bl-head', type: 'heading_3' },
            {
              object: 'block',
              id: 'block-bl-container',
              type: 'synced_block',
            },
          ],
        },
      },
      {
        status: 200,
        body: {
          object: 'list',
          next_cursor: null,
          has_more: false,
          results: [
            { object: 'block', id: 'block-divider-2', type: 'divider' },
            { object: 'block', id: 'block-settings-toggle', type: 'toggle' },
          ],
        },
      },
      {
        status: 200,
        body: {
          object: 'list',
          next_cursor: null,
          has_more: false,
          results: [],
        },
      },
    ],
  };
}

describe('installForgePage — happy path', () => {
  it('creates page + 2 DBs + button + build log + settings, returns InstallationResult', async () => {
    const { fetch, calls } = mockNotion(happyRoutes());
    const db = fakeDb();

    const result = await installForgePage(
      baseOpts({ notion: { fetch } }),
      db.client,
    );

    expect(result.pageId).toBe('page-forge-root');
    // Agents created first in our installer (so Requests can reference
    // it), so db-agents resolves to agentsDbId and db-requests to
    // requestsDbId.
    expect(result.agentsDbId).toBe('db-agents');
    expect(result.requestsDbId).toBe('db-requests');
    expect(result.buttonBlockId).toBe('block-button');
    expect(result.buildLogBlockId).toBe('block-bl-container');

    // Verify the Notion API call pattern:
    //   POST /v1/pages
    //   POST /v1/databases (×2)
    //   PATCH /v1/blocks/page-forge-root/children (button)
    //   PATCH /v1/blocks/page-forge-root/children (build log)
    //   PATCH /v1/blocks/page-forge-root/children (settings toggle)
    //   PATCH /v1/blocks/block-settings-toggle/children (settings children)
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toMatch(/\/v1\/pages$/);
    expect(calls[1]!.url).toMatch(/\/v1\/databases$/);
    expect(calls[2]!.url).toMatch(/\/v1\/databases$/);
    // Button payload includes our webhook URL embedded as a bookmark.
    const buttonAppendCall = calls.find(
      (c) => c.method === 'PATCH' && c.url.includes('/blocks/'),
    );
    expect(buttonAppendCall).toBeDefined();
    expect(buttonAppendCall!.body).toContain('forge.example');
    expect(buttonAppendCall!.body).toContain('notion-button');
    expect(buttonAppendCall!.body).toContain('bookmark');
  });

  it('persists every forge*Id column on the Workspace row', async () => {
    const { fetch } = mockNotion(happyRoutes());
    const db = fakeDb();
    await installForgePage(baseOpts({ notion: { fetch } }), db.client);

    expect(db.state.forgePageId).toBe('page-forge-root');
    expect(db.state.forgeDbId).toBe('db-requests');
    expect(db.state.forgeAgentsDbId).toBe('db-agents');
    expect(db.state.forgeButtonBlockId).toBe('block-button');
    expect(db.state.forgeBuildLogBlockId).toBe('block-bl-container');
    expect(db.state.webhookSecret).toMatch(/^[0-9a-f]{64}$/);
  });

  it('Requests DB schema references the Agents DB id in the Deployed Agent relation', async () => {
    const { fetch, calls } = mockNotion(happyRoutes());
    const db = fakeDb();
    await installForgePage(baseOpts({ notion: { fetch } }), db.client);

    // Second DB POST is the Requests DB; assert its body's
    // properties.Deployed Agent.relation.database_id matches the
    // returned Agents DB id.
    const dbCalls = calls.filter(
      (c) => c.method === 'POST' && /\/v1\/databases$/.test(c.url),
    );
    expect(dbCalls).toHaveLength(2);
    const requestsBody = JSON.parse(dbCalls[1]!.body!);
    expect(requestsBody.properties['Deployed Agent'].relation.database_id).toBe(
      'db-agents',
    );
    // And single_property is set (back-relation auto-created).
    expect(
      requestsBody.properties['Deployed Agent'].relation.single_property,
    ).toBeDefined();
  });
});

describe('installForgePage — idempotency', () => {
  it('returns existing IDs without calling Notion when fully installed + page exists', async () => {
    const { fetch, calls } = mockNotion({
      // We expect only the page-GET to be issued (verification).
      'GET /v1/pages/page-forge-root': {
        status: 200,
        body: {
          object: 'page',
          id: 'page-forge-root',
          archived: false,
          in_trash: false,
        },
      },
    });
    const db = fakeDb({
      forgePageId: 'page-forge-root',
      forgeDbId: 'db-requests',
      forgeAgentsDbId: 'db-agents',
      forgeButtonBlockId: 'block-button',
      forgeBuildLogBlockId: 'block-bl-container',
      webhookSecret: 'a'.repeat(64),
    });

    const result = await installForgePage(
      baseOpts({ notion: { fetch } }),
      db.client,
    );

    // No DB writes, no POSTs to Notion.
    expect(db.patches).toHaveLength(0);
    expect(calls.filter((c) => c.method !== 'GET')).toHaveLength(0);

    expect(result).toEqual({
      pageId: 'page-forge-root',
      requestsDbId: 'db-requests',
      agentsDbId: 'db-agents',
      buttonBlockId: 'block-button',
      buildLogBlockId: 'block-bl-container',
    });
  });

  it('re-installs when the persisted page returns 404 in Notion', async () => {
    const { fetch } = mockNotion({
      // First call: page-GET → 404. Then the full install routes.
      'GET /v1/pages/page-forge-root-stale': {
        status: 404,
        body: { object: 'error', code: 'object_not_found' },
      },
      ...happyRoutes(),
    });
    const db = fakeDb({
      forgePageId: 'page-forge-root-stale',
      forgeDbId: 'db-old',
      forgeAgentsDbId: 'db-old-agents',
      forgeButtonBlockId: 'block-old-button',
      forgeBuildLogBlockId: 'block-old-bl',
      webhookSecret: 'a'.repeat(64),
    });

    const result = await installForgePage(
      baseOpts({ notion: { fetch } }),
      db.client,
    );

    // Got fresh IDs from the happy-path responses.
    expect(result.pageId).toBe('page-forge-root');
    expect(result.requestsDbId).toBe('db-requests');

    // Persisted the new IDs over the stale ones.
    expect(db.state.forgePageId).toBe('page-forge-root');
    expect(db.state.forgeDbId).toBe('db-requests');

    // Webhook secret was reused (not regenerated) — important so existing
    // queued webhooks remain verifiable.
    expect(db.state.webhookSecret).toBe('a'.repeat(64));
  });
});

describe('installForgePage — failure handling', () => {
  it('wraps Notion errors in InstallerError with the canonical step name', async () => {
    const { fetch } = mockNotion({
      'POST /v1/pages': {
        status: 200,
        body: {
          object: 'page',
          id: 'page-forge-root',
          archived: false,
          in_trash: false,
        },
      },
      // First DB create succeeds (agents), second (requests) fails.
      'POST /v1/databases': [
        {
          status: 200,
          body: { object: 'database', id: 'db-agents' },
        },
        {
          status: 400,
          body: {
            object: 'error',
            code: 'validation_error',
            message: 'invalid_property_schema',
          },
        },
      ],
    });
    const db = fakeDb();

    let caught: unknown;
    try {
      await installForgePage(baseOpts({ notion: { fetch } }), db.client);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(InstallerError);
    const err = caught as InstallerError;
    expect(err.step).toBe('create-requests-db');
    expect(err.workspaceId).toBe('ws_forge_1');
    expect(err.cause).toBeDefined();
  });

  it('throws InstallerError(create-root-page) when parentPageId is missing', async () => {
    const { fetch } = mockNotion({});
    const db = fakeDb();

    let caught: unknown;
    // omit parentPageId entirely so exactOptionalPropertyTypes is satisfied
    const opts = { ...baseOpts({ notion: { fetch } }) };
    delete (opts as { parentPageId?: string }).parentPageId;
    try {
      await installForgePage(opts, db.client);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(InstallerError);
    expect((caught as InstallerError).step).toBe('create-root-page');
  });
});
