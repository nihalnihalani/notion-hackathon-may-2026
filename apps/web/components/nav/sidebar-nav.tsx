'use client';

/**
 * Sidebar navigation — pure presentation, client component because it reads
 * `usePathname()` to highlight the active route.
 *
 * The route list is exported so the topbar can reuse it for the mobile
 * sheet menu (single source of truth for nav items).
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Bot,
  GaugeCircle,
  History,
  Settings,
  Sparkles,
  TestTubes,
} from 'lucide-react';

import { cn } from '@/lib/utils';

export interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

export const NAV_ITEMS: ReadonlyArray<NavItem> = [
  { href: '/dashboard', label: 'Overview', icon: GaugeCircle },
  { href: '/agents', label: 'Agents', icon: Bot },
  { href: '/generations', label: 'Generations', icon: History },
  { href: '/evals', label: 'Evals', icon: TestTubes },
  { href: '/settings', label: 'Settings', icon: Settings },
];

export function SidebarNav({ className }: { className?: string }) {
  const pathname = usePathname();

  return (
    <aside
      className={cn(
        'flex h-full w-60 shrink-0 flex-col border-r border-border bg-card/40',
        className
      )}
    >
      <Link
        href="/dashboard"
        className="flex items-center gap-2 border-b border-border px-5 py-4"
      >
        <div className="flex h-7 w-7 items-center justify-center rounded-md bg-forge-gradient shadow-sm shadow-forge-primary/30">
          <Sparkles
            className="h-4 w-4 text-primary-foreground"
            aria-hidden="true"
          />
        </div>
        <span className="text-base font-semibold tracking-tight">Forge</span>
      </Link>

      <nav className="flex flex-col gap-0.5 p-3" aria-label="Main">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const active =
            pathname === item.href || pathname?.startsWith(`${item.href}/`);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'group flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                active
                  ? 'bg-accent text-accent-foreground'
                  : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
              )}
              aria-current={active ? 'page' : undefined}
            >
              <Icon
                className={cn(
                  'h-4 w-4 shrink-0',
                  active ? 'text-primary' : 'text-muted-foreground'
                )}
                aria-hidden="true"
              />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="mt-auto border-t border-border p-4 text-xs text-muted-foreground">
        <p>v0.1 · Notion Hackathon</p>
        <a
          href="https://github.com/nihalnihalani/notion-hackathon-may-2026"
          className="font-medium text-foreground hover:underline"
        >
          GitHub
        </a>
      </div>
    </aside>
  );
}
