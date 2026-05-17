/**
 * Landing-page hero.
 *
 * Pure presentational server component — sign-in CTAs are rendered by the
 * page itself so it can use Clerk's `SignedIn` / `SignedOut` (which live in
 * the client boundary). Keeping the hero "dumb" lets the marketing copy
 * stay strictly in the server graph.
 */
import { ArrowRight } from 'lucide-react';

interface HeroProps {
  /** Slot for the auth CTAs (rendered by the page). */
  cta: React.ReactNode;
}

export function Hero({ cta }: HeroProps) {
  return (
    <section className="bg-forge-glow">
      <div className="mx-auto flex max-w-6xl flex-col items-start gap-8 px-6 pb-24 pt-20 sm:pt-28">
        <span className="inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/5 px-3 py-1 text-xs font-medium uppercase tracking-widest text-primary">
          <span className="h-1.5 w-1.5 rounded-full bg-primary" />
          Notion Custom Agent Studio
        </span>

        <h1 className="max-w-3xl text-balance text-5xl font-semibold leading-[1.05] tracking-tight md:text-6xl">
          Describe an agent in English.{' '}
          <span className="bg-forge-gradient bg-clip-text text-transparent">
            Ship it in 90 seconds.
          </span>
        </h1>

        <p className="max-w-2xl text-balance text-lg leading-relaxed text-muted-foreground">
          Forge is a Notion-native studio. Write what you want, click
          <span className="px-1 font-medium text-foreground">
            ⚡ Forge this Agent
          </span>
          , and a manager-of-agents pipeline scaffolds, codes, evaluates, and
          deploys a real Notion Custom Agent into your workspace. The
          inspector actually runs the generated Worker before shipping it.
        </p>

        <div className="flex flex-wrap items-center gap-3">{cta}</div>

        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <ArrowRight className="h-4 w-4" aria-hidden="true" />
          Read the
          <a
            href="https://github.com/nihalnihalani/notion-hackathon-may-2026/blob/main/PLAN.md"
            className="font-medium text-foreground underline-offset-4 hover:underline"
          >
            PLAN.md
          </a>
          to see how the four-agent pipeline is built.
        </p>
      </div>
    </section>
  );
}
