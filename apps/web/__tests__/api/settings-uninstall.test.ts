/**
 * POST /api/settings/uninstall
 *   200 + { ok, redirect } when caller is the owner and confirm string matches
 *   400 when confirm string is wrong / missing
 *   403 when caller is not the workspace owner
 *   502 when the underlying installer call throws
 *   401 without session
 *
 * The handler also retracts every non-retracted agent for the workspace
 * and writes a `workspace.uninstalled` audit log. We assert both.
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
    workspace: { findUnique: vi.fn(), update: vi.fn() },
    generatedAgent: { updateMany: vi.fn() },
  },
  recordAuditEvent: vi.fn(),
}));

vi.mock('@forge/installer', () => ({
  uninstallForgePage: vi.fn(),
}));

vi.mock('@/lib/notion', () => ({
  getNotionTokenForClerkUser: vi.fn(),
}));

vi.mock('@/lib/posthog', () => ({ capture: vi.fn() }));

const checkRateLimitMock = vi.fn();
vi.mock('@/lib/ratelimit', () => ({
  checkRateLimit: (...args: unknown[]) => checkRateLimitMock(...args),
  limiters: { agentMutation: () => ({}) },
}));

beforeEach(async () => {
  vi.resetAllMocks();
  vi.resetModules();
  const clerk = await import('@clerk/nextjs/server');
  vi.mocked(clerk.auth).mockResolvedValue({ userId: 'clerk_owner' } as never);
  const db = await import('@forge/db');
  vi.mocked(db.prisma.user.findUnique).mockResolvedValue({
    id: 'user_1',
    clerkId: 'clerk_owner',
    workspace: {
      id: 'ws_1',
      ownerUserId: 'clerk_owner',
      notionWorkspaceId: 'nws_1',
    },
  } as never);
  vi.mocked(db.prisma.generatedAgent.updateMany).mockResolvedValue({
    count: 3,
  } as never);
  const notion = await import('@/lib/notion');
  vi.mocked(notion.getNotionTokenForClerkUser).mockResolvedValue('tok_xyz');
  checkRateLimitMock.mockResolvedValue({
    success: true,
    reset: 0,
    remaining: 100,
    limit: 120,
  });
});

describe('POST /api/settings/uninstall', () => {
  it('returns 200 with redirect on a valid confirm + owner call', async () => {
    const { POST } = await import('@/app/api/settings/uninstall/route');
    const res = await POST(
      makeRequest('http://localhost/api/settings/uninstall', {
        method: 'POST',
        body: { confirm: 'UNINSTALL' },
      }) as never,
      makeCtx({}),
    );
    expect(res.status).toBe(200);
    const body = await readJson<{ ok: boolean; redirect: string }>(res);
    expect(body).toEqual({ ok: true, redirect: '/' });

    const installer = await import('@forge/installer');
    expect(installer.uninstallForgePage).toHaveBeenCalledTimes(1);

    const db = await import('@forge/db');
    expect(db.prisma.generatedAgent.updateMany).toHaveBeenCalledWith({
      where: { workspaceId: 'ws_1', status: { not: 'retracted' } },
      data: { status: 'retracted' },
    });
    expect(db.recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'workspace.uninstalled',
        resourceId: 'ws_1',
        metadata: {},
      }),
    );
  });

  it('returns 400 when confirm string is wrong', async () => {
    const { POST } = await import('@/app/api/settings/uninstall/route');
    const res = await POST(
      makeRequest('http://localhost/api/settings/uninstall', {
        method: 'POST',
        body: { confirm: 'yes' },
      }) as never,
      makeCtx({}),
    );
    expect(res.status).toBe(400);
    const installer = await import('@forge/installer');
    expect(installer.uninstallForgePage).not.toHaveBeenCalled();
  });

  it('returns 400 when confirm string is absent', async () => {
    const { POST } = await import('@/app/api/settings/uninstall/route');
    const res = await POST(
      makeRequest('http://localhost/api/settings/uninstall', {
        method: 'POST',
        body: {},
      }) as never,
      makeCtx({}),
    );
    expect(res.status).toBe(400);
  });

  it('returns 403 when caller is not the workspace owner', async () => {
    const db = await import('@forge/db');
    vi.mocked(db.prisma.user.findUnique).mockResolvedValue({
      id: 'user_2',
      clerkId: 'clerk_other',
      workspace: {
        id: 'ws_1',
        ownerUserId: 'clerk_owner',
        notionWorkspaceId: 'nws_1',
      },
    } as never);
    const clerk = await import('@clerk/nextjs/server');
    vi.mocked(clerk.auth).mockResolvedValue({ userId: 'clerk_other' } as never);
    const { POST } = await import('@/app/api/settings/uninstall/route');
    const res = await POST(
      makeRequest('http://localhost/api/settings/uninstall', {
        method: 'POST',
        body: { confirm: 'UNINSTALL' },
      }) as never,
      makeCtx({}),
    );
    expect(res.status).toBe(403);
    const installer = await import('@forge/installer');
    expect(installer.uninstallForgePage).not.toHaveBeenCalled();
  });

  it('returns 502 when the installer call fails', async () => {
    const installer = await import('@forge/installer');
    vi.mocked(installer.uninstallForgePage).mockRejectedValue(
      new Error('notion archive failed'),
    );
    const { POST } = await import('@/app/api/settings/uninstall/route');
    const res = await POST(
      makeRequest('http://localhost/api/settings/uninstall', {
        method: 'POST',
        body: { confirm: 'UNINSTALL' },
      }) as never,
      makeCtx({}),
    );
    expect(res.status).toBe(502);
  });

  it('returns 401 without session', async () => {
    const clerk = await import('@clerk/nextjs/server');
    vi.mocked(clerk.auth).mockResolvedValue({ userId: null } as never);
    const { POST } = await import('@/app/api/settings/uninstall/route');
    const res = await POST(
      makeRequest('http://localhost/api/settings/uninstall', {
        method: 'POST',
        body: { confirm: 'UNINSTALL' },
      }) as never,
      makeCtx({}),
    );
    expect(res.status).toBe(401);
  });
});
