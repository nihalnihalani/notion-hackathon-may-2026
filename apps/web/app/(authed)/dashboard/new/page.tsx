import Link from 'next/link';
import { redirect } from 'next/navigation';
import { currentUser } from '@clerk/nextjs/server';
import { ArrowLeft, BookOpen, Mic, Sparkles, Wand2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { NewAgentForm } from '@/components/dashboard/new-agent-form';
import { prisma } from '@/lib/db';

/**
 * Server entry point for `/dashboard/new`.
 *
 * Renders the page chrome + tips and delegates the actual form (which is
 * client-side because it owns submit state + voice input MediaRecorder) to
 * {@link NewAgentForm}.
 *
 * If the user is signed in but hasn't completed install (no `User` row, or
 * no `forgeBuildLogBlockId` on their workspace), we surface a friendly
 * "finish install first" CTA — the trigger API would reject them anyway,
 * and bouncing through it is a worse UX than telling them up front.
 */
export const dynamic = 'force-dynamic';

export default async function NewAgentPage() {
  const user = await currentUser();
  if (!user) redirect('/');

  const dbUser = await prisma.user.findUnique({
    where: { clerkId: user.id },
    include: {
      workspace: {
        select: { forgeBuildLogBlockId: true, notionWorkspaceId: true },
      },
    },
  });

  const installComplete = Boolean(
    dbUser?.workspace.forgeBuildLogBlockId && dbUser.workspace.notionWorkspaceId,
  );

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Button
          asChild
          variant="ghost"
          size="sm"
          className="-ml-2 h-7 gap-1.5 text-muted-foreground"
        >
          <Link href="/dashboard">
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
            Back to overview
          </Link>
        </Button>
        <header className="space-y-1">
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight md:text-3xl">
            <Sparkles className="h-5 w-5 text-primary" aria-hidden="true" />
            Forge a new agent
          </h1>
          <p className="text-sm text-muted-foreground">
            Describe what you want and Forge ships a real, deployed Notion Custom Agent in about 90
            seconds.
          </p>
        </header>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Describe</CardTitle>
            <CardDescription>Plain English — the orchestrator handles the rest.</CardDescription>
          </CardHeader>
          <CardContent>
            {installComplete ? (
              <NewAgentForm />
            ) : (
              <FinishInstallNotice
                href={dbUser ? '/onboarding/pick-parent' : '/api/auth/notion/start'}
              />
            )}
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Wand2 className="h-4 w-4 text-primary" aria-hidden="true" />
                Tips for a great description
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-muted-foreground">
              <Tip>
                Name the trigger. &ldquo;When a Linear issue is labeled
                <em> P0</em>&hellip;&rdquo; signals a webhook agent; &ldquo;Every Monday at
                9am&hellip;&rdquo; signals a scheduled agent.
              </Tip>
              <Tip>
                Name the source + destination. Mention the Notion page, database, or external API
                the agent should read from and write back into.
              </Tip>
              <Tip>
                Be explicit about format. &ldquo;Post a bullet list with severity, owner, and a
                link.&rdquo;
              </Tip>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Mic className="h-4 w-4 text-primary" aria-hidden="true" />
                Voice input
              </CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              Click the mic and dictate — your transcript appends to the draft so you can keep
              typing afterwards. Microphone permission is requested on first use.
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <BookOpen className="h-4 w-4 text-primary" aria-hidden="true" />
                Prefer Notion?
              </CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              Open <em>Forge Requests</em> in your Notion workspace and click the{' '}
              <strong>Forge this Agent</strong> button — same engine, same audit trail.
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Tip({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2">
      <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" aria-hidden="true" />
      <p className="leading-relaxed">{children}</p>
    </div>
  );
}

function FinishInstallNotice({ href }: { href: string }) {
  return (
    <div className="space-y-3 rounded-md border border-border bg-muted/30 p-4 text-sm">
      <p className="font-medium">Finish installing Forge first</p>
      <p className="text-muted-foreground">
        Forge needs to know about your Notion workspace before it can build agents for you.
      </p>
      <Button asChild size="sm">
        <Link href={href}>{href.startsWith('/api/') ? 'Connect Notion' : 'Finish install'}</Link>
      </Button>
    </div>
  );
}
