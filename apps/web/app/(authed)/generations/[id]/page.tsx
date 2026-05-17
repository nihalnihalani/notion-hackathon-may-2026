import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { currentUser } from '@clerk/nextjs/server';
import { ArrowLeft, ExternalLink } from 'lucide-react';

import { BuildLog, type BuildLogStep } from '@/components/generations/build-log';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { ReRunButton } from '@/components/generations/re-run-button';
import { StatusBadge } from '@/components/shared/status-badge';
import { AGENT_PATTERN_LABEL } from '@/lib/colors';
import { getGenerationWithSteps, prisma } from '@/lib/db';
import {
  formatAbsoluteDate,
  formatDuration,
  formatUsd,
} from '@/lib/formatters';

export const dynamic = 'force-dynamic';

/**
 * Generation detail / debug view.
 *
 * Same Build Log as the Notion-side view, plus raw step JSON for debugging.
 * Re-run button hits /api/forge/trigger with force=true.
 */
export default async function GenerationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await currentUser();
  if (!user) redirect('/');

  const dbUser = await prisma.user.findUnique({
    where: { clerkId: user.id },
    select: { workspaceId: true },
  });
  if (!dbUser) notFound();

  const generation = await getGenerationWithSteps(id);
  if (!generation || generation.workspaceId !== dbUser.workspaceId) {
    notFound();
  }

  const steps: BuildLogStep[] = generation.steps.map((s) => ({
    id: s.id,
    agent: s.agent,
    attempt: s.attempt,
    status: s.status,
    modelUsed: s.modelUsed,
    promptTokens: s.promptTokens,
    completionTokens: s.completionTokens,
    costUsd: s.costUsd ? Number(s.costUsd) : null,
    latencyMs: s.latencyMs,
    startedAt: s.startedAt.toISOString(),
    completedAt: s.completedAt ? s.completedAt.toISOString() : null,
    inputJson: s.inputJson,
    outputJson: s.outputJson,
    errorJson: s.errorJson,
  }));

  return (
    <div className="space-y-6">
      <Button asChild variant="ghost" size="sm" className="-ml-3 gap-1">
        <Link href="/dashboard">
          <ArrowLeft className="h-4 w-4" /> Back to overview
        </Link>
      </Button>

      <Card>
        <CardHeader className="space-y-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="space-y-2">
              <CardTitle className="text-xl">
                {generation.description}
              </CardTitle>
              <CardDescription>
                Started{' '}
                <time dateTime={generation.startedAt.toISOString()}>
                  {formatAbsoluteDate(generation.startedAt)}
                </time>
                {generation.completedAt
                  ? ` · finished ${formatAbsoluteDate(generation.completedAt)}`
                  : ''}
              </CardDescription>
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <StatusBadge
                  kind="generation"
                  status={generation.status}
                />
                {generation.pattern ? (
                  <span className="text-xs text-muted-foreground">
                    {AGENT_PATTERN_LABEL[generation.pattern]}
                  </span>
                ) : null}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {generation.agentId ? (
                <Button asChild variant="outline" size="sm">
                  <Link
                    href={`/agents/${generation.agentId}`}
                    className="gap-1"
                  >
                    <ExternalLink className="h-3.5 w-3.5" /> View agent
                  </Link>
                </Button>
              ) : null}
              <ReRunButton generationId={generation.id} />
            </div>
          </div>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-3">
          <SummaryStat
            label="Steps"
            value={generation.steps.length.toString()}
          />
          <SummaryStat
            label="Total latency"
            value={formatDuration(generation.totalLatencyMs)}
          />
          <SummaryStat
            label="Total cost"
            value={formatUsd(
              generation.totalCostUsd ? Number(generation.totalCostUsd) : null
            )}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Build log</CardTitle>
          <CardDescription>
            Click any step to view raw input, output, and error JSON.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <BuildLog steps={steps} />
        </CardContent>
      </Card>
    </div>
  );
}

function SummaryStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-muted/30 p-3">
      <p className="text-xs uppercase tracking-widest text-muted-foreground">
        {label}
      </p>
      <p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
    </div>
  );
}
