import { Suspense } from 'react';
import Link from 'next/link';
import { currentUser } from '@clerk/nextjs/server';
import { redirect } from 'next/navigation';
import { ArrowRight, Bot, CircleCheck, Clock, Coins, TrendingUp, Zap } from 'lucide-react';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/shared/empty-state';
import { StatusBadge } from '@/components/shared/status-badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { prisma } from '@/lib/db';
import {
  computeSuccessRate,
  formatCount,
  formatDuration,
  formatPercent,
  formatRelativeDate,
  formatUsd,
} from '@/lib/formatters';
import { AGENT_PATTERN_LABEL } from '@/lib/colors';
import { TopPatternsChart } from '@/components/dashboard/top-patterns-chart';

/**
 * Overview dashboard.
 *
 * Each section is wrapped in its own Suspense boundary so the page streams
 * top-down: the page shell + section frames render immediately, with
 * skeletons replaced as each server-component data fetch resolves.
 *
 * Data sources (all read-only via @forge/db):
 *   - Aggregate counts → prisma.generation.count + groupBy
 *   - Top patterns    → prisma.generation.groupBy({by: ['pattern']})
 *   - Recent gens     → prisma.generation.findMany ordered by startedAt
 */
export const dynamic = 'force-dynamic';

export default async function OverviewPage() {
  const user = await currentUser();
  if (!user) redirect('/');
  const dbUser = await prisma.user.findUnique({
    where: { clerkId: user.id },
    select: { workspaceId: true },
  });
  if (!dbUser) {
    return <PendingInstallNotice />;
  }
  const workspaceId = dbUser.workspaceId;

  return (
    <div className="space-y-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Overview</h1>
        <p className="text-sm text-muted-foreground">
          A live look at every agent your workspace has forged.
        </p>
      </header>

      <Suspense fallback={<MetricsSkeleton />}>
        <MetricsRow workspaceId={workspaceId} />
      </Suspense>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Top patterns</CardTitle>
            <CardDescription>Which agent patterns your workspace generates most.</CardDescription>
          </CardHeader>
          <CardContent>
            <Suspense fallback={<Skeleton className="h-64 w-full" />}>
              <TopPatternsSection workspaceId={workspaceId} />
            </Suspense>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Latest activity</CardTitle>
            <CardDescription>Last 7 days</CardDescription>
          </CardHeader>
          <CardContent>
            <Suspense fallback={<Skeleton className="h-64 w-full" />}>
              <WeeklyActivity workspaceId={workspaceId} />
            </Suspense>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle>Recent generations</CardTitle>
            <CardDescription>The last 10 agent builds in your workspace.</CardDescription>
          </div>
          <Button asChild variant="ghost" size="sm" className="gap-1">
            <Link href="/agents">
              View all agents
              <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
            </Link>
          </Button>
        </CardHeader>
        <CardContent>
          <Suspense fallback={<TableSkeleton rows={5} />}>
            <RecentGenerationsTable workspaceId={workspaceId} />
          </Suspense>
        </CardContent>
      </Card>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components (server components — colocated for clarity)
// ─────────────────────────────────────────────────────────────────────────────

async function MetricsRow({ workspaceId }: { workspaceId: string }) {
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [totalCount, weekCount, succeededCount, succeededAgg] = await Promise.all([
    prisma.generation.count({ where: { workspaceId } }),
    prisma.generation.count({
      where: { workspaceId, startedAt: { gte: weekAgo } },
    }),
    prisma.generation.count({
      where: { workspaceId, status: 'succeeded' },
    }),
    prisma.generation.aggregate({
      where: { workspaceId, status: 'succeeded' },
      _avg: { totalLatencyMs: true, totalCostUsd: true },
    }),
  ]);

  const successRate = computeSuccessRate(succeededCount, totalCount);
  const avgLatencyMs = succeededAgg._avg.totalLatencyMs;
  const avgCostUsd = succeededAgg._avg.totalCostUsd;

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <MetricCard
        icon={Zap}
        label="Total generations"
        value={formatCount(totalCount)}
        sub={`${formatCount(weekCount)} this week`}
      />
      <MetricCard
        icon={CircleCheck}
        label="Success rate"
        value={formatPercent(successRate)}
        sub={`${formatCount(succeededCount)} succeeded`}
        accent={
          successRate !== null && successRate >= 0.9
            ? 'success'
            : successRate !== null && successRate < 0.5
              ? 'destructive'
              : 'default'
        }
      />
      <MetricCard
        icon={Clock}
        label="Avg latency"
        value={formatDuration(avgLatencyMs ? Number(avgLatencyMs) : null)}
        sub="Successful builds"
      />
      <MetricCard
        icon={Coins}
        label="Avg cost"
        value={formatUsd(avgCostUsd ? Number(avgCostUsd) : null)}
        sub="LLM + sandbox"
      />
    </div>
  );
}

function MetricCard({
  icon: Icon,
  label,
  value,
  sub,
  accent = 'default',
}: {
  icon: typeof Zap;
  label: string;
  value: string;
  sub: string;
  accent?: 'default' | 'success' | 'destructive';
}) {
  const accentClass =
    accent === 'success'
      ? 'text-success'
      : accent === 'destructive'
        ? 'text-destructive'
        : 'text-foreground';

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 p-5">
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>{label}</span>
          <Icon className="h-4 w-4" aria-hidden="true" />
        </div>
        <span className={`text-2xl font-semibold tracking-tight ${accentClass}`}>{value}</span>
        <span className="text-xs text-muted-foreground">{sub}</span>
      </CardContent>
    </Card>
  );
}

async function TopPatternsSection({ workspaceId }: { workspaceId: string }) {
  const rows = await prisma.generation.groupBy({
    by: ['pattern'],
    where: { workspaceId, pattern: { not: null } },
    _count: { _all: true },
    orderBy: { _count: { pattern: 'desc' } },
    take: 5,
  });

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={TrendingUp}
        title="No patterns yet"
        description="Once you forge an agent, the most-used patterns will show up here."
      />
    );
  }

  const data = rows
    .filter((r): r is typeof r & { pattern: NonNullable<typeof r.pattern> } => r.pattern !== null)
    .map((r) => ({
      name: AGENT_PATTERN_LABEL[r.pattern],
      count: r._count._all,
    }));

  return <TopPatternsChart data={data} />;
}

async function WeeklyActivity({ workspaceId }: { workspaceId: string }) {
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const [succeeded, failed, running] = await Promise.all([
    prisma.generation.count({
      where: {
        workspaceId,
        status: 'succeeded',
        startedAt: { gte: weekAgo },
      },
    }),
    prisma.generation.count({
      where: { workspaceId, status: 'failed', startedAt: { gte: weekAgo } },
    }),
    prisma.generation.count({
      where: {
        workspaceId,
        status: { in: ['queued', 'running'] },
      },
    }),
  ]);

  const total = succeeded + failed + running;
  if (total === 0) {
    return (
      <EmptyState icon={Bot} title="Quiet week" description="No generations in the last 7 days." />
    );
  }

  return (
    <ul className="space-y-3 text-sm">
      <ActivityRow label="Succeeded" value={succeeded} tone="success" />
      <ActivityRow label="Failed" value={failed} tone="destructive" />
      <ActivityRow label="In flight" value={running} tone="accent" />
    </ul>
  );
}

function ActivityRow({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'success' | 'destructive' | 'accent';
}) {
  const dot =
    tone === 'success' ? 'bg-success' : tone === 'destructive' ? 'bg-destructive' : 'bg-primary';
  return (
    <li className="flex items-center justify-between rounded-md border border-border bg-card/40 px-3 py-2">
      <span className="flex items-center gap-2">
        <span className={`h-2 w-2 rounded-full ${dot}`} aria-hidden="true" />
        {label}
      </span>
      <span className="font-medium tabular-nums">{formatCount(value)}</span>
    </li>
  );
}

async function RecentGenerationsTable({ workspaceId }: { workspaceId: string }) {
  const rows = await prisma.generation.findMany({
    where: { workspaceId },
    orderBy: { startedAt: 'desc' },
    take: 10,
    select: {
      id: true,
      description: true,
      status: true,
      pattern: true,
      startedAt: true,
      completedAt: true,
      totalLatencyMs: true,
      totalCostUsd: true,
    },
  });

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={Zap}
        title="No generations yet"
        description="Add a row to Forge Requests in Notion and click ⚡ Forge this Agent to get started."
      />
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Description</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Pattern</TableHead>
          <TableHead className="text-right">Latency</TableHead>
          <TableHead className="text-right">Cost</TableHead>
          <TableHead className="text-right">Started</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.id}>
            <TableCell className="max-w-md truncate font-medium">
              <Link href={`/generations/${r.id}`} className="hover:underline">
                {r.description}
              </Link>
            </TableCell>
            <TableCell>
              <StatusBadge kind="generation" status={r.status} />
            </TableCell>
            <TableCell className="text-muted-foreground">
              {r.pattern ? AGENT_PATTERN_LABEL[r.pattern] : '—'}
            </TableCell>
            <TableCell className="text-right tabular-nums text-muted-foreground">
              {formatDuration(r.totalLatencyMs)}
            </TableCell>
            <TableCell className="text-right tabular-nums text-muted-foreground">
              {formatUsd(r.totalCostUsd ? Number(r.totalCostUsd) : null)}
            </TableCell>
            <TableCell className="text-right text-muted-foreground">
              {formatRelativeDate(r.startedAt)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Fallbacks
// ─────────────────────────────────────────────────────────────────────────────

function MetricsSkeleton() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {[0, 1, 2, 3].map((i) => (
        <Card key={i}>
          <CardContent className="space-y-3 p-5">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-7 w-28" />
            <Skeleton className="h-3 w-20" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function TableSkeleton({ rows }: { rows: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-10 w-full" />
      ))}
    </div>
  );
}

function PendingInstallNotice() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Finish installing Forge</h1>
      <p className="max-w-prose text-muted-foreground">
        Your Notion workspace isn&apos;t linked yet. Open Settings and re-trigger the install flow
        to get started.
      </p>
      <Button asChild>
        <Link href="/settings">Go to Settings</Link>
      </Button>
    </div>
  );
}
