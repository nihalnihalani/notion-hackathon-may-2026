/**
 * GET /api/onboarding/pages
 *   200 happy path → pages[] + nextCursor
 *   200 with `q` forwards the query to Notion search
 *   200 with `cursor` forwards as start_cursor and de-paginates
 *   200 filters out archived + in_trash + database-parent pages
 *   400 on invalid query (limit > 100)
 *   401 without Clerk session
 *   403 when no Notion oauth token is on the user
 *   502 when Notion search throws
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
  },
}));

vi.mock('@forge/notion-client', () => ({
  search: vi.fn(),
}));

vi.mock('@/lib/notion', () => ({
  getNotionTokenForClerkUser: vi.fn(),
  buildNotionConfig: (token: string) => ({ token }),
}));

const fakeUser = {
  id: 'user_1',
  email: 'nihal@example.com',
  workspace: {
    id: 'ws_1',
    notionWorkspaceId: 'nws_1',
    name: 'Acme',
  },
};

function makePage(opts: {
  id: string;
  title?: string;
  archived?: boolean;
  in_trash?: boolean;
  parentType?: 'page_id' | 'database_id' | 'workspace' | 'block_id';
  icon?: unknown;
}): unknown {
  return {
    object: 'page',
    id: opts.id,
    archived: opts.archived ?? false,
    in_trash: opts.in_trash ?? false,
    url: `https://www.notion.so/${opts.id}`,
    icon: opts.icon ?? null,
    parent:
      opts.parentType === 'database_id'
        ? { type: 'database_id', database_id: 'db_x' }
        : opts.parentType === 'block_id'
          ? { type: 'block_id', block_id: 'blk_x' }
          : opts.parentType === 'workspace'
            ? { type: 'workspace', workspace: true }
            : { type: 'page_id', page_id: 'parent_x' },
    properties: {
      title: {
        type: 'title',
        title: [{ plain_text: opts.title ?? 'A Page' }],
      },
    },
  };
}

beforeEach(async () => {
  vi.resetAllMocks();
  vi.resetModules();

  const clerk = await import('@clerk/nextjs/server');
  vi.mocked(clerk.auth).mockResolvedValue({ userId: 'clerk_1' } as never);

  const db = await import('@forge/db');
  vi.mocked(db.prisma.user.findUnique).mockResolvedValue(fakeUser as never);

  const notion = await import('@/lib/notion');
  vi.mocked(notion.getNotionTokenForClerkUser).mockResolvedValue('ntoken');
});

describe('GET /api/onboarding/pages', () => {
  it('returns pages + nextCursor on the happy path', async () => {
    const nc = await import('@forge/notion-client');
    vi.mocked(nc.search).mockResolvedValue({
      object: 'list',
      results: [
        makePage({ id: 'p1', title: 'Roadmap' }),
        makePage({ id: 'p2', title: 'Sprint board' }),
      ],
      next_cursor: 'cursor-2',
      has_more: true,
    } as never);

    const { GET } = await import('@/app/api/onboarding/pages/route');
    const res = await GET(
      makeRequest('http://localhost/api/onboarding/pages') as never,
      makeCtx({}),
    );
    expect(res.status).toBe(200);
    const body = await readJson<{
      pages: Array<{ id: string; title: string }>;
      nextCursor: string | null;
    }>(res);
    expect(body.pages.map((p) => p.id)).toEqual(['p1', 'p2']);
    expect(body.pages[0]!.title).toBe('Roadmap');
    expect(body.nextCursor).toBe('cursor-2');
  });

  it('forwards the `q` query to Notion search', async () => {
    const nc = await import('@forge/notion-client');
    vi.mocked(nc.search).mockResolvedValue({
      object: 'list',
      results: [],
      next_cursor: null,
      has_more: false,
    } as never);

    const { GET } = await import('@/app/api/onboarding/pages/route');
    await GET(
      makeRequest('http://localhost/api/onboarding/pages?q=docs') as never,
      makeCtx({}),
    );

    expect(nc.search).toHaveBeenCalledTimes(1);
    const callArgs = vi.mocked(nc.search).mock.calls[0]!;
    expect((callArgs[1] as { query?: string }).query).toBe('docs');
  });

  it('forwards the `cursor` query to Notion as start_cursor', async () => {
    const nc = await import('@forge/notion-client');
    vi.mocked(nc.search).mockResolvedValue({
      object: 'list',
      results: [],
      next_cursor: null,
      has_more: false,
    } as never);

    const { GET } = await import('@/app/api/onboarding/pages/route');
    await GET(
      makeRequest(
        'http://localhost/api/onboarding/pages?cursor=opaque-abc',
      ) as never,
      makeCtx({}),
    );

    const callArgs = vi.mocked(nc.search).mock.calls[0]!;
    expect((callArgs[1] as { start_cursor?: string }).start_cursor).toBe(
      'opaque-abc',
    );
  });

  it('filters out archived + in_trash + database-parented pages', async () => {
    const nc = await import('@forge/notion-client');
    vi.mocked(nc.search).mockResolvedValue({
      object: 'list',
      results: [
        makePage({ id: 'keep1', title: 'Keep me' }),
        makePage({ id: 'arch', title: 'Archived', archived: true }),
        makePage({ id: 'trash', title: 'In trash', in_trash: true }),
        makePage({
          id: 'dbrow',
          title: 'Database row',
          parentType: 'database_id',
        }),
        makePage({ id: 'keep2', title: 'Workspace root', parentType: 'workspace' }),
      ],
      next_cursor: null,
      has_more: false,
    } as never);

    const { GET } = await import('@/app/api/onboarding/pages/route');
    const res = await GET(
      makeRequest('http://localhost/api/onboarding/pages') as never,
      makeCtx({}),
    );
    expect(res.status).toBe(200);
    const body = await readJson<{ pages: Array<{ id: string }> }>(res);
    expect(body.pages.map((p) => p.id)).toEqual(['keep1', 'keep2']);
  });

  it('returns 400 on invalid query (limit > 100)', async () => {
    const { GET } = await import('@/app/api/onboarding/pages/route');
    const res = await GET(
      makeRequest('http://localhost/api/onboarding/pages?limit=500') as never,
      makeCtx({}),
    );
    expect(res.status).toBe(400);
  });

  it('returns 401 without a Clerk session', async () => {
    const clerk = await import('@clerk/nextjs/server');
    vi.mocked(clerk.auth).mockResolvedValue({ userId: null } as never);
    const { GET } = await import('@/app/api/onboarding/pages/route');
    const res = await GET(
      makeRequest('http://localhost/api/onboarding/pages') as never,
      makeCtx({}),
    );
    expect(res.status).toBe(401);
  });

  it('returns 403 when the user has no Notion OAuth token', async () => {
    const notion = await import('@/lib/notion');
    vi.mocked(notion.getNotionTokenForClerkUser).mockResolvedValue(null);
    const { GET } = await import('@/app/api/onboarding/pages/route');
    const res = await GET(
      makeRequest('http://localhost/api/onboarding/pages') as never,
      makeCtx({}),
    );
    expect(res.status).toBe(403);
  });

  it('returns 502 when Notion search throws', async () => {
    const nc = await import('@forge/notion-client');
    vi.mocked(nc.search).mockRejectedValue(new Error('notion exploded'));
    const { GET } = await import('@/app/api/onboarding/pages/route');
    const res = await GET(
      makeRequest('http://localhost/api/onboarding/pages') as never,
      makeCtx({}),
    );
    expect(res.status).toBe(502);
  });
});
