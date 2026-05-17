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
} from '@prisma/client';

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
      action: 'agent.deployed';
      metadata: {
        ntnWorkerName: string;
        pattern: string;
        generationId: string;
      };
    }
  | {
      action: 'agent.paused';
      metadata: {
        workerName: string;
      };
    }
  | {
      action: 'agent.resumed';
      metadata: {
        workerName: string;
      };
    }
  | {
      action: 'agent.deleted';
      metadata: {
        // `workerName` for new call sites; `ntnWorkerName` for the
        // legacy /api/agents DELETE handler. Either is allowed for
        // backward compatibility — both refer to the same value.
        workerName?: string;
        ntnWorkerName?: string;
        reason?: 'user' | 'user_request' | 'system_retraction' | 'policy_violation';
      };
    }
  | {
      action: 'oauth.granted';
      metadata: {
        provider: string; // "notion" | "github" | "linear" | ...
        scopes?: readonly string[];
      };
    }
  | {
      action: 'oauth.revoked';
      metadata: {
        provider: string;
      };
    }
  | {
      action: 'agent.invoked';
      metadata: {
        ntnWorkerName: string;
        latencyMs: number;
        success: boolean;
      };
    }
  | {
      action: 'workspace.installed';
      metadata: {
        forgePageId: string;
        forgeDbId: string;
      };
    }
  | {
      action: 'generation.cancelled';
      metadata: {
        reason: 'user' | 'timeout' | 'admin';
      };
    }
  | {
      action: 'generation.failed';
      metadata:
        | {
            generationId: string;
            failedStep: string;
            errorCode: string;
          }
        | {
            stage: string;
            errorMessage: string;
          };
    }
  | {
      action: 'webhook.signature_failure';
      metadata: {
        endpoint: string;
      };
    }
  | {
      action: 'workspace.default_model_changed';
      metadata: {
        previousModel: string;
        newModel: string;
      };
    }
  | {
      action: 'workspace.uninstalled';
      // Empty metadata object: the workspace id + actor is already on the
      // base columns. Kept as a closed shape so reviewers see — and reject —
      // any attempt to add PII fields here later.
      metadata: Record<string, never>;
    }
  | {
      action: 'api_key.created';
      metadata: {
        keyId: string;
        prefix: string;
        name: string;
      };
    }
  | {
      action: 'api_key.revoked';
      metadata: {
        keyId: string;
      };
    }
  | {
      action: 'agent.redeployed';
      metadata: {
        agentId: string;
        workerName: string;
        newGenerationId: string;
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
  generationsCount?: number | undefined;
  deploysCount?: number | undefined;
  invocationsCount?: number | undefined;
  /** USD; Decimal in the DB. Pass as `number` for ergonomics, we coerce. */
  totalLlmCostUsd?: number | undefined;
  totalSandboxSeconds?: number | undefined;
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
