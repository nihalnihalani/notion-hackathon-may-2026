/**
 * Browser-side Sentry init. Next.js 16 picks this file up automatically when
 * `instrumentation-client.ts` lives at the app root — there is no need to
 * import it from anywhere. The SDK is bundled into the client and runs
 * before any React component mounts, so unhandled errors fired during the
 * initial render are still captured.
 *
 * Why functional integrations (`browserTracingIntegration()`) instead of the
 * legacy `new BrowserTracing()` class form? Sentry v8 removed the class
 * shape; v10 only accepts the functional builders. They tree-shake better
 * and let us pass options without the legacy `new X({ ... })` syntax.
 *
 * Session Replay is **opt-in via env**. PLAN.md and security review require
 * an explicit decision before we start recording user sessions — flip
 * `NEXT_PUBLIC_SENTRY_REPLAY_ENABLED=1` to turn it on, and the masking
 * defaults (`maskAllText`, `maskAllInputs`, `blockAllMedia`) ensure even
 * once enabled we are not capturing PII verbatim.
 */

import * as Sentry from '@sentry/nextjs';

type SentryIntegration = ReturnType<typeof Sentry.browserTracingIntegration>;

const DSN = process.env['NEXT_PUBLIC_SENTRY_DSN'];
const ENVIRONMENT =
  process.env['NEXT_PUBLIC_SENTRY_ENVIRONMENT'] ??
  process.env['NEXT_PUBLIC_VERCEL_ENV'] ??
  process.env.NODE_ENV ??
  'development';
const RELEASE =
  process.env['NEXT_PUBLIC_SENTRY_RELEASE'] ?? process.env['NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA'];

const REPLAY_ENABLED = process.env['NEXT_PUBLIC_SENTRY_REPLAY_ENABLED'] === '1';
const TRACES_SAMPLE_RATE = ENVIRONMENT === 'production' ? 0.1 : 1;

// Mirror the server-side PII patterns. Kept inline (not imported from
// instrumentation.ts) because that file lives in the Node/Edge bundle and
// the browser shouldn't pull in any server-only imports it might add later.
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE_RE = /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g;
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
const CC_RE = /\b(?:\d[ -]*?){13,16}\b/g;

function scrub(value: unknown): unknown {
  if (typeof value === 'string') {
    return value
      .replaceAll(EMAIL_RE, '<email>')
      .replaceAll(SSN_RE, '<ssn>')
      .replaceAll(CC_RE, '<cc>')
      .replaceAll(PHONE_RE, '<phone>');
  }
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (/^(password|secret|token|api[_-]?key|authorization|cookie)$/i.test(k)) {
        out[k] = '<redacted>';
        continue;
      }
      out[k] = scrub(v);
    }
    return out;
  }
  return value;
}

if (DSN) {
  const integrations: SentryIntegration[] = [
    // Browser tracing — auto-instruments pageloads and route changes. Sentry
    // v10's functional integration discovers App Router route changes
    // automatically; no router instrumentation arg needed.
    Sentry.browserTracingIntegration(),
  ];

  if (REPLAY_ENABLED) {
    integrations.push(
      Sentry.replayIntegration({
        // Privacy defaults: never record raw DOM text or input values. The
        // session is still useful for debugging UI flows (click trail,
        // navigation timing) without surfacing user content.
        maskAllText: true,
        maskAllInputs: true,
        blockAllMedia: true,
      }),
    );
  }

  Sentry.init({
    dsn: DSN,
    environment: ENVIRONMENT,
    ...(RELEASE && { release: RELEASE }),
    tracesSampleRate: TRACES_SAMPLE_RATE,
    // 10% of normal sessions, 100% of sessions that errored — gives us
    // replay coverage for bug reports without paying for every page view.
    replaysSessionSampleRate: REPLAY_ENABLED ? 0.1 : 0,
    replaysOnErrorSampleRate: REPLAY_ENABLED ? 1 : 0,
    // We never want raw user input in Sentry, so explicitly opt out of the
    // default-PII helper Sentry exposes for App Router.
    sendDefaultPii: false,
    integrations,
    beforeBreadcrumb(breadcrumb) {
      const scrubbed = { ...breadcrumb };
      if (typeof scrubbed.message === 'string') {
        scrubbed.message = scrub(scrubbed.message) as string;
      }
      if (scrubbed.data && typeof scrubbed.data === 'object') {
        scrubbed.data = scrub(scrubbed.data) as Record<string, unknown>;
      }
      return scrubbed;
    },
    beforeSend(event) {
      if (event.request && typeof event.request === 'object') {
        event.request = scrub(event.request) as typeof event.request;
      }
      if (event.extra) {
        event.extra = scrub(event.extra) as typeof event.extra;
      }
      return event;
    },
  });
}

/**
 * Sentry v10 hook for client-side router transitions (App Router). Wiring
 * this enables accurate transaction spans for soft navigations — without
 * it, every link click is invisible to the trace.
 */
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
