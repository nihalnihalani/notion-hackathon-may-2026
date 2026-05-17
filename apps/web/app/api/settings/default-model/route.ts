/**
 * PATCH /api/settings/default-model — persist the workspace's default model.
 *
 * The dashboard `/settings` page lets the user pick which model Tool Coder
 * should default to. Value is stored on `Workspace.defaultModel` (TEXT,
 * default "auto"). Validation accepts any non-empty string ≤ 64 chars so we
 * don't need a migration when a new model lands.
 *
 * Body: `{ model: string }`
 * Response: `{ ok: true, model: string }`
 */

import { prisma } from '@forge/db';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { requireWorkspace } from '@/lib/auth';
import { apiError } from '@/lib/errors';
import { capture } from '@/lib/posthog';
import { withSentry } from '@/lib/sentry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  model: z.string().min(1).max(64),
});

export const PATCH = withSentry(
  async (req) => {
    const r = await requireWorkspace();
    if (!r.ok) return r.response;
    const { user, workspace, clerkId } = r.ctx;

    let json: unknown;
    try {
      json = await req.json();
    } catch {
      return apiError('validation', 'Body must be valid JSON.');
    }
    const parsed = bodySchema.safeParse(json);
    if (!parsed.success) {
      return apiError('validation', 'Invalid body.', {
        issues: parsed.error.issues,
      });
    }
    const { model } = parsed.data;

    await prisma.workspace.update({
      where: { id: workspace.id },
      data: { defaultModel: model },
    });

    // Audit — we don't have a dedicated variant for settings changes so we
    // skip the audit log here. PostHog carries the analytics signal; if
    // compliance later demands an audit row for settings, add a variant
    // (`settings.updated`) and a corresponding zod arm.

    await capture({
      distinctId: user.id,
      event: 'forge.settings.default_model_changed',
      workspaceId: workspace.id,
      properties: { model },
    });

    // Silence unused-var lint for `clerkId` — we keep the destructure
    // explicit so future audit additions don't have to re-fetch.
    void clerkId;

    return NextResponse.json({ ok: true, model });
  },
  { routeName: 'settings.default-model' },
);
