/**
 * /onboarding/pick-parent — choose the Notion page that will host Forge.
 *
 * The Notion REST API requires a parent page for `POST /v1/pages`; without
 * one, `@forge/installer` throws `InstallerError(step: 'create-root-page')`
 * and the OAuth callback bounces the user here.
 *
 * This server component:
 *   1. Resolves the caller's workspace via `requireWorkspace`. If the user
 *      somehow lacks a workspace row we send them back through sign-in.
 *   2. Short-circuits to `/dashboard` if Forge is already installed (we
 *      shouldn't get here, but the callback's pre-check could race a re-run).
 *   3. Pre-fetches the first page of the user's Notion pages on the server
 *      so first paint has real data — the client component then hydrates
 *      and takes over for search + pagination.
 *
 * The actual UX lives in the client `PagePicker` so search interactions
 * don't round-trip to the server.
 */

import { search } from '@forge/notion-client';
import type { NotionPage, SearchResult } from '@forge/notion-client';
import { redirect } from 'next/navigation';

import { PagePicker } from '@/components/onboarding/page-picker';
import type { PickerPage } from '@/components/onboarding/page-picker';
import { requireWorkspace } from '@/lib/auth';
import { buildNotionConfig, getNotionTokenForClerkUser } from '@/lib/notion';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function extractPageTitle(page: NotionPage): string {
  for (const value of Object.values(page.properties)) {
    if (
      value &&
      typeof value === 'object' &&
      'type' in value &&
      value.type === 'title' &&
      Array.isArray((value as { title?: unknown[] }).title)
    ) {
      const rt = (
        value as {
          title: Array<{ plain_text?: string; text?: { content?: string } }>;
        }
      ).title;
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

function buildBreadcrumb(page: NotionPage): string {
  switch (page.parent.type) {
    case 'workspace':
      return 'Workspace';
    case 'page_id':
      return 'Subpage';
    case 'database_id':
      return 'Database item';
    case 'block_id':
      return 'Nested';
    default:
      return '';
  }
}

function isPage(result: SearchResult): result is NotionPage {
  return result.object === 'page';
}

async function fetchInitialPages(token: string): Promise<{
  pages: PickerPage[];
  nextCursor: string | null;
  error: string | null;
}> {
  const config = buildNotionConfig(token);
  try {
    const resp = await search(config, {
      filter: { value: 'page' },
      page_size: 50,
      sort: { direction: 'descending', timestamp: 'last_edited_time' },
    });

    const pages: PickerPage[] = [];
    for (const result of resp.results) {
      if (!isPage(result)) continue;
      if (result.archived || result.in_trash) continue;
      if (result.parent.type === 'database_id') continue;
      pages.push({
        id: result.id,
        title: extractPageTitle(result),
        icon: normalizeIcon(result),
        breadcrumb: buildBreadcrumb(result),
        url: result.url,
        archived: result.archived,
        parentType: result.parent.type,
      });
    }

    return { pages, nextCursor: resp.next_cursor, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown';
    return { pages: [], nextCursor: null, error: message };
  }
}

export default async function PickParentPage(): Promise<React.ReactElement> {
  const r = await requireWorkspace();
  if (!r.ok) {
    // No workspace yet — send through sign-in / OAuth init.
    redirect('/sign-in');
  }
  const { clerkId, workspace } = r.ctx;

  // Belt-and-suspenders: if the workspace already has a forgePageId, the
  // install is done. The callback also short-circuits but a stale link
  // could land here.
  if (workspace.forgePageId) {
    redirect('/dashboard');
  }

  const token = await getNotionTokenForClerkUser(clerkId);

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 py-8">
      <header className="space-y-2">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Step 1 of 1 — finish setup
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">
          Choose where to install Forge
        </h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Forge will create a workspace inside the page you pick — a subpage
          with your Requests database, Build Log, and the &quot;Forge this
          Agent&quot; button. You can move or rename it later. Only pages you
          have shared with the Forge integration appear here.
        </p>
      </header>

      {!token ? (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm">
          <div className="font-medium text-destructive">
            We couldn&apos;t find your Notion access token.
          </div>
          <p className="mt-1 text-muted-foreground">
            Re-link your Notion workspace in{' '}
            <a className="underline" href="/sign-in">
              sign-in
            </a>{' '}
            and try again.
          </p>
        </div>
      ) : (
        <InitialPickerLoader token={token} workspaceName={workspace.name} />
      )}
    </div>
  );
}

async function InitialPickerLoader({
  token,
  workspaceName,
}: {
  token: string;
  workspaceName: string;
}): Promise<React.ReactElement> {
  const { pages, nextCursor, error } = await fetchInitialPages(token);

  if (error) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm">
        <div className="font-medium text-destructive">
          Couldn&apos;t list your Notion pages.
        </div>
        <p className="mt-1 text-muted-foreground">
          {error}. Try refreshing — if it keeps failing, re-link Notion from
          sign-in.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="rounded-lg border bg-muted/30 px-4 py-2 text-xs text-muted-foreground">
        Installing into{' '}
        <span className="font-medium text-foreground">{workspaceName}</span>
      </div>
      <PagePicker initialPages={pages} initialNextCursor={nextCursor} />
    </>
  );
}
