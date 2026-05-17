'use client';

/**
 * Page-picker — client component that drives the
 * `/onboarding/pick-parent` flow.
 *
 * Responsibilities:
 *   - Render a virtualized list of the user's Notion pages (workspaces can
 *     have thousands of pages, so we use `@tanstack/react-virtual` rather
 *     than mounting a DOM node per row).
 *   - Server-side search via `GET /api/onboarding/pages?q=…` — debounced
 *     250ms so we don't hammer Notion's 3 req/sec ceiling on every
 *     keystroke. The Vercel-side pacer in `buildNotionConfig` is a backstop;
 *     debouncing avoids the queue ever filling.
 *   - Two-pane layout: search/list on the left, preview of the selected page
 *     on the right.
 *   - Bottom "Install Forge" submit posts to `/api/onboarding/install` with
 *     the chosen `parentPageId` and redirects on success.
 *
 * Pagination: the API returns a Notion `next_cursor`. We auto-load the next
 * page when the user scrolls within ~5 rows of the bottom. There's no
 * "Load more" button — virtualization makes the manual UX awkward.
 *
 * Design choices:
 *   - The selected page persists across searches (the user might type a new
 *     query then change their mind). It's cleared only when the user
 *     explicitly picks a different page.
 *   - Errors render inline next to the submit button rather than via a
 *     toast — the user is mid-flow and shouldn't have to dismiss anything.
 */

import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronRight, FileText, Loader2, RefreshCw, Search } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

export interface PickerPage {
  id: string;
  title: string;
  icon: { type: 'emoji'; emoji: string } | { type: 'url'; url: string } | null;
  breadcrumb: string;
  url: string;
  archived: boolean;
  parentType: 'page_id' | 'database_id' | 'workspace' | 'block_id';
}

interface PagesResponse {
  pages: PickerPage[];
  nextCursor: string | null;
}

interface InstallResponse {
  ok?: boolean;
  redirect?: string;
  error?: string;
  message?: string;
}

interface PagePickerProps {
  initialPages: PickerPage[];
  initialNextCursor: string | null;
}

/** How close to the bottom (in rows) we trigger the next-page fetch. */
const PREFETCH_THRESHOLD_ROWS = 5;

/** Row height in pixels — must match the layout below. */
const ROW_HEIGHT = 64;

/**
 * Debounce a value: returns the input value but only after it's been stable
 * for `delayMs`. Used to coalesce keystrokes into one API call.
 */
function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const handle = setTimeout(() => {
      setDebounced(value);
    }, delayMs);
    return () => {
      clearTimeout(handle);
    };
  }, [value, delayMs]);
  return debounced;
}

function PageIcon({ page }: { page: PickerPage }) {
  if (page.icon?.type === 'emoji') {
    return (
      <span className="flex h-8 w-8 items-center justify-center text-xl">{page.icon.emoji}</span>
    );
  }
  if (page.icon?.type === 'url') {
    return <img src={page.icon.url} alt="" className="h-8 w-8 rounded object-cover" />;
  }
  return (
    <span className="flex h-8 w-8 items-center justify-center rounded bg-muted text-muted-foreground">
      <FileText className="h-4 w-4" />
    </span>
  );
}

export function PagePicker({
  initialPages,
  initialNextCursor,
}: PagePickerProps): React.ReactElement {
  // ── Search / list state ───────────────────────────────────────────────
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebouncedValue(query, 250);

  const [pages, setPages] = useState<PickerPage[]>(initialPages);
  const [nextCursor, setNextCursor] = useState<string | null>(initialNextCursor);
  const [isLoading, setIsLoading] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  // ── Selection / submit state ──────────────────────────────────────────
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isInstalling, setIsInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);

  const selectedPage = useMemo(
    () => pages.find((p) => p.id === selectedId) ?? null,
    [pages, selectedId],
  );

  // ── Search-triggered fetch ────────────────────────────────────────────
  //
  // We refetch on `debouncedQuery` changes; the initial render uses the
  // SSR-injected `initialPages` so first paint has data. Skip the very
  // first effect when query is empty AND pages already populated.
  const firstRunRef = useRef(true);
  useEffect(() => {
    if (firstRunRef.current && debouncedQuery === '') {
      firstRunRef.current = false;
      return;
    }
    firstRunRef.current = false;

    let cancelled = false;
    setIsLoading(true);
    setListError(null);

    const params = new URLSearchParams();
    if (debouncedQuery.length > 0) params.set('q', debouncedQuery);

    fetch(`/api/onboarding/pages?${params.toString()}`, {
      method: 'GET',
      cache: 'no-store',
    })
      .then(async (res) => {
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as InstallResponse;
          throw new Error(body.message ?? `Search failed (${res.status})`);
        }
        return (await res.json()) as PagesResponse;
      })
      .then((data) => {
        if (cancelled) return;
        setPages(data.pages);
        setNextCursor(data.nextCursor);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setListError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [debouncedQuery, refreshNonce]);

  // ── Pagination ────────────────────────────────────────────────────────
  const loadMore = useCallback(async () => {
    if (!nextCursor || isLoadingMore) return;
    setIsLoadingMore(true);
    try {
      const params = new URLSearchParams();
      if (debouncedQuery.length > 0) params.set('q', debouncedQuery);
      params.set('cursor', nextCursor);

      const res = await fetch(`/api/onboarding/pages?${params.toString()}`, {
        method: 'GET',
        cache: 'no-store',
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as InstallResponse;
        throw new Error(body.message ?? `Search failed (${res.status})`);
      }
      const data = (await res.json()) as PagesResponse;
      // De-dup by id in case Notion returns an overlap on cursor pages.
      setPages((prev) => {
        const seen = new Set(prev.map((p) => p.id));
        return [...prev, ...data.pages.filter((p) => !seen.has(p.id))];
      });
      setNextCursor(data.nextCursor);
    } catch (error) {
      setListError(error instanceof Error ? error.message : 'Failed to load more');
    } finally {
      setIsLoadingMore(false);
    }
  }, [debouncedQuery, nextCursor, isLoadingMore]);

  // ── Virtualizer ───────────────────────────────────────────────────────
  const parentRef = useRef<HTMLDivElement | null>(null);
  const rowVirtualizer = useVirtualizer({
    count: pages.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  });

  // Detect when we're near the bottom of the rendered window and prefetch.
  const virtualItems = rowVirtualizer.getVirtualItems();
  useEffect(() => {
    const last = virtualItems.at(-1);
    if (!last) return;
    if (last.index >= pages.length - 1 - PREFETCH_THRESHOLD_ROWS) {
      void loadMore();
    }
  }, [virtualItems, pages.length, loadMore]);

  // ── Submit ────────────────────────────────────────────────────────────
  const handleInstall = useCallback(async () => {
    if (!selectedId || isInstalling) return;
    setIsInstalling(true);
    setInstallError(null);
    try {
      const res = await fetch('/api/onboarding/install', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ parentPageId: selectedId }),
      });
      const body = (await res.json().catch(() => ({}))) as InstallResponse;
      if (!res.ok || !body.ok) {
        throw new Error(body.message ?? `Install failed (${res.status})`);
      }
      // Hard navigation — server components on /dashboard should re-fetch
      // the Workspace row with the freshly populated forgePageId.
      globalThis.location.href = body.redirect ?? '/dashboard';
    } catch (error) {
      setInstallError(error instanceof Error ? error.message : 'Install failed');
      setIsInstalling(false);
    }
  }, [selectedId, isInstalling]);

  // ── Render ────────────────────────────────────────────────────────────
  return (
    <div className="flex h-full min-h-[600px] flex-col gap-4">
      <div className="grid flex-1 grid-cols-1 gap-4 lg:grid-cols-[1fr_360px]">
        {/* ── Left pane: search + virtualized list ─────────────────── */}
        <section className="flex flex-col rounded-lg border bg-card">
          <div className="space-y-3 border-b p-3">
            <div className="relative">
              <Search
                aria-hidden
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                }}
                placeholder="Search your Notion pages..."
                className="pl-9"
                aria-label="Search Notion pages"
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-2"
                onClick={() => {
                  setRefreshNonce((value) => value + 1);
                  setListError(null);
                }}
                disabled={isLoading}
              >
                {isLoading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                )}
                Refresh
              </Button>
              <Button asChild type="button" variant="ghost" size="sm">
                <a href="/api/auth/notion/start">Connect more pages</a>
              </Button>
            </div>
          </div>

          <div className="relative flex-1">
            {isLoading && pages.length === 0 ? (
              <div className="space-y-2 p-3">
                {Array.from({ length: 6 }).map((_, i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </div>
            ) : listError ? (
              <div className="p-4 text-sm text-destructive">Failed to load pages: {listError}</div>
            ) : pages.length === 0 ? (
              <div className="space-y-3 p-6 text-center text-sm text-muted-foreground">
                <p>
                  {debouncedQuery
                    ? `No pages match "${debouncedQuery}".`
                    : 'No shared Notion pages found.'}
                </p>
                <Button asChild size="sm">
                  <a href="/api/auth/notion/start">Connect pages in Notion</a>
                </Button>
              </div>
            ) : (
              <div
                ref={parentRef}
                className="h-full max-h-[480px] overflow-auto"
                role="listbox"
                aria-label="Notion pages"
              >
                <div
                  style={{
                    height: `${rowVirtualizer.getTotalSize()}px`,
                    position: 'relative',
                    width: '100%',
                  }}
                >
                  {virtualItems.map((virtual) => {
                    const page = pages[virtual.index];
                    if (!page) return null;
                    const selected = page.id === selectedId;
                    return (
                      <button
                        key={page.id}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        onClick={() => {
                          setSelectedId(page.id);
                          setInstallError(null);
                        }}
                        style={{
                          position: 'absolute',
                          top: 0,
                          left: 0,
                          width: '100%',
                          height: `${virtual.size}px`,
                          transform: `translateY(${virtual.start}px)`,
                        }}
                        className={cn(
                          'flex w-full items-center gap-3 border-b px-3 py-2 text-left transition-colors hover:bg-accent/40 focus-visible:bg-accent/40 focus-visible:outline-none',
                          selected && 'bg-accent text-accent-foreground',
                        )}
                      >
                        <PageIcon page={page} />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium">{page.title}</div>
                          <div className="truncate text-xs text-muted-foreground">
                            {page.breadcrumb}
                          </div>
                        </div>
                        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                      </button>
                    );
                  })}
                </div>
                {isLoadingMore && (
                  <div className="flex items-center justify-center gap-2 p-3 text-xs text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    Loading more...
                  </div>
                )}
              </div>
            )}
          </div>
        </section>

        {/* ── Right pane: preview of selected ─────────────────────────── */}
        <aside className="flex flex-col rounded-lg border bg-card p-4">
          {selectedPage ? (
            <div className="flex flex-col gap-3">
              <div className="flex items-start gap-3">
                <PageIcon page={selectedPage} />
                <div className="min-w-0">
                  <div className="break-words text-base font-semibold">{selectedPage.title}</div>
                  <div className="text-xs text-muted-foreground">{selectedPage.breadcrumb}</div>
                </div>
              </div>

              <div className="rounded-md border border-dashed bg-muted/30 p-3 text-sm">
                <div className="font-medium">Forge will appear inside this page.</div>
                <p className="mt-1 text-xs text-muted-foreground">
                  We&apos;ll create a subpage called &quot;Forge — your agents, in plain
                  English&quot; with your Requests database, Build Log, and the &quot;Forge this
                  Agent&quot; button. You can move or rename it later.
                </p>
              </div>

              <a
                href={selectedPage.url}
                target="_blank"
                rel="noreferrer noopener"
                className="text-xs text-primary underline-offset-4 hover:underline"
              >
                Open in Notion
              </a>
            </div>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
              <FileText aria-hidden className="h-8 w-8 text-muted-foreground/50" />
              <div className="text-sm text-muted-foreground">
                Pick a page on the left to preview.
              </div>
            </div>
          )}
        </aside>
      </div>

      {/* ── Bottom action bar ─────────────────────────────────────────── */}
      <div className="flex items-center justify-between rounded-lg border bg-card p-3">
        <div className="text-xs text-muted-foreground">
          {installError ? (
            <span className="text-destructive">{installError}</span>
          ) : (
            <span>
              {selectedPage
                ? `Forge will install under "${selectedPage.title}".`
                : 'Select a page to enable Install Forge.'}
            </span>
          )}
        </div>
        <Button variant="forge" onClick={handleInstall} disabled={!selectedId || isInstalling}>
          {isInstalling ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Installing...
            </>
          ) : (
            'Install Forge'
          )}
        </Button>
      </div>
    </div>
  );
}
