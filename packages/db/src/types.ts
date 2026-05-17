/**
 * Re-exports + domain-level types for `@forge/db`.
 *
 * Two categories:
 *
 *  1. Pass-through of generated Prisma types so consumers can type their own
 *     functions without depending on `@prisma/client` directly. (Keeps the
 *     dependency surface clean: only `@forge/db` knows about Prisma.)
 *
 *  2. Hand-written domain types — discriminated unions and value objects —
 *     that the helpers in this package expect as inputs (`audit.ts`,
 *     `usage-meter.ts`).
 */

export type {
  AgentName,
  AgentPattern,
  AgentStatus,
  AuditLog,
  Evaluation,
  GeneratedAgent,
  Generation,
  GenerationStatus,
  GenerationStep,
  Prisma,
  PrismaClient,
  PromptCache,
  StepStatus,
  UsageMeter,
  User,
  Workspace,
} from "@prisma/client";

// -----------------------------------------------------------------------------
// Audit log
// -----------------------------------------------------------------------------

/**
 * Common fields present on every audit event.
 *
 * `metadata` is intentionally typed as `Record<string, unknown>` (not `any`):
 * each variant of `AuditEventInput` below pins it down to a concrete shape.
 *
 * SECURITY: `metadata` must never contain PII (emails, names, tokens). See
 * `audit.ts` for the full rules. The DB does not enforce this; the typed input
 * union is our primary guard.
 */
export interface AuditEventBase {
  workspaceId: string;
  /**
   * The acting Clerk user id, mapped through `User.id` by the caller. `null`
   * for system-initiated events (e.g. a Workflow retry succeeding).
   */
  userId: string | null;
  resourceType: string;
  resourceId: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/**
 * Discriminated union of every audit event we currently emit. Adding a new
 * `action` requires extending this union — that's intentional. It forces the
 * call site, the audit writer, and any future consumer (compliance export,
 * dashboards) to stay in sync.
 *
 * The set mirrors the events listed in PLAN.md Part X (Observability +
 * Security) and the AuditLog model in Part V.
 */
export type AuditEventInput =
  | {
      action: "agent.deployed";
      metadata: {
        ntnWorkerName: string;
        pattern: string;
        generationId: string;
      };
    }
  | {
      action: "agent.deleted";
      metadata: {
        ntnWorkerName: string;
        reason: "user_request" | "system_retraction" | "policy_violation";
      };
    }
  | {
      action: "oauth.granted";
      metadata: {
        provider: string; // "notion" | "github" | "linear" | ...
        scopes: ReadonlyArray<string>;
      };
    }
  | {
      action: "agent.invoked";
      metadata: {
        ntnWorkerName: string;
        latencyMs: number;
        success: boolean;
      };
    }
  | {
      action: "workspace.installed";
      metadata: {
        forgePageId: string;
        forgeDbId: string;
      };
    }
  | {
      action: "generation.failed";
      metadata: {
        generationId: string;
        failedStep: string;
        errorCode: string;
      };
    };

/**
 * Combined input shape consumed by `recordAuditEvent`.
 */
export type AuditEvent = AuditEventBase & AuditEventInput;

// -----------------------------------------------------------------------------
// Usage meter
// -----------------------------------------------------------------------------

/**
 * Counter / sum fields on `UsageMeter` that may be incremented on a write.
 *
 * All are non-negative deltas applied to today's row (UTC date), upserted.
 */
export interface UsageMeterFields {
  generationsCount?: number;
  deploysCount?: number;
  invocationsCount?: number;
  /** USD; Decimal in the DB. Pass as `number` for ergonomics, we coerce. */
  totalLlmCostUsd?: number;
  totalSandboxSeconds?: number;
}

/**
 * Aggregated usage across a date range, as returned by `getUsageSince`.
 *
 * `totalLlmCostUsd` is summed in JS as `number` for caller ergonomics —
 * acceptable because our pricing model never exceeds 4 decimal places and we
 * cap the daily cost ceiling well below floating-point precision limits.
 */
export interface UsageMeterAggregate {
  workspaceId: string;
  since: Date;
  generationsCount: number;
  deploysCount: number;
  invocationsCount: number;
  totalLlmCostUsd: number;
  totalSandboxSeconds: number;
}
