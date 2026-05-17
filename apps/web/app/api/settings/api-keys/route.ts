/**
 * /api/settings/api-keys — MCP-server API key management.
 *
 *   GET   → list the caller's keys (prefix + lastFour only — never the
 *           plaintext, even on the same request).
 *   POST  → mint a new key. The plaintext is returned ONCE in the
 *           response body and never stored. The hash + prefix + lastFour
 *           are persisted on `UserApiKey`.
 *
 * Storage model: see `packages/db/prisma/schema.prisma` (model
 * `UserApiKey`) and `apps/web/lib/auth.ts#validateApiKey` (the read path
 * used by the MCP endpoint). Plaintext format is
 * `forge_sk_<base64url(32 bytes)>` so the prefix `forge_sk_` is constant;
 * we still persist the first 8 chars to make rotation across key families
 * forward-compatible.
 *
 * The body accepts either `{ name }` (the new contract) or `{ label }`
 * (the legacy contract used by `<ApiKeysCard />`). Both are clamped to
 * 1–50 chars per the task spec.
 */

import { prisma, recordAuditEvent } from '@forge/db';
import * as Sentry from '@sentry/nextjs';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { requireWorkspace } from '@/lib/auth';
import { apiError } from '@/lib/errors';
import { capture } from '@/lib/posthog';
import { checkRateLimit, limiters } from '@/lib/ratelimit';
import { withSentry } from '@/lib/sentry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Body shape: prefer `name` per the task spec. Fall back to `label` for
// the existing client component. Exactly one of them must be present.
const createBodySchema = z
  .object({
    name: z.string().min(1).max(50).optional(),
    label: z.string().min(1).max(50).optional(),
  })
  .refine((v) => Boolean(v.name ?? v.label), {
    message: 'Either `name` or `label` is required.',
  });

// ──────────────────────────────────────────────────────────────────────────
// helpers — random key generation + sha256 (Web Crypto, runs on Edge too)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Generate a fresh 32-byte URL-safe random key with the `forge_sk_` prefix.
 *
 * 32 bytes = 256 bits of entropy, well above any practical brute-force
 * threat. We use base64url (no padding) so the key fits cleanly in a
 * single header line and is greppable.
 */
function generatePlaintextKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const b64 = Buffer.from(bytes)
    .toString('base64')
    .replace(/=+$/, '')
    .replaceAll('+', '-')
    .replaceAll('/', '_');
  return `forge_sk_${b64}`;
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  const view = new Uint8Array(buf);
  let out = '';
  for (const b of view) out += b.toString(16).padStart(2, '0');
  return out;
}

// ──────────────────────────────────────────────────────────────────────────
// GET — list keys (no plaintext, no hash)
// ──────────────────────────────────────────────────────────────────────────

export const GET = withSentry(
  async () => {
    const r = await requireWorkspace();
    if (!r.ok) return r.response;
    const { user } = r.ctx;

    const keys = await prisma.userApiKey.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        prefix: true,
        lastFour: true,
        createdAt: true,
        lastUsedAt: true,
        revokedAt: true,
      },
    });

    return NextResponse.json({
      keys: keys.map((k) => ({
        id: k.id,
        name: k.name,
        prefix: k.prefix,
        lastFour: k.lastFour,
        createdAt: k.createdAt.toISOString(),
        lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
        revoked: k.revokedAt !== null,
      })),
    });
  },
  { routeName: 'settings.api-keys.list' },
);

// ──────────────────────────────────────────────────────────────────────────
// POST — mint a new key. Plaintext is returned ONCE.
// ──────────────────────────────────────────────────────────────────────────

export const POST = withSentry(
  async (req) => {
    const r = await requireWorkspace();
    if (!r.ok) return r.response;
    const { user, workspace, clerkId } = r.ctx;

    const rl = await checkRateLimit(limiters.agentMutation(), user.id);
    if (!rl.success) {
      return apiError('rate_limited', 'Too many key creations.');
    }

    let json: unknown;
    try {
      json = await req.json();
    } catch {
      return apiError('validation', 'Body must be valid JSON.');
    }
    const parsed = createBodySchema.safeParse(json);
    if (!parsed.success) {
      return apiError('validation', 'Invalid body.', {
        issues: parsed.error.issues,
      });
    }
    // `name` is the canonical field; we already refined that at least one of
    // the two fields is present, so the fallback is safe.
    const keyName = (parsed.data.name ?? parsed.data.label)!;

    const plaintext = generatePlaintextKey();
    const hashedKey = await sha256Hex(plaintext);
    // Prefix surface = first 8 chars (covers "forge_sk"). LastFour = the
    // trailing 4 chars of the secret entropy. Persisted so the UI can
    // surface a recognizable handle without disclosing the secret.
    const prefix = plaintext.slice(0, 8);
    const lastFour = plaintext.slice(-4);

    const row = await prisma.userApiKey.create({
      data: {
        userId: user.id,
        name: keyName,
        prefix,
        lastFour,
        hashedKey,
      },
      select: {
        id: true,
        name: true,
        prefix: true,
        lastFour: true,
        createdAt: true,
      },
    });

    // Audit + analytics best-effort. Failing either should not block the
    // user from copying their freshly minted key.
    try {
      await recordAuditEvent({
        workspaceId: workspace.id,
        userId: clerkId,
        action: 'api_key.created',
        resourceType: 'api_key',
        resourceId: row.id,
        metadata: { keyId: row.id, prefix: row.prefix, name: row.name },
      });
    } catch (error) {
      Sentry.captureException(error, {
        tags: { phase: 'audit.api_key.created' },
      });
    }

    await capture({
      distinctId: user.id,
      event: 'forge.settings.api_key_created',
      workspaceId: workspace.id,
      properties: { keyId: row.id, name: row.name },
    });

    return NextResponse.json(
      {
        id: row.id,
        name: row.name,
        prefix: row.prefix,
        lastFour: row.lastFour,
        createdAt: row.createdAt.toISOString(),
        // Plaintext key — shown ONCE. Frontend must surface a "copy now"
        // affordance and warn that we cannot recover it later.
        key: plaintext,
      },
      { status: 201 },
    );
  },
  { routeName: 'settings.api-keys.create' },
);
