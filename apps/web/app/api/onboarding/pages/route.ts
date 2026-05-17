/**
 * GET /api/onboarding/pages — list the Notion pages the integration can see.
 *
 * The pick-parent picker uses this to populate its virtualized list. We hit
 * Notion's `POST /v1/search` (filtered to `object=page`) on every keystroke
 * — workspace can have thousands of pages and we want server-side filtering
 * by `query` rather than fetching everything once and filtering in JS.
 *
 * Query params:
 *   - `q`       optional search string forwarded as `query` to Notion search.
 *               When omitted, Notion returns recent pages sorted by
 *               `last_edited_time` desc.
 *   - `cursor`  opaque Notion pagination cursor (echoed back from a prior
 *               response's `nextCursor`).
 *   - `limit`   page size 1..100, default 50. (Notion's hard max is 100.)
 *
 * Response shape:
 *   {
 *     pages: Array<{
 *       id: string;
 *       title: string;
 *       icon: { type: 'emoji', emoji: string } | { type: 'url', url: string } | null;
 *       breadcrumb: string;
 *       url: string;
 *       archived: boolean;
 *       parentType: 'page_id' | 'database_id' | 'workspace' | 'block_id';
 *     }>,
 *     nextCursor: string | null,
 *   }
 *
 * Auth: Clerk JWT + workspace bind via `requireWorkspace`. Forbidden if the
 * caller has not granted Notion OAuth (no token on the user).
 *
 * Failure mapping:
 *   - Notion 4xx/5xx → 502 `upstream_failure`
 *   - No Notion token → 403 `forbidden`
 *
 * Caveats:
 *   - Notion's search ranking is opaque. Database rows ("page in DB") are
 *     filtered out client-side here — they're technically pages, but the
 *     installer cannot create child pages under them (Notion REST disallows
 *     `parent.database_id` for page creation).
 *   - Archived/in-trash pages are filtered out so users can't pick a page
 *     about to be deleted.
 */

import { search } from '@forge/notion-client';
import type { NotionPage, SearchResult } from '@forge/notion-client';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { requireWorkspace } from '@/lib/auth';
import { apiError } from '@/lib/errors';
import { buildNotionConfig, getNotionTokenForClerkUser } from '@/lib/notion';
import { withSentry } from '@/lib/sentry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const querySchema = z.object({
  q: z.string().max(200).optional(),
  cursor: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
});

interface PickerPage {
  id: string;
  title: string;
  icon: { type: 'emoji'; emoji: string } | { type: 'url'; url: string } | null;
  breadcrumb: string;
  url: string;
  archived: boolean;
  parentType: 'page_id' | 'database_id' | 'workspace' | 'block_id';
}

/**
 * Pull the page's title out of `properties`. Notion's title property is
 * named whatever the user named it (commonly "Name" or "title"); the only
 * stable signal is `type === 'title'`.
 */
function extractPageTitle(page: NotionPage): string {
  for (const value of Object.values(page.properties)) {
    if (
      value &&
      typeof value === 'object' &&
      'type' in value &&
      value.type === 'title' &&
      Array.isArray((value as { title?: unknown[] }).title)
    ) {
      const rt = (value as { title: { plain_text?: string; text?: { content?: string } }[] }).title;
      const parts: string[] = [];
      for (const seg of rt) {
        if (typeof seg.plain_text === 'string') parts.push(seg.plain_text);
        else if (seg.text?.content) parts.push(seg.text.content);
      }
      const joined = parts.join('').trim();
      if (joined) return joined;
    }
  }
  return 'Untitled';
}

function normalizeIcon(page: NotionPage): PickerPage['icon'] {
  if (!page.icon) return null;
  if (page.icon.type === 'emoji') {
    return { type: 'emoji', emoji: page.icon.emoji };
  }
  if (page.icon.type === 'external') {
    return { type: 'url', url: page.icon.external.url };
  }
  if (page.icon.type === 'file') {
    return { type: 'url', url: page.icon.file.url };
  }
  return null;
}

function parentTypeOf(page: NotionPage): PickerPage['parentType'] {
  return page.parent.type;
}

/**
 * Build a short, human-readable breadcrumb. Notion's search response doesn't
 * include ancestor titles — fetching each would be N×roundtrips and Notion
 * doesn't expose a cheap "page path" endpoint. We surface the parent type as
 * a hint ("In workspace" / "Subpage" / "In database") which is what most
 * pickers in the wild do. The full path can be added later via the parent
 * page resolver.
 */
function buildBreadcrumb(page: NotionPage): string {
  switch (page.parent.type) {
    case 'workspace': {
      return 'Workspace';
    }
    case 'page_id': {
      return 'Subpage';
    }
    case 'database_id': {
      return 'Database item';
    }
    case 'block_id': {
      return 'Nested';
    }
    default: {
      return '';
    }
  }
}

function isPage(result: SearchResult): result is NotionPage {
  return result.object === 'page';
}

export const GET = withSentry(
  async (req) => {
    const r = await requireWorkspace();
    if (!r.ok) return r.response;
    const { clerkId } = r.ctx;

    const url = new URL(req.url);
    const parsed = querySchema.safeParse(Object.fromEntries(url.searchParams.entries()));
    if (!parsed.success) {
      return apiError('validation', 'Invalid query.', {
        issues: parsed.error.issues,
      });
    }
    const { q, cursor, limit } = parsed.data;

    const token = await getNotionTokenForClerkUser(clerkId);
    if (!token) {
      return apiError(
        'forbidden',
        'No Notion access token on this user. Re-link Notion in /sign-in.',
      );
    }

    const config = buildNotionConfig(token);
    let resp;
    try {
      resp = await search(config, {
        filter: { value: 'page' },
        ...(q !== undefined && q.length > 0 ? { query: q } : {}),
        ...(cursor === undefined ? {} : { start_cursor: cursor }),
        page_size: limit,
        // Always sort by last edited so blank-query pages are sensible.
        sort: { direction: 'descending', timestamp: 'last_edited_time' },
      });
    } catch (error) {
      // Surface upstream failure rather than 500 so the client can render a
      // typed error state. Sentry will capture via `withSentry`.
      const message = error instanceof Error ? error.message : 'notion search failed';
      return apiError('upstream_failure', `Notion search failed: ${message}`);
    }

    // Defensive: search can return databases when filter is omitted — keep
    // the type check so a future filter change doesn't leak DBs in.
    const pages: PickerPage[] = [];
    for (const result of resp.results) {
      if (!isPage(result)) continue;
      if (result.archived || result.in_trash) continue;
      // The installer cannot create a page under a database parent — Notion
      // REST requires `parent.page_id` for `POST /v1/pages` of a regular
      // page. Filter them out so the picker only shows valid candidates.
      if (result.parent.type === 'database_id') continue;
      pages.push({
        id: result.id,
        title: extractPageTitle(result),
        icon: normalizeIcon(result),
        breadcrumb: buildBreadcrumb(result),
        url: result.url,
        archived: result.archived,
        parentType: parentTypeOf(result),
      });
    }

    return NextResponse.json({
      pages,
      nextCursor: resp.next_cursor,
    });
  },
  { routeName: 'onboarding.pages' },
);
