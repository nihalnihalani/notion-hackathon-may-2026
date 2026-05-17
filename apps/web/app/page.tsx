import Link from 'next/link';
import {
  SignInButton,
  SignedIn,
  SignedOut,
  UserButton,
} from '@clerk/nextjs';
import {
  ArrowRight,
  ClipboardList,
  Github,
  GitFork,
  Layers,
  ShieldCheck,
  Sparkles,
  Workflow,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { FeatureCard } from '@/components/marketing/feature-card';
import { Hero } from '@/components/marketing/hero';

/**
 * Landing page.
 *
 * Server component — fully renderable without JS. The auth-state branching
 * (Sign in / Open dashboard) goes through Clerk's `<SignedIn>` / `<SignedOut>`
 * which use the React context the `<ClerkProvider>` mounts at the root.
 *
 * Layout: nav → hero → "How it works" → feature grid → footer.
 */
export default function LandingPage() {
  return (
    <main className="flex min-h-screen flex-col">
      <header className="border-b border-border bg-background/80 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
          <Link href="/" className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-forge-gradient shadow-sm shadow-forge-primary/30">
              <Sparkles
                className="h-4 w-4 text-primary-foreground"
                aria-hidden="true"
              />
            </div>
            <span className="text-base font-semibold tracking-tight">
              Forge
            </span>
          </Link>
          <nav
            className="flex items-center gap-2 text-sm"
            aria-label="Primary"
          >
            <SignedIn>
              <Button asChild variant="ghost" size="sm">
                <Link href="/dashboard">Dashboard</Link>
              </Button>
              <UserButton afterSignOutUrl="/" />
            </SignedIn>
            <SignedOut>
              <Button asChild variant="ghost" size="sm">
                <a
                  href="https://github.com/nihalnihalani/notion-hackathon-may-2026"
                  className="inline-flex items-center gap-1.5"
                >
                  <Github className="h-4 w-4" aria-hidden="true" />
                  GitHub
                </a>
              </Button>
              <SignInButton mode="modal">
                <Button size="sm" variant="forge">
                  Sign in with Notion
                </Button>
              </SignInButton>
            </SignedOut>
          </nav>
        </div>
      </header>

      <Hero
        cta={
          <>
            <SignedOut>
              <SignInButton mode="modal">
                <Button size="lg" variant="forge" className="gap-2">
                  Sign in with Notion
                  <ArrowRight className="h-4 w-4" aria-hidden="true" />
                </Button>
              </SignInButton>
            </SignedOut>
            <SignedIn>
              <Button asChild size="lg" variant="forge" className="gap-2">
                <Link href="/dashboard">
                  Open dashboard
                  <ArrowRight className="h-4 w-4" aria-hidden="true" />
                </Link>
              </Button>
            </SignedIn>
            <Button asChild size="lg" variant="outline">
              <a
                href="https://github.com/nihalnihalani/notion-hackathon-may-2026"
                className="inline-flex items-center gap-2"
              >
                <Github className="h-4 w-4" aria-hidden="true" />
                Star on GitHub
              </a>
            </Button>
          </>
        }
      />

      <section
        className="border-y border-border bg-card/30 py-20"
        aria-labelledby="how-it-works"
      >
        <div className="mx-auto max-w-6xl px-6">
          <div className="mb-12 max-w-2xl space-y-2">
            <p className="text-sm font-semibold uppercase tracking-widest text-primary">
              How it works
            </p>
            <h2
              id="how-it-works"
              className="text-balance text-3xl font-semibold tracking-tight md:text-4xl"
            >
              From English to a deployed agent in three steps.
            </h2>
          </div>
          <ol className="grid gap-6 md:grid-cols-3">
            {[
              {
                step: '01',
                title: 'Describe',
                copy: 'Add a row to the Forge Requests database in Notion and describe the agent in plain English.',
              },
              {
                step: '02',
                title: 'Forge',
                copy: 'Click ⚡ Forge this Agent. Schema Smith plans, Tool Coder writes TS, Inspector runs it, Shipper deploys.',
              },
              {
                step: '03',
                title: 'Use it',
                copy: 'A live Notion Custom Agent appears in your workspace and starts answering. The Build Log streams in real time.',
              },
            ].map(({ step, title, copy }) => (
              <li
                key={step}
                className="relative overflow-hidden rounded-xl border border-border bg-background p-6"
              >
                <span className="text-xs font-mono uppercase tracking-widest text-primary">
                  {step}
                </span>
                <h3 className="mt-2 text-lg font-semibold tracking-tight">
                  {title}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  {copy}
                </p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="py-20" aria-labelledby="features">
        <div className="mx-auto max-w-6xl px-6">
          <div className="mb-12 max-w-2xl space-y-2">
            <p className="text-sm font-semibold uppercase tracking-widest text-primary">
              What you get
            </p>
            <h2
              id="features"
              className="text-balance text-3xl font-semibold tracking-tight md:text-4xl"
            >
              The first studio that treats Notion as the UI for agents.
            </h2>
          </div>
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            <FeatureCard
              icon={ClipboardList}
              title="Notion is the UI"
              description="No new app to learn. Forge lives as a page in your workspace — requests, build logs, and agent cards all in Notion."
            />
            <FeatureCard
              icon={Layers}
              title="Manager of agents"
              description="Four typed sub-agents — Schema Smith, Tool Coder, Inspector, Shipper — orchestrated by a Vercel Workflow DAG with full retries."
            />
            <FeatureCard
              icon={Workflow}
              title="Production deploys"
              description="The Inspector actually runs the generated Worker before declaring success. No fake demos — `ntn deploy` ships real Custom Agents."
            />
            <FeatureCard
              icon={ShieldCheck}
              title="Safety first"
              description="AST-checked forbidden APIs, sandboxed execution, OAuth scope minimization, audit-logged every deploy."
            />
          </div>
        </div>
      </section>

      <footer className="mt-auto border-t border-border bg-card/40">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 px-6 py-8 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <p>
            Built at the Notion Developer Platform Hackathon, May 2026. MIT
            licensed.
          </p>
          <div className="flex flex-wrap items-center gap-4">
            <a
              href="https://github.com/nihalnihalani/notion-hackathon-may-2026/blob/main/PLAN.md"
              className="font-medium text-foreground hover:underline"
            >
              PLAN.md
            </a>
            <a
              href="https://github.com/nihalnihalani/notion-hackathon-may-2026"
              className="inline-flex items-center gap-1 font-medium text-foreground hover:underline"
            >
              <GitFork className="h-3.5 w-3.5" aria-hidden="true" />
              Source
            </a>
            <a
              href="https://github.com/nihalnihalani/notion-hackathon-may-2026/blob/main/LICENSE"
              className="font-medium text-foreground hover:underline"
            >
              License
            </a>
          </div>
        </div>
      </footer>
    </main>
  );
}
