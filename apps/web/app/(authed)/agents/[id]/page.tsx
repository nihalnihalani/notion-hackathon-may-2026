import { Suspense } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { currentUser } from '@clerk/nextjs/server';
import { ArrowLeft, Loader2 } from 'lucide-react';

import { AgentActions } from '@/components/agents/agent-actions';
import { AgentRuns } from '@/components/agents/agent-runs';
import { AgentSourceViewer } from '@/components/agents/agent-source-viewer';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { CopyButton } from '@/components/shared/copy-button';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/shared/status-badge';
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs';
import {
  Avatar,
  AvatarFallback,
} from '@/components/ui/avatar';
import { prisma } from '@/lib/db';
import { AGENT_PATTERN_LABEL } from '@/lib/colors';

export const dynamic = 'force-dynamic';

/**
 * Agent detail page.
 *
 * Hero: avatar + name + status + actions.
 * Below: deploy/webhook URLs with copy buttons.
 * Tabs:  Runs (live fetch) · Source · Logs (placeholder until logs endpoint).
 */
export default async function AgentDetailPage({
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

  const agent = await prisma.generatedAgent.findUnique({
    where: { id },
  });
  if (!agent || agent.workspaceId !== dbUser.workspaceId) notFound();

  const initials = agent.ntnWorkerName
    .split(/[-_\s]+/)
    .map((s) => s[0]?.toUpperCase() ?? '')
    .slice(0, 2)
    .join('');

  return (
    <div className="space-y-6">
      <Button
        asChild
        variant="ghost"
        size="sm"
        className="gap-1 -ml-3"
      >
        <Link href="/agents">
          <ArrowLeft className="h-4 w-4" /> Back to agents
        </Link>
      </Button>

      <Card>
        <CardContent className="flex flex-col gap-6 p-6 md:flex-row md:items-center md:justify-between">
          <div className="flex items-start gap-4">
            {/*
              Avatar uses next/image for the MiniMax-generated picture so the
              CDN handles sizing/optimization. The Radix Avatar fallback still
              renders the initials when the image is missing or fails to load.
            */}
            {agent.avatarUrl ? (
              <div className="relative h-14 w-14 overflow-hidden rounded-xl">
                <Image
                  src={agent.avatarUrl}
                  alt={`${agent.ntnWorkerName} avatar`}
                  fill
                  sizes="56px"
                  className="object-cover"
                />
              </div>
            ) : (
              <Avatar className="h-14 w-14 rounded-xl">
                <AvatarFallback className="rounded-xl bg-forge-gradient text-primary-foreground">
                  {initials || 'AG'}
                </AvatarFallback>
              </Avatar>
            )}
            <div className="space-y-1.5">
              <h1 className="text-2xl font-semibold tracking-tight">
                {agent.ntnWorkerName}
              </h1>
              <p className="max-w-prose text-sm text-muted-foreground">
                {agent.description}
              </p>
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <StatusBadge kind="agent" status={agent.status} />
                <Badge variant="outline">
                  {AGENT_PATTERN_LABEL[agent.pattern]}
                </Badge>
                {agent.oauthProviders.map((p) => (
                  <Badge key={p} variant="muted">
                    {p}
                  </Badge>
                ))}
              </div>
            </div>
          </div>
          <AgentActions
            agentId={agent.id}
            agentName={agent.ntnWorkerName}
            status={agent.status}
          />
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <UrlCard
          title="Deploy URL"
          description="The live Worker endpoint Notion calls."
          url={agent.ntnDeployUrl}
        />
        <UrlCard
          title="Webhook URL"
          description="Use this to trigger the agent from outside Notion."
          url={agent.webhookUrl}
        />
      </div>

      <Tabs defaultValue="runs">
        <TabsList>
          <TabsTrigger value="runs">Runs</TabsTrigger>
          <TabsTrigger value="source">Source</TabsTrigger>
          <TabsTrigger value="logs">Logs</TabsTrigger>
        </TabsList>

        <TabsContent value="runs">
          <Card>
            <CardHeader>
              <CardTitle>Run history</CardTitle>
              <CardDescription>
                Most recent invocations from Notion or the webhook URL.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <AgentRuns agentId={agent.id} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="source">
          <Card>
            <CardHeader>
              <CardTitle>Generated source</CardTitle>
              <CardDescription>
                The TypeScript Worker shipped by Tool Coder, deployed via
                Shipper.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Suspense fallback={<SourceSkeleton />}>
                <AgentSource sourceBlobUrl={agent.sourceBlobUrl} />
              </Suspense>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="logs">
          <Card>
            <CardHeader>
              <CardTitle>Recent logs</CardTitle>
              <CardDescription>
                Stream of structured log lines from the deployed Worker.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="rounded-md border border-dashed border-border bg-muted/30 p-8 text-center text-sm text-muted-foreground">
                Live log streaming lands with the logs endpoint. Use the
                Vercel dashboard for raw Worker logs in the meantime.
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

    </div>
  );
}

function UrlCard({
  title,
  description,
  url,
}: {
  title: string;
  description: string;
  url: string | null;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        {url ? (
          <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2">
            <code className="flex-1 truncate font-mono text-xs">{url}</code>
            <CopyButton value={url} label="Copy" size="sm" variant="ghost" />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Not yet provisioned.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

async function AgentSource({ sourceBlobUrl }: { sourceBlobUrl: string }) {
  // Fetch the generated source server-side. Vercel Blob URLs are public-read
  // by default; we still go through the server so the client never holds
  // the Blob URL (mild defense against scraping).
  let source = '';
  let error: string | null = null;
  try {
    const res = await fetch(sourceBlobUrl, {
      // Cache at the data layer: source artifacts are immutable per agent
      // version, so the URL itself is a stable cache key.
      next: { revalidate: 60 * 60 },
    });
    if (!res.ok) {
      error = `Couldn't fetch source (HTTP ${res.status}).`;
    } else {
      source = await res.text();
    }
  } catch (e) {
    error = e instanceof Error ? e.message : 'Couldn’t fetch source.';
  }

  if (error) {
    return (
      <p className="text-sm text-destructive">{error}</p>
    );
  }
  if (!source.trim()) {
    return (
      <p className="text-sm text-muted-foreground">
        Source blob is empty — the Shipper likely failed mid-write.
      </p>
    );
  }
  return <AgentSourceViewer source={source} />;
}

function SourceSkeleton() {
  return (
    <div className="space-y-2">
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-72 w-full" />
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" /> Fetching source from
        Blob…
      </p>
    </div>
  );
}
