'use client';

/**
 * PostHog provider — initialises the browser SDK once on first mount,
 * identifies the user when Clerk's session resolves, and drives manual
 * page-view capture for App Router soft navigations.
 *
 * Why a provider component and not just calling `initPosthog()` from
 * `layout.tsx`?
 *
 *   1. We need `useUser` / `usePathname` hooks, which are client-only.
 *   2. Wrapping children also gives us a single place to mount future
 *      copilots / feature-flag-aware UI without touching every page.
 *   3. The provider is a no-op render — it returns children unchanged — so
 *      the wrapping cost is essentially zero.
 *
 * We do NOT call PostHog's React context provider (`PostHogProvider`) here
 * because it's optional and our wrapper does the same work without pulling
 * in extra surface area; consumers can call `getPosthog()` directly when
 * they need the instance.
 */

import { useUser } from '@clerk/nextjs';
import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';

import { getPosthog, initPosthog } from '@/lib/posthog-client';

export function PostHogProvider({ children }: { children: ReactNode }) {
  const { isLoaded, user } = useUser();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // One-time init on mount. `initPosthog` is itself idempotent so Strict
  // Mode's double-mount in dev doesn't cause a duplicate init.
  useEffect(() => {
    initPosthog();
  }, []);

  // Identify on Clerk user load. We pass the Clerk user id as the distinct
  // id — matching what server-side `captureEvent` uses — and attach the
  // primary email for funnel reporting. No password / phone fields are
  // ever sent.
  useEffect(() => {
    if (!isLoaded) return;
    const ph = getPosthog();
    if (!ph) return;

    if (user) {
      const email = user.primaryEmailAddress?.emailAddress;
      ph.identify(user.id, {
        ...(email && { email }),
        ...(user.fullName && { name: user.fullName }),
        clerk_created_at: user.createdAt?.toISOString(),
      });
    } else {
      // Logged-out → reset so a previous session's distinct id doesn't bleed
      // into anonymous analytics. PostHog rotates to a new anonymous id.
      ph.reset();
    }
  }, [isLoaded, user]);

  // Manual pageview capture for App Router. The built-in `capture_pageview`
  // option only fires on hard navigations — soft transitions handled by
  // <Link> need this listener instead.
  useEffect(() => {
    const ph = getPosthog();
    if (!ph || !pathname) return;
    const url = searchParams.toString() ? `${pathname}?${searchParams.toString()}` : pathname;
    ph.capture('$pageview', { $current_url: url });
  }, [pathname, searchParams]);

  return <>{children}</>;
}
