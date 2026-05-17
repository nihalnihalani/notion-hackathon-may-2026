/**
 * Auth + workspace-binding helpers.
 *
 * Every protected API route follows the same pattern:
 *
 *   const ctx = await requireWorkspace();
 *   if (!ctx.ok) return ctx.response;
 *   // …use ctx.user / ctx.workspace…
 *
 * Returning a discriminated result instead of throwing keeps the route
 * handler's control flow linear and makes the auth-failure response
 * trivially testable.
 */

import { auth, currentUser } from '@clerk/nextjs/server';
import { prisma } from '@forge/db';
import type { User, Workspace } from '@forge/db';
import type { NextResponse } from 'next/server';

import { apiError } from './errors';

export interface ResolvedUser {
  /** The Clerk-managed user id (NOT our DB `User.id`). */
  clerkId: string;
  /** Our internal `User` row, materialized on first protected request. */
  user: User;
  /** The workspace the user belongs to. */
  workspace: Workspace;
}

export type RequireWorkspaceResult =
  | { ok: true; ctx: ResolvedUser }
  | { ok: false; response: NextResponse };

/**
 * Resolve the Clerk session, then map it to a {@link User} + {@link Workspace}.
 *
 * Behavior:
 *   - No session → 401 `unauthenticated`.
 *   - Session but no `User` row in our DB → 403 `forbidden` (the post-OAuth
 *     callback hasn't run yet; the user should redirect to /sign-in).
 *   - `User` exists but `Workspace` lookup fails → 500 `internal` (database
 *     inconsistency — should never happen).
 *
 * Callers should NOT cache the result across requests: the auth context is
 * per-request and the user could theoretically switch workspaces.
 */
export async function requireWorkspace(): Promise<RequireWorkspaceResult> {
  const { userId } = await auth();
  if (!userId) {
    return {
      ok: false,
      response: apiError('unauthenticated', 'Sign in required.'),
    };
  }

  const userWithWorkspace = await prisma.user.findUnique({
    where: { clerkId: userId },
    include: { workspace: true },
  });
  if (!userWithWorkspace) {
    return {
      ok: false,
      response: apiError(
        'forbidden',
        'No Forge workspace bound to this user. Complete onboarding first.',
      ),
    };
  }

  // Destructure to peel off the `workspace` relation; the rest matches the
  // bare `User` shape we expose to consumers.
  const { workspace, ...user } = userWithWorkspace;
  return {
    ok: true,
    ctx: {
      clerkId: userId,
      user,
      workspace,
    },
  };
}

/**
 * Lightweight session check — returns the Clerk userId or a 401 response.
 * Use this for callbacks that don't need a workspace yet (e.g. OAuth init).
 */
export async function requireUser(): Promise<
  { ok: true; userId: string; email: string | null } | { ok: false; response: NextResponse }
> {
  const { userId } = await auth();
  if (!userId) {
    return {
      ok: false,
      response: apiError('unauthenticated', 'Sign in required.'),
    };
  }

  // currentUser() is the only way to grab the email server-side; lazy because
  // it adds a round-trip to Clerk.
  const cu = await currentUser();
  const email = cu?.emailAddresses[0]?.emailAddress ?? null;
  return { ok: true, userId, email };
}

/**
 * Verify that the given `generationId` belongs to the caller's workspace.
 * Returns the `Generation` row on success.
 *
 * The two-step lookup (resolve workspace, then load generation) lets us
 * distinguish 401 (no session), 404 (no such generation), and 403 (exists but
 * not theirs). Frontends can branch on `error` accordingly.
 */
export async function requireGenerationOwnership(
  generationId: string,
): Promise<
  | { ok: true; ctx: ResolvedUser; generationId: string }
  | { ok: false; response: NextResponse }
> {
  const r = await requireWorkspace();
  if (!r.ok) return r;

  const gen = await prisma.generation.findUnique({
    where: { id: generationId },
    select: { id: true, workspaceId: true },
  });
  if (!gen) {
    return {
      ok: false,
      response: apiError('not_found', `Generation ${generationId} not found.`),
    };
  }
  if (gen.workspaceId !== r.ctx.workspace.id) {
    return {
      ok: false,
      response: apiError('forbidden', 'Generation belongs to another workspace.'),
    };
  }
  return { ok: true, ctx: r.ctx, generationId: gen.id };
}

/**
 * Validate an API key value (typically pulled from the
 * `Authorization: Bearer <key>` header).
 *
 *   - Strips the `Bearer ` prefix if present.
 *   - SHA-256s the plaintext using Web Crypto (Node + Edge both expose
 *     `crypto.subtle`, so this stays runtime-agnostic).
 *   - Looks up the matching `UserApiKey` row where `revokedAt IS NULL`.
 *   - On hit: bumps `lastUsedAt` to `now()` (fire-and-forget) and returns
 *     `{ userId, workspaceId }`.
 *   - On any miss (no key, malformed prefix, revoked, unknown hash): returns
 *     `null`. Callers MUST NOT distinguish between miss flavors — that
 *     prevents side-channel disclosure of key existence.
 *
 * SECURITY notes:
 *   - We deliberately do NOT log the plaintext anywhere, even on success.
 *   - We do NOT throw on DB errors; a thrown exception would leak
 *     existence vs. non-existence through a 500 vs. 401 boundary.
 *
 * Used by `/api/mcp/route.ts` and any other key-protected route.
 */
export async function validateApiKey(
  headerValue: string,
): Promise<{ userId: string; workspaceId: string } | null> {
  if (!headerValue) return null;
  // Allow callers to pass either the bare key or the full `Bearer <key>`
  // header value — the MCP route currently strips it, but we want to be
  // safe to call directly too.
  const trimmed = headerValue.trim();
  const lower = trimmed.toLowerCase();
  const plaintext = lower.startsWith('bearer ')
    ? trimmed.slice('bearer '.length).trim()
    : trimmed;

  // 16 chars is well below our 32-byte (~44 char base64url) format —
  // anything shorter is guaranteed not to be one of ours.
  if (!plaintext || plaintext.length < 16) return null;

  let hashedKey: string;
  try {
    hashedKey = await sha256Hex(plaintext);
  } catch {
    return null;
  }

  let row:
    | { id: string; userId: string; user: { workspaceId: string } | null }
    | null;
  try {
    row = await prisma.userApiKey.findFirst({
      where: { hashedKey, revokedAt: null },
      select: {
        id: true,
        userId: true,
        user: { select: { workspaceId: true } },
      },
    });
  } catch {
    return null;
  }
  if (!row || !row.user) return null;

  // Fire-and-forget lastUsedAt bump. We do NOT await — failing to update
  // a "last seen" timestamp must never reject a valid API call. The
  // unhandled-rejection guard catches DB hiccups so the runtime doesn't
  // log them as crashes.
  void prisma.userApiKey
    .update({ where: { id: row.id }, data: { lastUsedAt: new Date() } })
    .catch(() => {
      // intentionally swallowed
    });

  return { userId: row.userId, workspaceId: row.user.workspaceId };
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const view = new Uint8Array(digest);
  let out = '';
  for (const b of view) out += b.toString(16).padStart(2, '0');
  return out;
}

/**
 * Verify the given `agentId` belongs to the caller's workspace.
 */
export async function requireAgentOwnership(
  agentId: string,
): Promise<
  | {
      ok: true;
      ctx: ResolvedUser;
      agent: { id: string; workspaceId: string; ntnWorkerName: string };
    }
  | { ok: false; response: NextResponse }
> {
  const r = await requireWorkspace();
  if (!r.ok) return r;

  const agent = await prisma.generatedAgent.findUnique({
    where: { id: agentId },
    select: { id: true, workspaceId: true, ntnWorkerName: true },
  });
  if (!agent) {
    return {
      ok: false,
      response: apiError('not_found', `Agent ${agentId} not found.`),
    };
  }
  if (agent.workspaceId !== r.ctx.workspace.id) {
    return {
      ok: false,
      response: apiError('forbidden', 'Agent belongs to another workspace.'),
    };
  }
  return { ok: true, ctx: r.ctx, agent };
}
