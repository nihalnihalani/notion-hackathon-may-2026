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
 * `UserApiKey`) and `apps/web/lib/api-keys.ts` (validation path used by
 * the MCP endpoint). Plaintext format is `fk_live_<base64url(32 bytes)>`
 * so the prefix `fk_live_` is constant; we still persist the first 8 chars
 * to make rotation across key families forward-compatible.
 */

import { prisma } from '@forge/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { requireWorkspace } from '@/lib/auth';
import { apiError } from '@/lib/errors';
import { capture } from '@/lib/posthog';
import { checkRateLimit, limiters } from '@/lib/ratelimit';
import { withSentry } from '@/lib/sentry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const createBodySchema = z.object({
  name: z.string().min(1).max(64),
});

// ──────────────────────────────────────────────────────────────────────────
// helpers — random key generation + sha256 (Web Crypto, runs on Edge too)
// ──────────────────────────────────────────────────────────────────────────

/** Generate a fresh 32-byte URL-safe random key with the `fk_live_` prefix. */
function generatePlaintextKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  // Base64url without padding — fits cleanly in a single header line.
  const b64 = Buffer.from(bytes)
    .toString('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  return `fk_live_${b64}`;
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(input),
  );
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
    const { user, workspace } = r.ctx;

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

    const plaintext = generatePlaintextKey();
    const hashedKey = await sha256Hex(plaintext);
    // Prefix surface = first 8 chars (covers "fk_live_"). LastFour = the
    // trailing 4 chars of the secret entropy.
    const prefix = plaintext.slice(0, 8);
    const lastFour = plaintext.slice(-4);

    const row = await prisma.userApiKey.create({
      data: {
        userId: user.id,
        name: parsed.data.name,
        prefix,
        lastFour,
        hashedKey,
      },
      select: { id: true, name: true, prefix: true, lastFour: true },
    });

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
        // Plaintext key — shown ONCE. Frontend must surface a "copy now"
        // affordance and warn that we cannot recover it later.
        key: plaintext,
      },
      { status: 201 },
    );
  },
  { routeName: 'settings.api-keys.create' },
);
