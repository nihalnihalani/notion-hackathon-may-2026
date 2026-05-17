import type { NextConfig } from 'next';
import { withSentryConfig } from '@sentry/nextjs';

/**
 * Baseline security headers applied to every route via Next's `headers()`
 * config. CSP is deliberately NOT included here — a strict CSP requires
 * per-route nonces emitted from Server Components, which is a separate work
 * item (tracked in PLAN backlog). Until that lands, the headers below give
 * us the cheap-and-correct subset of OWASP's recommended response headers.
 *
 * Header rationale:
 *   - X-Content-Type-Options: nosniff
 *       Blocks IE/old-Edge MIME sniffing. Cheap, zero risk.
 *   - Referrer-Policy: strict-origin-when-cross-origin
 *       Browser default in modern Chrome/Firefox; restated for older clients
 *       and so the policy is visible in audit tools.
 *   - X-Frame-Options: DENY
 *       The Forge dashboard must never be iframed (clickjacking on
 *       generation triggers). CSP `frame-ancestors` is the modern
 *       equivalent and will subsume this once CSP lands.
 *   - Permissions-Policy: camera=(), geolocation=(), interest-cohort=(),
 *                         payment=(self)
 *       Disables unused powerful APIs. `payment=(self)` keeps the door open
 *       for the future Stripe Payment Request flow.
 *   - Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
 *       Two-year HSTS with preload eligibility (apex must be HTTPS-only).
 *       Vercel terminates TLS so this is safe on every deploy URL.
 */
const SECURITY_HEADERS = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), geolocation=(), interest-cohort=(), payment=(self)',
  },
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains; preload',
  },
] as const;

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // `typedRoutes` graduated from experimental → stable in Next 16. The
  // experimental flag is now a no-op and emits a deprecation warning at build
  // time, so keep it at top-level only.
  typedRoutes: true,
  images: {
    // MiniMax serves agent avatars from these hosts. Vercel Blob hosts
    // generated source artifacts (also fetched via next/image when we surface
    // a thumbnail). Wildcard hostname = locked-down to remote pattern, not
    // open redirect (Next still validates path).
    remotePatterns: [
      { protocol: 'https', hostname: '*.minimax.io' },
      { protocol: 'https', hostname: '*.minimaxi.chat' },
      { protocol: 'https', hostname: '*.public.blob.vercel-storage.com' },
    ],
  },
  transpilePackages: [
    '@forge/agents',
    '@forge/ntn-wrapper',
    '@forge/notion-client',
    '@forge/connectors',
    '@forge/db',
    '@forge/safety',
    '@forge/workflows',
    '@forge/mcp-server',
    '@forge/installer',
    '@forge/eval-harness',
  ],
  // Apply baseline security headers to EVERY response. `source: '/(.*)'`
  // matches all paths including API routes and the Sentry tunnel.
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: SECURITY_HEADERS.map(({ key, value }) => ({ key, value })),
      },
    ];
  },
};

/**
 * Sentry build-time wrapper.
 *
 * Source-map upload pipeline (only runs when `SENTRY_AUTH_TOKEN` is set, so
 * dev builds skip it automatically):
 *   1. Next builds client + server bundles with hidden source maps.
 *   2. `@sentry/nextjs` webpack plugin uploads them to the configured org +
 *      project, tagged with the release name from `SENTRY_RELEASE` (falls
 *      back to the Vercel commit SHA when set in instrumentation.ts).
 *   3. `sourcemaps.deleteSourcemapsAfterUpload` (default `true` in v10) wipes
 *      the .map files from the deployed artifact so we never ship them to
 *      the public — this replaces the legacy `hideSourceMaps` option that
 *      v10 removed.
 *
 * `tunnelRoute: '/api/monitoring'` routes browser → Sentry traffic through
 * our own origin. This bypasses uBlock/Adblock filter lists that target
 * `*.sentry.io` directly, which would otherwise silently drop ~30% of
 * client error events.
 *
 * `silent: !process.env.CI` keeps the local `next dev` output free of the
 * Sentry plugin's chatter while still surfacing upload progress in CI logs.
 */
// tsconfig has `exactOptionalPropertyTypes`, so we spread the env-derived
// fields conditionally rather than passing `undefined` values directly to
// `withSentryConfig`. Missing values cleanly disable source-map upload
// without throwing a build error in environments where Sentry isn't set up
// (dev, contributor forks).
const sentryOrg = process.env['SENTRY_ORG'];
const sentryProject = process.env['SENTRY_PROJECT'];
const sentryAuthToken = process.env['SENTRY_AUTH_TOKEN'];
const isPlaceholderEnv = (value: string) => /fake[-_]?ci[-_]?stub/.test(value);
const hasRealSentryUploadConfig = Boolean(
  sentryOrg &&
    sentryProject &&
    sentryAuthToken &&
    !isPlaceholderEnv(sentryOrg) &&
    !isPlaceholderEnv(sentryProject) &&
    !isPlaceholderEnv(sentryAuthToken),
);
const sentryUploadConfig = hasRealSentryUploadConfig
  ? {
      org: sentryOrg as string,
      project: sentryProject as string,
      authToken: sentryAuthToken as string,
    }
  : {};

export default withSentryConfig(nextConfig, {
  // Org/project/auth come from env so dev builds work without secrets, and
  // contributors can point at their personal Sentry project for testing.
  ...sentryUploadConfig,

  // Keep build logs and outbound calls deterministic for local/CI stub runs.
  telemetry: false,

  // Suppress plugin logs locally; let CI builds print upload progress so
  // a failed source-map upload is debuggable from the Vercel build log.
  silent: !hasRealSentryUploadConfig || !process.env['CI'],

  // Upload source maps for client routes that the App Router builds into
  // chunked bundles (e.g., dynamic imports under /agents/[id]). Without
  // this flag the plugin only captures bundles it can statically discover.
  widenClientFileUpload: true,

  // Tunnel route — see comment above. Must match the route handler we
  // expose at `apps/web/app/api/monitoring/route.ts`, and must be in
  // the Clerk middleware public matcher (see `apps/web/proxy.ts`).
  tunnelRoute: '/api/monitoring',

  // Source-map handling. `deleteSourcemapsAfterUpload` defaults to `true`
  // in v10 — restated here for explicitness so a future contributor doesn't
  // assume maps are being shipped to clients.
  sourcemaps: hasRealSentryUploadConfig
    ? {
        deleteSourcemapsAfterUpload: true,
      }
    : {
        disable: true,
      },
});
