import Link from 'next/link';
import { SignInButton, SignedIn, SignedOut, UserButton } from '@clerk/nextjs';

export default function LandingPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-6xl flex-col px-6 py-10">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div
            aria-hidden="true"
            className="h-8 w-8 rounded-md bg-gradient-to-br from-amber-400 to-rose-500"
          />
          <span className="text-lg font-semibold tracking-tight">Forge</span>
        </div>
        <nav className="flex items-center gap-6 text-sm text-neutral-300">
          <Link href="/agents" className="hover:text-white">
            Agents
          </Link>
          <Link href="/settings" className="hover:text-white">
            Settings
          </Link>
          <SignedIn>
            <UserButton afterSignOutUrl="/" />
          </SignedIn>
          <SignedOut>
            <SignInButton mode="modal">
              <button
                type="button"
                className="rounded-full bg-white px-4 py-1.5 text-sm font-medium text-neutral-950 transition hover:bg-neutral-200"
              >
                Sign in with Notion
              </button>
            </SignInButton>
          </SignedOut>
        </nav>
      </header>

      <section className="mt-32 flex max-w-3xl flex-col gap-6">
        <p className="text-sm font-medium uppercase tracking-widest text-amber-400">
          Notion Custom Agent Studio
        </p>
        <h1 className="text-5xl font-semibold leading-tight tracking-tight md:text-6xl">
          Describe an agent. Ship it in 90 seconds.
        </h1>
        <p className="max-w-2xl text-lg text-neutral-300">
          Forge is a Notion-native page where you describe an agent in plain English, click{' '}
          <span className="font-medium text-white">Forge this Agent</span>, and watch a
          manager-of-agents pipeline scaffold, code, evaluate, and deploy a real Custom Agent into
          your workspace. The evaluator actually runs the generated Worker before declaring success.
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <SignedOut>
            <SignInButton mode="modal">
              <button
                type="button"
                className="rounded-full bg-white px-6 py-3 text-base font-medium text-neutral-950 transition hover:bg-neutral-200"
              >
                Sign in with Notion
              </button>
            </SignInButton>
          </SignedOut>
          <SignedIn>
            <Link
              href="/agents"
              className="rounded-full bg-white px-6 py-3 text-base font-medium text-neutral-950 transition hover:bg-neutral-200"
            >
              Open dashboard
            </Link>
          </SignedIn>
          <a
            href="https://github.com/nihalnihalani/notion-hackathon-may-2026"
            className="rounded-full border border-neutral-700 px-6 py-3 text-base font-medium text-white transition hover:border-neutral-400"
          >
            View on GitHub
          </a>
        </div>
      </section>

      <footer className="mt-auto pt-16 text-sm text-neutral-500">
        Built at the Notion Developer Platform Hackathon, May 2026. MIT licensed.
      </footer>
    </main>
  );
}
