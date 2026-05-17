import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { currentUser } from '@clerk/nextjs/server';

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { AgentsTable, type AgentRow } from '@/components/agents/agents-table';
import { prisma } from '@/lib/db';

/**
 * /agents — full table of generated agents.
 *
 * The server fetches the rows via `findActiveAgentsByWorkspace` (with
 * `includeRetracted: true` so the "Retracted" filter chip has data to
 * select). We serialize Decimal+Date fields here so the client `AgentsTable`
 * can be a plain RSC payload.
 *
 * `monthlyCostUsd` is left as `null` for now — the per-agent cost rollup
 * requires joining UsageMeter, which we'll add in a follow-up once the
 * Stripe metering writes are wired up. Showing "—" today is honest.
 */
export const dynamic = 'force-dynamic';

export default async function AgentsPage() {
  const user = await currentUser();
  if (!user) redirect('/');

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">
          Agents
        </h1>
        <p className="text-sm text-muted-foreground">
          Every Custom Agent your workspace has deployed.
        </p>
      </header>
      <Card>
        <CardHeader>
          <CardTitle>Deployed agents</CardTitle>
          <CardDescription>
            Soft-deleted agents stay here under the Retracted filter for
            audit.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Suspense fallback={<AgentsTableSkeleton />}>
            <AgentsData clerkUserId={user.id} />
          </Suspense>
        </CardContent>
      </Card>
    </div>
  );
}

async function AgentsData({ clerkUserId }: { clerkUserId: string }) {
  const dbUser = await prisma.user.findUnique({
    where: { clerkId: clerkUserId },
    select: { workspaceId: true },
  });
  if (!dbUser) {
    return <AgentsTable agents={[]} />;
  }

  const rows = await prisma.generatedAgent.findMany({
    where: { workspaceId: dbUser.workspaceId },
    orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    select: {
      id: true,
      ntnWorkerName: true,
      description: true,
      pattern: true,
      status: true,
      lastInvokedAt: true,
      totalInvocations: true,
    },
  });

  const agents: AgentRow[] = rows.map((r) => ({
    id: r.id,
    ntnWorkerName: r.ntnWorkerName,
    description: r.description,
    pattern: r.pattern,
    status: r.status,
    lastInvokedAt: r.lastInvokedAt ? r.lastInvokedAt.toISOString() : null,
    totalInvocations: r.totalInvocations,
    // Per-agent monthly cost roll-up lands once Stripe metering is plumbed
    // (PLAN §VI billing webhook). Surface as null until then.
    monthlyCostUsd: null,
  }));

  return <AgentsTable agents={agents} />;
}

function AgentsTableSkeleton() {
  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-7 w-20 rounded-full" />
        ))}
      </div>
      {[0, 1, 2, 3, 4].map((i) => (
        <Skeleton key={i} className="h-10 w-full" />
      ))}
    </div>
  );
}
