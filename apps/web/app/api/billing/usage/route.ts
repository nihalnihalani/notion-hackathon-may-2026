/**
 * POST /api/billing/usage — Stripe meter event push, internal cron sink.
 *
 * Two auth modes (both accepted):
 *   - `Authorization: Bearer FORGE_INTERNAL_TOKEN`  for our own cron job
 *     pushing aggregated usage to Stripe.
 *   - `Stripe-Signature` header verified against `STRIPE_WEBHOOK_SECRET` for
 *     Stripe → Forge events (e.g. subscription updated, invoice paid).
 *
 * Body shape varies by source:
 *   - Internal: `{ workspaceId, fields: UsageMeterFields }`
 *   - Stripe: standard Stripe event JSON; we extract workspace via the
 *     event's `metadata.workspace_id` (set when we create the customer).
 *
 * Returns 200 always on a successful auth + parse, even when the event is
 * a noop (Stripe sends events we don't care about — we ack with 200 so it
 * doesn't retry).
 */

import { recordUsage } from '@forge/db';
import * as Sentry from '@sentry/nextjs';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { apiError } from '@/lib/errors';
import { validateForgeInternalToken } from '@/lib/forge-internal';
import { withSentry } from '@/lib/sentry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const internalBodySchema = z.object({
  workspaceId: z.string().min(1),
  fields: z
    .object({
      generationsCount: z.number().int().nonnegative().optional(),
      deploysCount: z.number().int().nonnegative().optional(),
      invocationsCount: z.number().int().nonnegative().optional(),
      totalLlmCostUsd: z.number().nonnegative().optional(),
      totalSandboxSeconds: z.number().int().nonnegative().optional(),
    })
    .refine((v) => Object.values(v).some((x) => x !== undefined), {
      message: 'fields must have at least one counter',
    }),
});

/**
 * Constant-time string equality — copied from forge-internal for the Stripe
 * fallback path. Avoids depending on `crypto.timingSafeEqual` (Node-only).
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Verify a Stripe signature header. Stripe's `Stripe-Signature` is a
 * comma-separated list: `t=<unix>,v1=<hex>`. We re-compute
 * `HMAC_SHA256(secret, "${t}.${rawBody}")` and constant-time compare.
 */
async function verifyStripeSignature(
  rawBody: string,
  header: string,
  secret: string,
): Promise<boolean> {
  const parts = Object.fromEntries(
    header.split(',').map((kv) => {
      const i = kv.indexOf('=');
      return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()];
    }),
  );
  const t = parts['t'];
  const v1 = parts['v1'];
  if (!t || !v1) return false;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${t}.${rawBody}`));
  const view = new Uint8Array(sig);
  let expected = '';
  for (const b of view) expected += b.toString(16).padStart(2, '0');
  return constantTimeEqual(v1.toLowerCase(), expected);
}

export const POST = withSentry(
  async (req) => {
    const raw = await req.text();

    // Try Stripe signature first.
    const stripeSig = req.headers.get('stripe-signature');
    const stripeSecret = process.env['STRIPE_WEBHOOK_SECRET'] ?? '';
    if (stripeSig && stripeSecret) {
      const ok = await verifyStripeSignature(raw, stripeSig, stripeSecret);
      if (!ok) {
        return apiError('unauthenticated', 'Invalid Stripe signature.');
      }
      // We don't have a Stripe types dep wired; parse loosely and noop.
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const event = JSON.parse(raw) as { type?: string; data?: any };
        Sentry.addBreadcrumb({
          category: 'billing.stripe',
          level: 'info',
          message: `received ${event.type ?? 'unknown'}`,
        });
        // No Stripe → workspace mapping in DB yet (no `stripeCustomerId`
        // column). For now we ack and rely on the internal cron sink for
        // counter updates. Tracked: backlog "billing: stripe customer linkage".
      } catch {
        // ignore
      }
      return NextResponse.json({ ok: true, ack: 'stripe' });
    }

    // Else require the internal bearer.
    if (!validateForgeInternalToken(req)) {
      return apiError('unauthenticated', 'Invalid internal token.');
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return apiError('validation', 'Body must be valid JSON.');
    }
    const parsed = internalBodySchema.safeParse(json);
    if (!parsed.success) {
      return apiError('validation', 'Invalid usage payload.', {
        issues: parsed.error.issues,
      });
    }
    await recordUsage(parsed.data.workspaceId, parsed.data.fields);
    return NextResponse.json({ ok: true, ack: 'internal' });
  },
  { routeName: 'billing.usage' },
);
