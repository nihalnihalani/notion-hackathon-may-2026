/**
 * PATCH /api/settings/default-model — persist the workspace's default model.
 *
 * The dashboard `/settings` page lets the user pick which model Tool Coder
 * should default to. Value is stored on `Workspace.defaultModel` (TEXT,
 * default "auto"). Accepted values today are `auto`, `claude-opus-4-7`,
 * and `gpt-5-thinking-mini`; new entries can land by extending the union
 * below without a migration.
 *
 * Body: `{ model: 'claude-opus-4-7' | 'gpt-5-thinking-mini' | 'auto' }`
 * Response: `{ ok: true, model: string }`
 *
 * We also export `POST` as an alias because the original `<ModelSelector />`
 * client uses POST and the task spec asked for PATCH. Routing both to the
 * same handler avoids breaking the existing frontend while honoring the
 * new contract.
 */

import { prisma, recordAuditEvent } from '@forge/db';
import * as Sentry from '@sentry/nextjs';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { requireWorkspace } from '@/lib/auth';
import { apiError } from '@/lib/errors';
import { capture } from '@/lib/posthog';
import { checkRateLimit, createRateLimiter } from '@/lib/ratelimit';
import { withSentry } from '@/lib/sentry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ALLOWED_MODELS = [
  'claude-opus-4-7',
  'gpt-5-thinking-mini',
  'auto',
] as const;

const bodySchema = z.object({
  model: z.enum(ALLOWED_MODELS),
});

async function handler(req: Request): Promise<NextResponse> {
  const r = await requireWorkspace();
  if (!r.ok) return r.response;
  const { user, workspace, clerkId } = r.ctx;

  // Per-user rate limit: 30 writes/min — preferences don't need to update
  // faster than that, and a tight cap blocks accidental loops in the
  // settings UI from chewing through audit rows + DB writes.
  const rl = await checkRateLimit(
    createRateLimiter('settings.default_model', 30, '1 m'),
    user.id,
  );
  if (!rl.success) {
    const resetSeconds = Math.max(0, Math.ceil((rl.reset - Date.now()) / 1000));
    const resp = apiError(
      'rate_limited',
      `Rate limit exceeded. Retry in ${resetSeconds}s.`,
    );
    resp.headers.set('Retry-After', String(resetSeconds));
    resp.headers.set('X-RateLimit-Limit', String(rl.limit));
    resp.headers.set('X-RateLimit-Remaining', String(rl.remaining));
    return resp;
  }

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

  // Capture the prior value BEFORE the update so the audit entry shows the
  // diff. `defaultModel` is nullable in the schema; coerce a null to "auto"
  // for log readability — the application-level default is the same.
  const previousModel = workspace.defaultModel ?? 'auto';

  await prisma.workspace.update({
    where: { id: workspace.id },
    data: { defaultModel: model },
  });

  // Audit write is best-effort: a transient DB hiccup on the audit table
  // must not block the user's settings change. Sentry catches the miss.
  try {
    await recordAuditEvent({
      workspaceId: workspace.id,
      userId: clerkId,
      action: 'workspace.default_model_changed',
      resourceType: 'workspace',
      resourceId: workspace.id,
      metadata: { previousModel, newModel: model },
    });
  } catch (err) {
    Sentry.captureException(err, {
      tags: { phase: 'audit.workspace.default_model_changed' },
    });
  }

  await capture({
    distinctId: user.id,
    event: 'forge.settings.default_model_changed',
    workspaceId: workspace.id,
    properties: { model, previousModel },
  });

  return NextResponse.json({ ok: true, model });
}

export const PATCH = withSentry(handler, {
  routeName: 'settings.default-model',
});

// Compat alias for the original POST-based frontend. Both verbs land in the
// same place — removing once the client switches to PATCH is a one-liner.
export const POST = withSentry(handler, {
  routeName: 'settings.default-model',
});
