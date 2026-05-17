import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { currentUser } from '@clerk/nextjs/server';

import { SidebarNav } from '@/components/nav/sidebar-nav';
import { Topbar } from '@/components/nav/topbar';
import { prisma } from '@/lib/db';

/**
 * Authed group layout.
 *
 * Responsibilities:
 *   1. Hard-redirect unauthenticated requests to /. The Clerk middleware
 *      already enforces this at the edge, but we double-check server-side
 *      so accidental middleware bypass (matcher misconfig) doesn't leak
 *      private screens.
 *   2. Resolve the Forge workspace once and pass surface fields to the
 *      topbar (avoids the topbar making its own roundtrip).
 *   3. Render the persistent sidebar + topbar + page container.
 *
 * If a session exists but no `User` row, we render the layout with a
 * "Pending install" workspace label rather than redirecting — this lets the
 * user reach Settings and re-trigger install.
 */
export default async function AuthedLayout({
  children,
}: {
  children: ReactNode;
}) {
  const user = await currentUser();
  if (!user) {
    redirect('/');
  }

  const dbUser = await prisma.user.findUnique({
    where: { clerkId: user.id },
    include: { workspace: true },
  });

  const workspaceName = dbUser?.workspace.name ?? 'Pending install';
  const forgePageUrl = dbUser?.workspace.forgePageId
    ? `https://www.notion.so/${dbUser.workspace.forgePageId.replace(/-/g, '')}`
    : null;

  return (
    <div className="flex min-h-screen bg-background">
      <SidebarNav className="hidden md:flex" />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar workspaceName={workspaceName} forgePageUrl={forgePageUrl} />
        <main className="flex-1">
          <div className="mx-auto w-full max-w-7xl px-4 py-6 md:px-8 md:py-10">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
