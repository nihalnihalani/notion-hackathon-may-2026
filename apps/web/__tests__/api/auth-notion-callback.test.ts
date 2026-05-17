/**
 * POST /api/auth/notion/callback
 *   303 redirect to /agents on the happy path
 *   401 without Clerk session
 *   403 when Clerk has no notion oauth token
 *   502 when the OAuth response omits workspace id
 *   installer failures DO NOT block the callback (still 303)
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeCtx, makeRequest, stubSentryWrapper } from './_helpers';

stubSentryWrapper();

const getUserOauthAccessTokenMock = vi.fn();

vi.mock('@clerk/nextjs/server', () => ({
  auth: vi.fn(),
  currentUser: vi.fn(),
  clerkClient: vi.fn().mockResolvedValue({
    users: { getUserOauthAccessToken: getUserOauthAccessTokenMock },
  }),
}));

vi.mock('@forge/db', () => ({
  prisma: {
    user: { upsert: vi.fn() },
    // The installer adapter the callback builds calls these directly.
    workspace: {
      findUnique: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({}),
    },
  },
  upsertWorkspace: vi.fn().mockResolvedValue({ id: 'ws_1' }),
  recordAuditEvent: vi.fn(),
}));

// `InstallerError` is referenced by the route's `instanceof` check that
// distinguishes "missing parent page" failures (→ redirect to picker) from
// other installer errors (→ still redirect to /agents). The real export is a
// class; we re-create a structurally identical one here so the instanceof
// check is exercised by the test. Hoisted because `vi.mock` factories run
// before module-top declarations.
const { StubInstallerError } = vi.hoisted(() => {
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
  return { StubInstallerError };
});
vi.mock('@forge/installer', () => ({
  installForgePage: vi.fn(),
  InstallerError: StubInstallerError,
}));

vi.mock('@/lib/posthog', () => ({ capture: vi.fn() }));

beforeEach(async () => {
  vi.resetAllMocks();
  vi.resetModules();
  process.env['NEXT_PUBLIC_APP_URL'] = 'http://localhost:3000';

  const clerk = await import('@clerk/nextjs/server');
  vi.mocked(clerk.auth).mockResolvedValue({ userId: 'clerk_1' } as never);
  vi.mocked(clerk.currentUser).mockResolvedValue({
    emailAddresses: [{ emailAddress: 'nihal@example.com' }],
  } as never);
  vi.mocked(clerk.clerkClient).mockResolvedValue({
    users: { getUserOauthAccessToken: getUserOauthAccessTokenMock },
  } as never);
  getUserOauthAccessTokenMock.mockResolvedValue({
    data: [{ token: 'ntoken', workspaceId: 'nws_1', workspaceName: 'Acme' }],
  });

  const installer = await import('@forge/installer');
  vi.mocked(installer.installForgePage).mockResolvedValue({
    pageId: 'page_1',
    requestsDbId: 'db_1',
    agentsDbId: 'db_agents_1',
    buildLogBlockId: 'block_1',
    buttonBlockId: 'block_btn_1',
  });

  // `vi.resetAllMocks` wipes the `mockResolvedValue` set in the factory
  // declarations above, so restore the @forge/db default returns here.
  const db = await import('@forge/db');
  vi.mocked(db.upsertWorkspace).mockResolvedValue({ id: 'ws_1' } as never);
  vi.mocked(db.prisma.workspace.findUnique).mockResolvedValue(null as never);
  vi.mocked(db.prisma.workspace.update).mockResolvedValue({} as never);
});

describe('POST /api/auth/notion/callback', () => {
  it('redirects to /agents on happy path', async () => {
    const { POST } = await import('@/app/api/auth/notion/callback/route');
    const res = await POST(
      makeRequest('http://localhost/api/auth/notion/callback', {
        method: 'POST',
      }) as never,
      makeCtx({}),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toContain('/agents');
  });

  it('returns 401 without Clerk session', async () => {
    const clerk = await import('@clerk/nextjs/server');
    vi.mocked(clerk.auth).mockResolvedValue({ userId: null } as never);
    const { POST } = await import('@/app/api/auth/notion/callback/route');
    const res = await POST(
      makeRequest('http://localhost/api/auth/notion/callback', {
        method: 'POST',
      }) as never,
      makeCtx({}),
    );
    expect(res.status).toBe(401);
  });

  it('returns 403 when no notion oauth token is on the user', async () => {
    getUserOauthAccessTokenMock.mockResolvedValue({ data: [] });
    const { POST } = await import('@/app/api/auth/notion/callback/route');
    const res = await POST(
      makeRequest('http://localhost/api/auth/notion/callback', {
        method: 'POST',
      }) as never,
      makeCtx({}),
    );
    expect(res.status).toBe(403);
  });

  it('returns 502 when workspace id missing from OAuth response', async () => {
    getUserOauthAccessTokenMock.mockResolvedValue({
      data: [{ token: 'ntoken' }],
    });
    const { POST } = await import('@/app/api/auth/notion/callback/route');
    const res = await POST(
      makeRequest('http://localhost/api/auth/notion/callback', {
        method: 'POST',
      }) as never,
      makeCtx({}),
    );
    expect(res.status).toBe(502);
  });

  it('still redirects when the installer throws', async () => {
    const installer = await import('@forge/installer');
    vi.mocked(installer.installForgePage).mockRejectedValue(
      new Error('notion 500'),
    );
    const { POST } = await import('@/app/api/auth/notion/callback/route');
    const res = await POST(
      makeRequest('http://localhost/api/auth/notion/callback', {
        method: 'POST',
      }) as never,
      makeCtx({}),
    );
    expect(res.status).toBe(303);
  });

  it('redirects to /onboarding/pick-parent when installer fails on missing parent page', async () => {
    const installer = await import('@forge/installer');
    vi.mocked(installer.installForgePage).mockRejectedValue(
      new StubInstallerError('parentPageId is required', {
        step: 'create-root-page',
        workspaceId: 'ws_1',
      }),
    );
    const { POST } = await import('@/app/api/auth/notion/callback/route');
    const res = await POST(
      makeRequest('http://localhost/api/auth/notion/callback', {
        method: 'POST',
      }) as never,
      makeCtx({}),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toContain('/onboarding/pick-parent');
  });
});
