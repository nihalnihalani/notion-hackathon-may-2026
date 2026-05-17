import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { currentUser } from '@clerk/nextjs/server';
import {
  Coins,
  Database,
  KeyRound,
  Paintbrush,
  Plug,
  ShieldAlert,
  Sparkles,
} from 'lucide-react';

import { ApiKeysCard, type ApiKeyRow } from '@/components/settings/api-keys-card';
import { DangerZone } from '@/components/settings/danger-zone';
import { ModelSelector, type DefaultModel } from '@/components/settings/model-selector';
import { ThemeToggle } from '@/components/settings/theme-toggle';
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
import { EmptyState } from '@/components/shared/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { prisma } from '@/lib/db';
import {
  formatCount,
  formatUsd,
} from '@/lib/formatters';

export const dynamic = 'force-dynamic';

const OAUTH_PROVIDERS = [
  { id: 'notion', label: 'Notion', alwaysOn: true },
  { id: 'github', label: 'GitHub' },
  { id: 'linear', label: 'Linear' },
  { id: 'stripe', label: 'Stripe' },
  { id: 'slack', label: 'Slack' },
] as const;

/**
 * Settings page.
 *
 * Sections:
 *   1. Appearance (theme)
 *   2. Default model
 *   3. Connected OAuth providers
 *   4. API keys
 *   5. Billing (read-only meter)
 *   6. Workspace info
 *   7. Danger zone (uninstall)
 *
 * Each section is its own Card. Server data is fetched in the parent so
 * skeletons can be granular.
 */
export default async function SettingsPage() {
  const user = await currentUser();
  if (!user) redirect('/');

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">
          Settings
        </h1>
        <p className="text-sm text-muted-foreground">
          Configure your Forge workspace.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Paintbrush className="h-4 w-4" /> Appearance
          </CardTitle>
          <CardDescription>
            Defaults to your system preference.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ThemeToggle />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4" /> Default model
          </CardTitle>
          <CardDescription>
            Used by Tool Coder when a generation doesn&apos;t override it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Suspense fallback={<Skeleton className="h-9 w-72" />}>
            <DefaultModelSection clerkUserId={user.id} />
          </Suspense>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Plug className="h-4 w-4" /> Connected providers
          </CardTitle>
          <CardDescription>
            Each provider grants Forge OAuth scopes its generated agents can
            call.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="grid gap-2 sm:grid-cols-2">
            {OAUTH_PROVIDERS.map((p) => {
              const alwaysOn = 'alwaysOn' in p && p.alwaysOn === true;
              return (
                <li
                  key={p.id}
                  className="flex items-center justify-between rounded-md border border-border bg-card px-4 py-3"
                >
                  <span className="flex items-center gap-2 font-medium">
                    {p.label}
                    {alwaysOn ? (
                      <Badge variant="success">Connected</Badge>
                    ) : null}
                  </span>
                  {alwaysOn ? (
                    <span className="text-xs text-muted-foreground">
                      Required
                    </span>
                  ) : (
                    <Button asChild variant="outline" size="sm">
                      <a href={`/api/oauth/${p.id}/start`}>Connect</a>
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="h-4 w-4" /> API keys
          </CardTitle>
          <CardDescription>
            For MCP clients (Claude Code, Cursor) to drive Forge.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Suspense
            fallback={
              <div className="space-y-2">
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
              </div>
            }
          >
            <ApiKeysSection clerkUserId={user.id} />
          </Suspense>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Coins className="h-4 w-4" /> Billing
          </CardTitle>
          <CardDescription>
            Current month usage. Free during the hackathon — paid plans
            coming soon.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Suspense fallback={<Skeleton className="h-24 w-full" />}>
            <BillingSection clerkUserId={user.id} />
          </Suspense>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Database className="h-4 w-4" /> Workspace
          </CardTitle>
          <CardDescription>Notion-side install details.</CardDescription>
        </CardHeader>
        <CardContent>
          <Suspense fallback={<Skeleton className="h-24 w-full" />}>
            <WorkspaceSection clerkUserId={user.id} />
          </Suspense>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-destructive">
            <ShieldAlert className="h-4 w-4" /> Danger zone
          </CardTitle>
          <CardDescription>Irreversible actions.</CardDescription>
        </CardHeader>
        <CardContent>
          <Suspense fallback={<Skeleton className="h-24 w-full" />}>
            <DangerZoneSection clerkUserId={user.id} />
          </Suspense>
        </CardContent>
      </Card>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

async function DefaultModelSection({
  clerkUserId,
}: {
  clerkUserId: string;
}) {
  const dbUser = await prisma.user.findUnique({
    where: { clerkId: clerkUserId },
    select: { workspace: { select: { defaultModel: true } } },
  });
  const initial = normalizeDefaultModel(dbUser?.workspace.defaultModel);
  return <ModelSelector initial={initial} />;
}

const ALLOWED_DEFAULT_MODELS: ReadonlySet<DefaultModel> = new Set([
  'auto',
  'claude-opus-4-7',
  'gpt-5-thinking-mini',
]);

function normalizeDefaultModel(value: string | null | undefined): DefaultModel {
  if (value && (ALLOWED_DEFAULT_MODELS as ReadonlySet<string>).has(value)) {
    return value as DefaultModel;
  }
  return 'auto';
}

async function ApiKeysSection({ clerkUserId }: { clerkUserId: string }) {
  // The Workspace doesn't yet have a `apiKeys` table — the contract docs
  // (PLAN §VI) describe MCP keys living in Upstash with metadata in DB. The
  // dashboard reads metadata via /api/settings/api-keys when that route
  // exists. Until then we render an empty list (the create flow still works
  // — the new-key UX is what users actually need on day one).
  const dbUser = await prisma.user.findUnique({
    where: { clerkId: clerkUserId },
    select: { workspaceId: true },
  });
  if (!dbUser) {
    return (
      <EmptyState
        icon={KeyRound}
        title="Install Forge to manage API keys"
      />
    );
  }
  const keys: ApiKeyRow[] = [];
  return <ApiKeysCard keys={keys} />;
}

async function BillingSection({ clerkUserId }: { clerkUserId: string }) {
  const dbUser = await prisma.user.findUnique({
    where: { clerkId: clerkUserId },
    select: { workspaceId: true },
  });
  if (!dbUser) {
    return (
      <p className="text-sm text-muted-foreground">
        Billing data appears once your workspace is installed.
      </p>
    );
  }

  const since = new Date();
  since.setDate(1);
  since.setHours(0, 0, 0, 0);

  const rows = await prisma.usageMeter.findMany({
    where: {
      workspaceId: dbUser.workspaceId,
      date: { gte: since },
    },
  });

  const generations = rows.reduce((s, r) => s + r.generationsCount, 0);
  const deploys = rows.reduce((s, r) => s + r.deploysCount, 0);
  const invocations = rows.reduce((s, r) => s + r.invocationsCount, 0);
  const cost = rows.reduce((s, r) => s + Number(r.totalLlmCostUsd), 0);

  return (
    <div className="grid gap-4 sm:grid-cols-4">
      <Stat label="Generations" value={formatCount(generations)} />
      <Stat label="Deploys" value={formatCount(deploys)} />
      <Stat label="Invocations" value={formatCount(invocations)} />
      <Stat label="LLM cost" value={formatUsd(cost)} />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-muted/30 p-3">
      <p className="text-xs uppercase tracking-widest text-muted-foreground">
        {label}
      </p>
      <p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
    </div>
  );
}

async function WorkspaceSection({ clerkUserId }: { clerkUserId: string }) {
  const dbUser = await prisma.user.findUnique({
    where: { clerkId: clerkUserId },
    include: { workspace: true },
  });
  if (!dbUser) {
    return (
      <p className="text-sm text-muted-foreground">
        Workspace not bound yet.
      </p>
    );
  }
  const ws = dbUser.workspace;
  const forgePageUrl = ws.forgePageId
    ? `https://www.notion.so/${ws.forgePageId.replace(/-/g, '')}`
    : null;

  return (
    <div className="space-y-3 text-sm">
      <Row label="Workspace name" value={ws.name} />
      <Row label="Notion workspace ID" value={ws.notionWorkspaceId} copy />
      {forgePageUrl ? (
        <Row label="Forge page" value={forgePageUrl} copy link />
      ) : null}
    </div>
  );
}

function Row({
  label,
  value,
  copy,
  link,
}: {
  label: string;
  value: string;
  copy?: boolean;
  link?: boolean;
}) {
  return (
    <div className="flex items-center justify-between rounded-md border border-border bg-card px-4 py-2">
      <div className="space-y-0.5">
        <p className="text-xs text-muted-foreground">{label}</p>
        {link ? (
          <a
            href={value}
            target="_blank"
            rel="noreferrer noopener"
            className="font-mono text-sm hover:underline"
          >
            {value}
          </a>
        ) : (
          <p className="font-mono text-sm">{value}</p>
        )}
      </div>
      {copy ? <CopyButton value={value} label="Copy" size="sm" variant="ghost" /> : null}
    </div>
  );
}

async function DangerZoneSection({ clerkUserId }: { clerkUserId: string }) {
  const dbUser = await prisma.user.findUnique({
    where: { clerkId: clerkUserId },
    include: { workspace: true },
  });
  if (!dbUser) {
    return (
      <p className="text-sm text-muted-foreground">
        Nothing to uninstall — Forge isn&apos;t linked to a workspace yet.
      </p>
    );
  }
  return <DangerZone workspaceName={dbUser.workspace.name} />;
}
