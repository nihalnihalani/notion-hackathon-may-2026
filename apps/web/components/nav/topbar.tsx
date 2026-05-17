'use client';

/**
 * Top bar — workspace label + Clerk UserButton + mobile menu trigger.
 *
 * The workspace name is passed in as a prop from the server-rendered layout
 * so we don't double-fetch it on the client. The OrganizationSwitcher is
 * intentionally omitted (Forge is a single-Notion-workspace product, see
 * PLAN.md §V — one `Workspace` per Notion workspace).
 */
import Link from 'next/link';
import { UserButton } from '@clerk/nextjs';
import { Menu, Plus, Sparkles } from 'lucide-react';

import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { SidebarNav } from '@/components/nav/sidebar-nav';

interface TopbarProps {
  workspaceName: string;
  forgePageUrl?: string | null;
}

export function Topbar({ workspaceName, forgePageUrl }: TopbarProps) {
  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border bg-background/80 px-4 backdrop-blur md:px-6">
      <Sheet>
        <SheetTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="md:hidden"
            aria-label="Open navigation"
          >
            <Menu className="h-5 w-5" />
          </Button>
        </SheetTrigger>
        <SheetContent side="left" className="w-60 p-0">
          <SidebarNav className="border-r-0" />
        </SheetContent>
      </Sheet>

      <Link href="/dashboard" className="flex items-center gap-2 md:hidden">
        <div className="flex h-6 w-6 items-center justify-center rounded-md bg-forge-gradient">
          <Sparkles className="h-3.5 w-3.5 text-primary-foreground" aria-hidden="true" />
        </div>
        <span className="text-sm font-semibold">Forge</span>
      </Link>

      <div className="ml-auto flex items-center gap-2 sm:gap-3 md:gap-4">
        <div className="hidden text-sm text-muted-foreground lg:block">
          <span className="text-foreground">{workspaceName}</span>
        </div>
        <Button asChild variant="forge" size="sm" className="gap-1.5">
          <Link href="/dashboard/new" aria-label="Forge a new agent">
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="hidden sm:inline">New agent</span>
            <span className="sm:hidden">New</span>
          </Link>
        </Button>
        {forgePageUrl ? (
          <Button asChild variant="outline" size="sm" className="hidden sm:inline-flex">
            <a href={forgePageUrl} target="_blank" rel="noreferrer noopener">
              Open in Notion
            </a>
          </Button>
        ) : null}
        <UserButton />
      </div>
    </header>
  );
}
