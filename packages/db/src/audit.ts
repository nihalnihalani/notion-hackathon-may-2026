/**
 * Audit log writer.
 *
 * The audit log is APPEND-ONLY. There are no `update` or `delete` exports from
 * this module — that is the API-surface enforcement requested in our brief.
 * Because PlanetScale Postgres does not support triggers in a way we can
 * safely manage at migrate-time, we rely on:
 *
 *   1. This module being the *only* writer of `AuditLog` rows.
 *   2. The repository layer never importing `prisma.auditLog.update` /
 *      `.delete` / `.deleteMany`.
 *   3. A lint rule (added at repo level, not here) banning direct
 *      `prisma.auditLog.*` access outside this file.
 *
 * SECURITY — metadata must NEVER contain PII
 * ------------------------------------------
 * The `metadata` JSON field is meant for operational context: ids, counts,
 * latency, pattern names, deploy URLs, error codes. It must NOT contain:
 *
 *   - user emails or names
 *   - access tokens, refresh tokens, API keys, OAuth secrets
 *   - raw user prompts or generated source code
 *   - IP addresses (those go on the dedicated `ipAddress` column)
 *
 * The `AuditEventInput` discriminated union restricts each variant's metadata
 * shape to a small whitelist of non-PII fields. Reviewers should reject any
 * PR that widens these shapes to free-form strings.
 */

import { z } from "zod";

import { prisma } from "./client.js";
import type { AuditEvent } from "./types.js";

const baseSchema = z.object({
  workspaceId: z.string().min(1),
  userId: z.string().min(1).nullable(),
  resourceType: z.string().min(1),
  resourceId: z.string().min(1),
  ipAddress: z.string().nullable().optional(),
  userAgent: z.string().nullable().optional(),
});

// Each variant's metadata is constrained to a small set of non-PII fields.
const variantSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("agent.deployed"),
    metadata: z.object({
      ntnWorkerName: z.string().min(1),
      pattern: z.string().min(1),
      generationId: z.string().min(1),
    }),
  }),
  z.object({
    action: z.literal("agent.deleted"),
    metadata: z.object({
      ntnWorkerName: z.string().min(1),
      reason: z.enum(["user_request", "system_retraction", "policy_violation"]),
    }),
  }),
  z.object({
    action: z.literal("oauth.granted"),
    metadata: z.object({
      provider: z.string().min(1),
      scopes: z.array(z.string()),
    }),
  }),
  z.object({
    action: z.literal("agent.invoked"),
    metadata: z.object({
      ntnWorkerName: z.string().min(1),
      latencyMs: z.number().int().nonnegative(),
      success: z.boolean(),
    }),
  }),
  z.object({
    action: z.literal("workspace.installed"),
    metadata: z.object({
      forgePageId: z.string().min(1),
      forgeDbId: z.string().min(1),
    }),
  }),
  z.object({
    action: z.literal("generation.failed"),
    metadata: z.object({
      generationId: z.string().min(1),
      failedStep: z.string().min(1),
      errorCode: z.string().min(1),
    }),
  }),
]);

const auditSchema = baseSchema.and(variantSchema);

/**
 * Append a single audit event.
 *
 * Returns `void` on purpose — callers don't need the inserted row, and not
 * returning it discourages "audit-driven" application logic. Audit must be a
 * passive trail, never the source of business state.
 *
 * Throws on validation failure (programming error) and on DB error
 * (infrastructure issue). The decision to swallow or escalate belongs to the
 * caller; for most code paths the right move is `try { await
 * recordAuditEvent(...) } catch (e) { logger.error(e) }` so a transient DB
 * outage cannot block a user-facing operation. For genuinely security-critical
 * events (`oauth.granted`), prefer to fail closed.
 */
export async function recordAuditEvent(params: AuditEvent): Promise<void> {
  const parsed = auditSchema.parse(params);

  await prisma.auditLog.create({
    data: {
      workspaceId: parsed.workspaceId,
      userId: parsed.userId,
      action: parsed.action,
      resourceType: parsed.resourceType,
      resourceId: parsed.resourceId,
      metadata: parsed.metadata,
      ipAddress: parsed.ipAddress ?? null,
      userAgent: parsed.userAgent ?? null,
    },
  });
}
