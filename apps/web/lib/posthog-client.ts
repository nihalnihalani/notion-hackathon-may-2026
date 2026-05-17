/**
 * Client-side PostHog wrapper.
 *
 * `posthog-js` is bundled into the browser chunk only. We never import this
 * file from a server component — there's no shim for `localStorage` and
 * even reading `process.env['NEXT_PUBLIC_*']` from a non-client context can
 * leak into edge bundles.
 *
 * The PostHog SDK is itself a singleton so `init()` can be called more than
 * once safely (subsequent calls are no-ops). We expose `getPosthog()` rather
 * than the raw module so a future swap (e.g., a server-tunneled variant)
 * doesn't require touching every call site.
 *
 * Page-view capture is auto-enabled via the App Router pathname listener in
 * `components/posthog-provider.tsx` — we do **not** rely on
 * `capture_pageview: true` because the App Router rewrites history without
 * a hard navigation, and PostHog's built-in listener misses those.
 */

import posthog, { type PostHog } from 'posthog-js';

let initialised = false;

/**
 * Initialise the browser SDK with our public key. Safe to call on every
 * render — the underlying SDK only runs init once.
 */
export function initPosthog(): PostHog | null {
  if (typeof globalThis === 'undefined') return null;
  const key = process.env['NEXT_PUBLIC_POSTHOG_KEY'];
  if (!key) return null;
  if (initialised) return posthog;

  posthog.init(key, {
    api_host: process.env['NEXT_PUBLIC_POSTHOG_HOST'] ?? 'https://us.i.posthog.com',
    // We drive page-view capture ourselves from the App Router listener —
    // see comment at top of file.
    capture_pageview: false,
    capture_pageleave: true,
    // No raw form values; PostHog defaults to masking but we tighten it
    // here so a future contributor enabling autocapture doesn't suddenly
    // start scooping email/password fields.
    autocapture: {
      dom_event_allowlist: ['click'],
      element_allowlist: ['button', 'a'],
    },
    person_profiles: 'identified_only',
    loaded: (ph) => {
      if (process.env.NODE_ENV === 'development') {
        ph.debug(false);
      }
    },
  });

  initialised = true;
  return posthog;
}

/**
 * Get the initialised PostHog instance. Returns `null` if we're rendering
 * server-side or the public key is unset.
 */
export function getPosthog(): PostHog | null {
  if (typeof globalThis === 'undefined') return null;
  if (!process.env['NEXT_PUBLIC_POSTHOG_KEY']) return null;
  return posthog;
}
