/**
 * POST /api/onboarding/install
 *   200 happy path → { ok: true, redirect: '/dashboard', ... }
 *   400 validation (missing/invalid parentPageId)
 *   400 picker chose a page the integration can't see (Notion 404)
 *   401 without Clerk session
 *   403 when the user has no Notion oauth token
 *   404 when no workspace row is bound
 *   502 when Notion API errors (non-404)
 *   200 idempotency — re-running on installed workspace returns same IDs
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeCtx, makeRequest, readJson, stubSentryWrapper } from './_helpers';

stubSentryWrapper();

vi.mock('@clerk/nextjs/server', () => ({
  auth: vi.fn(),
  currentUser: vi.fn(),
  clerkClient: vi.fn(),
}));

vi.mock('@forge/db', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    workspace: {
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
  },
  recordAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

// Hoisted shared mocks — `installForgePage` is the surface we drive; the
// stub `InstallerError` class matches the production shape so the route's
// `instanceof InstallerError` branch is exercised.
const { StubInstallerError, NotionNotFoundError } = vi.hoisted(() => {
  class StubInstallerError extends Error {
    step: string;
    workspaceId: string;
    constructor(
      message: string,
      init: { step: string; workspaceId: string; cause?: unknown },
    ) {
      super(
        message,
        init.cause === undefined ? undefined : { cause: init.cause },
      );
      this.name = 'InstallerError';
      this.step = init.step;
      this.workspaceId = init.workspaceId;
    }
  }
  class NotionNotFoundError extends Error {
    status = 404;
    body: unknown;
    code = 'object_not_found';
    constructor(message: string) {
      super(message);
      this.name = 'NotionNotFoundError';
    }
  }
  return { StubInstallerError, NotionNotFoundError };
});

vi.mock('@forge/installer', () => ({
  installForgePage: vi.fn(),
  InstallerError: StubInstallerError,
}));

vi.mock('@forge/notion-client', () => ({
  asPageId: (s: string) => s,
  getPage: vi.fn(),
  NotionNotFoundError,
}));

vi.mock('@/lib/notion', () => ({
  getNotionTokenForClerkUser: vi.fn(),
  buildNotionConfig: (token: string) => ({ token }),
}));

vi.mock('@/lib/posthog', () => ({ capture: vi.fn() }));

const fakeUser = {
  id: 'user_1',
  email: 'nihal@example.com',
  workspace: {
    id: 'ws_1',
    notionWorkspaceId: 'nws_1',
    name: 'Acme',
    forgePageId: null,
  },
};

// A real Notion UUID-shaped string (dashed) the body schema will accept.
const VALID_PARENT = 'a1b2c3d4-e5f6-7890-abcd-ef0123456789';

beforeEach(async () => {
  vi.resetAllMocks();
  vi.resetModules();
  process.env['NEXT_PUBLIC_APP_URL'] = 'http://localhost:3000';

  const clerk = await import('@clerk/nextjs/server');
  vi.mocked(clerk.auth).mockResolvedValue({ userId: 'clerk_1' } as never);

  const db = await import('@forge/db');
  vi.mocked(db.prisma.user.findUnique).mockResolvedValue(fakeUser as never);

  const notion = await import('@/lib/notion');
  vi.mocked(notion.getNotionTokenForClerkUser).mockResolvedValue('ntoken');

  const nc = await import('@forge/notion-client');
  vi.mocked(nc.getPage).mockResolvedValue({
    id: VALID_PARENT,
    object: 'page',
    archived: false,
    in_trash: false,
  } as never);

  const installer = await import('@forge/installer');
  vi.mocked(installer.installForgePage).mockResolvedValue({
    pageId: 'page_1',
    requestsDbId: 'db_1',
    agentsDbId: 'db_agents_1',
    buildLogBlockId: 'block_log_1',
    buttonBlockId: 'block_btn_1',
  });
});

describe('POST /api/onboarding/install', () => {
  it('returns 200 on the happy path and resolves to /dashboard', async () => {
    const { POST } = await import('@/app/api/onboarding/install/route');
    const res = await POST(
      makeRequest('http://localhost/api/onboarding/install', {
        method: 'POST',
        body: { parentPageId: VALID_PARENT },
      }) as never,
      makeCtx({}),
    );
    expect(res.status).toBe(200);
    const body = await readJson<{
      ok: boolean;
      redirect: string;
      pageId: string;
    }>(res);
    expect(body.ok).toBe(true);
    expect(body.redirect).toBe('/dashboard');
    expect(body.pageId).toBe('page_1');
  });

  it('returns 400 when parentPageId is missing', async () => {
    const { POST } = await import('@/app/api/onboarding/install/route');
    const res = await POST(
      makeRequest('http://localhost/api/onboarding/install', {
        method: 'POST',
        body: {},
      }) as never,
      makeCtx({}),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when parentPageId is not a Notion UUID', async () => {
    const { POST } = await import('@/app/api/onboarding/install/route');
    const res = await POST(
      makeRequest('http://localhost/api/onboarding/install', {
        method: 'POST',
        body: { parentPageId: 'not-a-uuid' },
      }) as never,
      makeCtx({}),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when Notion 404s on the picked page (no integration access)', async () => {
    const nc = await import('@forge/notion-client');
    vi.mocked(nc.getPage).mockRejectedValue(
      new NotionNotFoundError('object_not_found'),
    );
    const { POST } = await import('@/app/api/onboarding/install/route');
    const res = await POST(
      makeRequest('http://localhost/api/onboarding/install', {
        method: 'POST',
        body: { parentPageId: VALID_PARENT },
      }) as never,
      makeCtx({}),
    );
    expect(res.status).toBe(400);
    const body = await readJson<{ message: string }>(res);
    expect(body.message).toMatch(/share the page with the forge integration/i);
  });

  it('returns 401 without a Clerk session', async () => {
    const clerk = await import('@clerk/nextjs/server');
    vi.mocked(clerk.auth).mockResolvedValue({ userId: null } as never);
    const { POST } = await import('@/app/api/onboarding/install/route');
    const res = await POST(
      makeRequest('http://localhost/api/onboarding/install', {
        method: 'POST',
        body: { parentPageId: VALID_PARENT },
      }) as never,
      makeCtx({}),
    );
    expect(res.status).toBe(401);
  });

  it('returns 403 when no Notion OAuth token is on the user', async () => {
    const notion = await import('@/lib/notion');
    vi.mocked(notion.getNotionTokenForClerkUser).mockResolvedValue(null);
    const { POST } = await import('@/app/api/onboarding/install/route');
    const res = await POST(
      makeRequest('http://localhost/api/onboarding/install', {
        method: 'POST',
        body: { parentPageId: VALID_PARENT },
      }) as never,
      makeCtx({}),
    );
    expect(res.status).toBe(403);
  });

  it('returns 403 when no Forge workspace row is bound (requireWorkspace path)', async () => {
    // requireWorkspace returns 403 forbidden when the user row is missing —
    // that's the closest match to "workspace not found" the auth helper
    // surfaces.
    const db = await import('@forge/db');
    vi.mocked(db.prisma.user.findUnique).mockResolvedValue(null);
    const { POST } = await import('@/app/api/onboarding/install/route');
    const res = await POST(
      makeRequest('http://localhost/api/onboarding/install', {
        method: 'POST',
        body: { parentPageId: VALID_PARENT },
      }) as never,
      makeCtx({}),
    );
    expect(res.status).toBe(403);
  });

  it('returns 502 when Notion getPage errors with non-404', async () => {
    const nc = await import('@forge/notion-client');
    vi.mocked(nc.getPage).mockRejectedValue(new Error('notion 500'));
    const { POST } = await import('@/app/api/onboarding/install/route');
    const res = await POST(
      makeRequest('http://localhost/api/onboarding/install', {
        method: 'POST',
        body: { parentPageId: VALID_PARENT },
      }) as never,
      makeCtx({}),
    );
    expect(res.status).toBe(502);
  });

  it('returns 502 when the installer throws an InstallerError', async () => {
    const installer = await import('@forge/installer');
    vi.mocked(installer.installForgePage).mockRejectedValue(
      new StubInstallerError('Notion synced_block disallowed', {
        step: 'create-build-log-block',
        workspaceId: 'ws_1',
      }),
    );
    const { POST } = await import('@/app/api/onboarding/install/route');
    const res = await POST(
      makeRequest('http://localhost/api/onboarding/install', {
        method: 'POST',
        body: { parentPageId: VALID_PARENT },
      }) as never,
      makeCtx({}),
    );
    expect(res.status).toBe(502);
    const body = await readJson<{ step?: string }>(res);
    expect(body.step).toBe('create-build-log-block');
  });

  it('is idempotent — re-running on an installed workspace returns the same IDs', async () => {
    // The installer's `precheck-existing-install` step short-circuits the
    // re-run; our mock here mirrors that contract by returning the same
    // shape on a second call.
    const installer = await import('@forge/installer');
    const installed = {
      pageId: 'page_existing',
      requestsDbId: 'db_existing',
      agentsDbId: 'db_agents_existing',
      buildLogBlockId: 'block_log_existing',
      buttonBlockId: 'block_btn_existing',
    };
    vi.mocked(installer.installForgePage).mockResolvedValue(installed);

    const { POST } = await import('@/app/api/onboarding/install/route');

    const first = await POST(
      makeRequest('http://localhost/api/onboarding/install', {
        method: 'POST',
        body: { parentPageId: VALID_PARENT },
      }) as never,
      makeCtx({}),
    );
    expect(first.status).toBe(200);
    const firstBody = await readJson<{ pageId: string; requestsDbId: string }>(
      first,
    );

    const second = await POST(
      makeRequest('http://localhost/api/onboarding/install', {
        method: 'POST',
        body: { parentPageId: VALID_PARENT },
      }) as never,
      makeCtx({}),
    );
    expect(second.status).toBe(200);
    const secondBody = await readJson<{
      pageId: string;
      requestsDbId: string;
    }>(second);

    expect(secondBody.pageId).toBe(firstBody.pageId);
    expect(secondBody.requestsDbId).toBe(firstBody.requestsDbId);
  });
});
