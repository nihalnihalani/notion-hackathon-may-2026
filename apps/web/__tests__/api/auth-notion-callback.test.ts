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
  prisma: { user: { upsert: vi.fn() } },
  upsertWorkspace: vi.fn().mockResolvedValue({ id: 'ws_1' }),
  recordAuditEvent: vi.fn(),
}));

vi.mock('@/lib/installer', () => ({
  installForgePage: vi.fn(),
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

  const installer = await import('@/lib/installer');
  vi.mocked(installer.installForgePage).mockResolvedValue({
    forgePageId: 'page_1',
    forgeDbId: 'db_1',
    buildLogBlockId: 'block_1',
  });
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
    const installer = await import('@/lib/installer');
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
});
