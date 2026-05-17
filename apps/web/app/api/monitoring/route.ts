/**
 * Sentry tunnel route.
 *
 * Browsers POST their captured events/envelopes here instead of going
 * directly to `*.sentry.io`. We parse the envelope header to extract the
 * `dsn`, validate it against our configured DSN (so this endpoint can't be
 * abused as an open relay to *anyone's* Sentry org), and forward the raw
 * body to the matching Sentry ingest URL.
 *
 * Why this matters: ad-blockers ship filter lists targeting `sentry.io` and
 * `ingest.sentry.io`. In production we'd lose ~20–30% of client error
 * visibility without a tunnel. The route lives under `/api/` because Vercel
 * routes it to a function — that's exactly the latency profile we want
 * (cold start once per region, warm thereafter).
 *
 * Auth: this endpoint is intentionally **public** — it's an outbound proxy
 * from a logged-in browser to Sentry, and Clerk's session check would
 * either (a) require a CORS preflight on every event or (b) fail entirely
 * for unauthenticated landing-page errors. The `proxy.ts` middleware
 * matcher includes `/api/monitoring(.*)` so Clerk skips it.
 *
 * Hardening:
 *   - Only POST is allowed for event ingestion.
 *   - Envelope DSN must match the project DSN we expect.
 *   - Body is forwarded as-is (Sentry's wire format is opaque to us).
 *
 * @see https://docs.sentry.io/platforms/javascript/troubleshooting/#using-the-tunnel-option
 */

import { NextResponse } from 'next/server';

// Sentry expects a low-overhead serverless function; Edge runtime keeps
// per-event latency to a minimum and avoids the Node cold-start tax.
export const runtime = 'edge';
export const dynamic = 'force-dynamic';

const EXPECTED_DSN =
  process.env['NEXT_PUBLIC_SENTRY_DSN'] ?? process.env['SENTRY_DSN'];

interface ParsedDsn {
  host: string;
  projectId: string;
}

function parseDsn(dsn: string): ParsedDsn | null {
  try {
    const url = new URL(dsn);
    // Sentry DSNs are `https://<publicKey>@<host>/<projectId>`. The pathname
    // is `/<projectId>` — strip the leading slash.
    const projectId = url.pathname.replace(/^\//, '');
    if (!projectId) return null;
    return { host: url.host, projectId };
  } catch {
    return null;
  }
}

/**
 * CORS preflight. Sentry's SDK uses fetch, so modern browsers will send an
 * OPTIONS request only for non-simple content types. We return permissive
 * CORS headers so the SDK can POST `application/x-sentry-envelope` without
 * being blocked.
 */
export function OPTIONS(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'content-type, x-sentry-envelope',
      'Access-Control-Max-Age': '86400',
    },
  });
}

export async function POST(req: Request): Promise<Response> {
  if (!EXPECTED_DSN) {
    // No Sentry configured for this deploy — accept and drop, so the SDK
    // doesn't retry indefinitely. 204 = "we got it, nothing more to say".
    return new Response(null, { status: 204 });
  }

  const expected = parseDsn(EXPECTED_DSN);
  if (!expected) {
    return NextResponse.json(
      { error: 'invalid_server_dsn' },
      { status: 500 },
    );
  }

  // Read the body once. Envelopes are line-delimited JSON; the first line
  // is the header object. We don't need to fully parse the rest — only the
  // header's `dsn` field decides routing.
  const body = await req.text();
  const firstNewline = body.indexOf('\n');
  if (firstNewline === -1) {
    return NextResponse.json(
      { error: 'invalid_envelope' },
      { status: 400 },
    );
  }
  const header = body.slice(0, firstNewline);

  let envelopeDsn: string | undefined;
  try {
    const parsed = JSON.parse(header) as { dsn?: string };
    envelopeDsn = parsed.dsn;
  } catch {
    return NextResponse.json(
      { error: 'invalid_envelope_header' },
      { status: 400 },
    );
  }
  if (!envelopeDsn) {
    return NextResponse.json(
      { error: 'missing_envelope_dsn' },
      { status: 400 },
    );
  }

  const submitted = parseDsn(envelopeDsn);
  if (!submitted) {
    return NextResponse.json(
      { error: 'invalid_envelope_dsn' },
      { status: 400 },
    );
  }

  // Open-relay guard: refuse to forward to any host/project other than the
  // one this deploy is configured for. Without this check, anyone could POST
  // arbitrary envelopes here and we'd faithfully ship them to any Sentry
  // org on the internet.
  if (
    submitted.host !== expected.host ||
    submitted.projectId !== expected.projectId
  ) {
    return NextResponse.json(
      { error: 'dsn_mismatch' },
      { status: 403 },
    );
  }

  const upstream = `https://${submitted.host}/api/${submitted.projectId}/envelope/`;

  const ingestRes = await fetch(upstream, {
    method: 'POST',
    body,
    headers: {
      'content-type':
        req.headers.get('content-type') ?? 'application/x-sentry-envelope',
    },
  });

  // Mirror Sentry's response status so the browser SDK can retry on 429/5xx
  // exactly as it would against the direct endpoint. We forward the body
  // verbatim so retry-after etc. propagate.
  const responseBody = await ingestRes.arrayBuffer();
  return new Response(responseBody, {
    status: ingestRes.status,
    headers: {
      'content-type':
        ingestRes.headers.get('content-type') ?? 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
