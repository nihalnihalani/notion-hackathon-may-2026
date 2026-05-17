import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { currentUser } from '@clerk/nextjs/server';
import { TestTubes } from 'lucide-react';

import { FailureRow, type FailureRowData } from '@/components/evals/failure-row';
import { PassRateChart, type PassRatePoint } from '@/components/evals/pass-rate-chart';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { EmptyState } from '@/components/shared/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { prisma } from '@/lib/db';
import {
  computeSuccessRate,
  formatCount,
  formatPercent,
} from '@/lib/formatters';
import { AGENT_NAME_LABEL } from '@/lib/colors';
import type { AgentName } from '@forge/db';

const AGENT_NAMES: ReadonlyArray<AgentName> = [
  'schema_smith',
  'tool_coder',
  'inspector',
  'shipper',
];

export const dynamic = 'force-dynamic';

/**
 * /evals — Promptfoo-style eval trend.
 *
 * Evaluations is a global (cross-workspace) table — they measure the agent
 * harness itself, not per-tenant generations. Anyone with a Forge account
 * can see them; this is fine because the data is anonymized at write time
 * (only goldenInputHash, modelUsed, pass, diffJson).
 */
export default async function EvalsPage() {
  const user = await currentUser();
  if (!user) redirect('/');

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">
          Evals
        </h1>
        <p className="text-sm text-muted-foreground">
          How well each sub-agent is performing against the golden test set.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Pass-rate trend</CardTitle>
          <CardDescription>Last 30 days, by agent.</CardDescription>
        </CardHeader>
        <CardContent>
          <Suspense fallback={<Skeleton className="h-72 w-full" />}>
            <PassRateSection />
          </Suspense>
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-4">
        <Suspense fallback={<AgentStatsSkeleton />}>
          <AgentStats />
        </Suspense>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Recent failures</CardTitle>
          <CardDescription>Click any row to see the diff.</CardDescription>
        </CardHeader>
        <CardContent>
          <Suspense
            fallback={
              <div className="space-y-2">
                {[0, 1, 2].map((i) => (
                  <Skeleton key={i} className="h-10 w-full" />
                ))}
              </div>
            }
          >
            <FailuresTable />
          </Suspense>
        </CardContent>
      </Card>
    </div>
  );
}

async function PassRateSection() {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const rows = await prisma.evaluation.findMany({
    where: { runAt: { gte: since } },
    select: { agent: true, pass: true, runAt: true },
    orderBy: { runAt: 'asc' },
  });

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={TestTubes}
        title="No eval runs yet"
        description="Once Promptfoo runs against the golden set, the trend appears here."
      />
    );
  }

  // Bucket by day + agent.
  type Bucket = { date: string; rates: Partial<Record<AgentName, { pass: number; total: number }>> };
  const buckets = new Map<string, Bucket>();
  for (const r of rows) {
    const day = r.runAt.toISOString().slice(0, 10);
    let b = buckets.get(day);
    if (!b) {
      b = { date: day, rates: {} };
      buckets.set(day, b);
    }
    const slot = b.rates[r.agent] ?? { pass: 0, total: 0 };
    slot.total += 1;
    if (r.pass) slot.pass += 1;
    b.rates[r.agent] = slot;
  }

  const data: PassRatePoint[] = Array.from(buckets.values())
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((b) => {
      const rates: Partial<Record<AgentName, number>> = {};
      for (const [agent, v] of Object.entries(b.rates)) {
        const rate = computeSuccessRate(v!.pass, v!.total);
        if (rate !== null) rates[agent as AgentName] = rate;
      }
      return { date: b.date, rates };
    });

  return <PassRateChart data={data} />;
}

async function AgentStats() {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const results = await Promise.all(
    AGENT_NAMES.map(async (agent) => {
      const [total, passed] = await Promise.all([
        prisma.evaluation.count({ where: { agent, runAt: { gte: since } } }),
        prisma.evaluation.count({
          where: { agent, pass: true, runAt: { gte: since } },
        }),
      ]);
      return { agent, total, passed };
    })
  );

  return (
    <>
      {results.map(({ agent, total, passed }) => {
        const rate = computeSuccessRate(passed, total);
        return (
          <Card key={agent}>
            <CardContent className="space-y-2 p-5">
              <p className="text-sm text-muted-foreground">
                {AGENT_NAME_LABEL[agent]}
              </p>
              <p className="text-2xl font-semibold tabular-nums">
                {formatPercent(rate)}
              </p>
              <p className="text-xs text-muted-foreground">
                {formatCount(passed)} / {formatCount(total)} passed (30d)
              </p>
            </CardContent>
          </Card>
        );
      })}
    </>
  );
}

function AgentStatsSkeleton() {
  return (
    <>
      {[0, 1, 2, 3].map((i) => (
        <Card key={i}>
          <CardContent className="space-y-2 p-5">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-7 w-20" />
            <Skeleton className="h-3 w-32" />
          </CardContent>
        </Card>
      ))}
    </>
  );
}

async function FailuresTable() {
  const rows = await prisma.evaluation.findMany({
    where: { pass: false },
    orderBy: { runAt: 'desc' },
    take: 25,
    select: {
      id: true,
      agent: true,
      modelUsed: true,
      goldenInputHash: true,
      diffJson: true,
      runAt: true,
    },
  });

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={TestTubes}
        title="No failures recorded"
        description="Every eval in the last run passed."
      />
    );
  }

  const failures: FailureRowData[] = rows.map((r) => ({
    id: r.id,
    agent: r.agent,
    modelUsed: r.modelUsed,
    goldenInputHash: r.goldenInputHash,
    diffJson: r.diffJson,
    runAt: r.runAt.toISOString(),
  }));

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Agent</TableHead>
          <TableHead>Golden input</TableHead>
          <TableHead>Model</TableHead>
          <TableHead className="text-right">When</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {failures.map((f) => (
          <FailureRow key={f.id} row={f} />
        ))}
      </TableBody>
    </Table>
  );
}
