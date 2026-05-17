/**
 * DELETE /api/settings/api-keys/[id] — revoke an MCP API key.
 *
 * We DO NOT delete the row — we set `revokedAt = now()`. Validation in
 * `apps/web/lib/api-keys.ts` rejects any row where `revokedAt IS NOT NULL`,
 * and audit trails are preserved.
 *
 * Returns 204 No Content on success, 404 if the key doesn't exist OR is
 * owned by another user (we collapse those two cases on purpose — no need
 * to disclose existence).
 */

import { prisma } from '@forge/db';
import { NextResponse } from 'next/server';

import { requireWorkspace } from '@/lib/auth';
import { apiError } from '@/lib/errors';
import { capture } from '@/lib/posthog';
import { checkRateLimit, limiters } from '@/lib/ratelimit';
import { withSentry } from '@/lib/sentry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const DELETE = withSentry<{ id: string }>(
  async (_req, ctx) => {
    const { id } = await ctx.params;
    const r = await requireWorkspace();
    if (!r.ok) return r.response;
    const { user, workspace } = r.ctx;

    const rl = await checkRateLimit(limiters.agentMutation(), user.id);
    if (!rl.success) {
      return apiError('rate_limited', 'Too many revocations.');
    }

    const existing = await prisma.userApiKey.findUnique({
      where: { id },
      select: { id: true, userId: true, revokedAt: true },
    });
    if (!existing || existing.userId !== user.id) {
      // Collapse 404 + 403 to a single 404 so we don't leak key existence
      // across users.
      return apiError('not_found', `API key ${id} not found.`);
    }
    if (existing.revokedAt === null) {
      await prisma.userApiKey.update({
        where: { id },
        data: { revokedAt: new Date() },
      });
    }

    await capture({
      distinctId: user.id,
      event: 'forge.settings.api_key_revoked',
      workspaceId: workspace.id,
      properties: { keyId: id },
    });

    return new NextResponse(null, { status: 204 });
  },
  { routeName: 'settings.api-keys.revoke' },
);
