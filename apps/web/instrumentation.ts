/**
 * Next.js 16 instrumentation entry point — runs once at boot in **both** the
 * Node.js and Edge runtimes. This is the v10 `@sentry/nextjs` pattern: a
 * single file dispatches to per-runtime Sentry configs based on
 * `process.env.NEXT_RUNTIME`, which Next.js sets to either `'nodejs'` or
 * `'edge'` before the file is executed.
 *
 * Why not the legacy `sentry.server.config.ts` + `sentry.edge.config.ts`?
 * Sentry v10 still supports those files for backwards compatibility, but the
 * recommended path is to keep server + edge config in one file gated by
 * `NEXT_RUNTIME`. This keeps DSN/env handling in one place and means we don't
 * pay the cost of dynamic imports from two separate boot paths.
 *
 * `register()` is awaited by Next.js before the first request is served, so
 * any async init (loading the profiling integration in Node) blocks request
 * dispatch — exactly what we want for crash-free coverage.
 *
 * `onRequestError` is the v10 hook Next.js calls for any error thrown during
 * request rendering (App Router server components, route handlers). Wiring
 * `Sentry.captureRequestError` here is what gives Sentry per-request context
 * for non-throwing 5xx responses produced inside RSC.
 */

import * as Sentry from '@sentry/nextjs';

const DSN = process.env['SENTRY_DSN'] ?? process.env['NEXT_PUBLIC_SENTRY_DSN'];
const ENVIRONMENT =
  process.env['SENTRY_ENVIRONMENT'] ??
  process.env['VERCEL_ENV'] ??
  process.env['NODE_ENV'] ??
  'development';
const RELEASE =
  process.env['SENTRY_RELEASE'] ?? process.env['VERCEL_GIT_COMMIT_SHA'];

// Performance traces sampled at 10% in prod, 100% in dev — matches the rule
// in PLAN.md Part X so we get full traces while iterating locally without
// blowing the Sentry quota in production.
const TRACES_SAMPLE_RATE = ENVIRONMENT === 'production' ? 0.1 : 1.0;

/**
 * PII scrubber used by both Node and Edge runtimes. We strip the common
 * regulated identifiers from breadcrumb data before it ever leaves the
 * process. Keeping this server-side (not just client-side) matters because
 * webhook payloads and Notion responses can carry user emails — those must
 * never be persisted in Sentry.
 *
 * Patterns:
 *   - email           → `<email>`
 *   - phone (NANP-ish)→ `<phone>`
 *   - SSN             → `<ssn>`
 *   - credit card     → `<cc>`  (4 groups of 4 digits w/ optional separator)
 */
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE_RE = /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g;
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
const CC_RE = /\b(?:\d[ -]*?){13,16}\b/g;

function scrub(value: unknown): unknown {
  if (typeof value === 'string') {
    return value
      .replace(EMAIL_RE, '<email>')
      .replace(SSN_RE, '<ssn>')
      .replace(CC_RE, '<cc>')
      .replace(PHONE_RE, '<phone>');
  }
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      // Drop obviously sensitive keys outright rather than try to scrub them.
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

export async function register(): Promise<void> {
  if (!DSN) {
    // No DSN means observability is opt-in (e.g., a dev who hasn't set up
    // Sentry yet). We intentionally don't log here — see PLAN.md ban on
    // console noise in prod paths. The SDK's own no-op behavior on missing
    // DSN is the right UX.
    return;
  }

  if (process.env['NEXT_RUNTIME'] === 'nodejs') {
    // Node-only integrations (profiling) are loaded dynamically so the edge
    // bundle never tries to resolve `@sentry/profiling-node`. The dynamic
    // import is wrapped in a try/catch because the profiling integration is
    // an optional peer dep — if it's not installed we still want tracing.
    const integrations: Sentry.Integration[] = [];
    try {
      const profiling = await import('@sentry/profiling-node').catch(
        () => null,
      );
      if (profiling && 'nodeProfilingIntegration' in profiling) {
        const integ = (
          profiling as { nodeProfilingIntegration: () => Sentry.Integration }
        ).nodeProfilingIntegration();
        integrations.push(integ);
      }
    } catch {
      // Profiling is best-effort; absence must not break boot.
    }

    Sentry.init({
      dsn: DSN,
      environment: ENVIRONMENT,
      ...(RELEASE && { release: RELEASE }),
      // Tracing — see TRACES_SAMPLE_RATE comment above.
      tracesSampleRate: TRACES_SAMPLE_RATE,
      // Match traces sample rate so we don't profile transactions we won't
      // see in Sentry. 1.0 here means "of the sampled traces, profile all".
      profilesSampleRate: 1.0,
      // PII filter applied to every breadcrumb's data + message.
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
      // PII filter applied to the request body Sentry attaches to events.
      // We never want raw form bodies (potentially carrying email/PII) in
      // Sentry — the scrubber handles that even if `sendDefaultPii` is on.
      beforeSend(event) {
        if (event.request && typeof event.request === 'object') {
          event.request = scrub(event.request) as typeof event.request;
        }
        if (event.extra) {
          event.extra = scrub(event.extra) as typeof event.extra;
        }
        return event;
      },
      integrations,
    });
  }

  if (process.env['NEXT_RUNTIME'] === 'edge') {
    Sentry.init({
      dsn: DSN,
      environment: ENVIRONMENT,
      ...(RELEASE && { release: RELEASE }),
      // Edge: tracing only, no profiling integration (incompatible runtime).
      tracesSampleRate: TRACES_SAMPLE_RATE,
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
}

/**
 * Sentry v10 hook for App Router request errors. Next.js invokes this for
 * every error thrown inside a Server Component, Route Handler, or Server
 * Action — including ones that don't reach our `withSentry` wrapper (e.g.,
 * errors thrown inside an RSC boundary before a handler runs).
 */
export const onRequestError = Sentry.captureRequestError;
