/**
 * Typed error hierarchy thrown by the four Forge sub-agents.
 *
 * Each error carries the originating agent name and an optional `cause` so the
 * orchestrator can decide whether to retry, fall back to a different model, or
 * surface a clarifying message in the user's Notion Build Log.
 *
 * Production rule: sub-agent code MUST throw one of these typed errors — never
 * a bare `Error`. Outer Inngest / Workflow DevKit retries inspect the class to
 * decide the retry strategy.
 */

/**
 * Init payload for every {@link SubAgentError}.
 */
export interface SubAgentErrorInit {
  /**
   * Stable, machine-readable name of the agent that threw, e.g.
   * `schema_smith` / `tool_coder` / `inspector` / `shipper`. Mirrors the
   * `AgentName` enum in `@forge/db`.
   */
  agentName: string;
  /** Optional structured detail object for diagnostics. */
  detail?: Record<string, unknown>;
  /** Underlying cause (preserved on the `cause` property of {@link Error}). */
  cause?: unknown;
}

/**
 * Base class for every sub-agent error. Concrete sub-classes set `name`.
 */
export class SubAgentError extends Error {
  /** The agent that threw (one of: `schema_smith` / `tool_coder` / `inspector` / `shipper`). */
  public readonly agentName: string;

  /** Optional structured detail. Never includes secrets — safe to log. */
  public readonly detail: Record<string, unknown> | undefined;

  public constructor(message: string, init: SubAgentErrorInit) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = 'SubAgentError';
    this.agentName = init.agentName;
    this.detail = init.detail;
  }
}

/**
 * Thrown by Schema Smith when:
 *  - the model returns invalid JSON after the allowed retry, or
 *  - the JSchemaSpec fails round-trip validation after retry, or
 *  - both primary + fallback providers fail.
 */
export class SchemaSmithError extends SubAgentError {
  public constructor(
    message: string,
    init: Omit<SubAgentErrorInit, 'agentName'> & Partial<Pick<SubAgentErrorInit, 'agentName'>>,
  ) {
    super(message, { agentName: 'schema_smith', ...init });
    this.name = 'SchemaSmithError';
  }
}

/**
 * Thrown by Tool Coder when code generation fails the AST parse retry
 * threshold or when the dep-allowlist is violated.
 */
export class ToolCoderError extends SubAgentError {
  public constructor(
    message: string,
    init: Omit<SubAgentErrorInit, 'agentName'> & Partial<Pick<SubAgentErrorInit, 'agentName'>>,
  ) {
    super(message, { agentName: 'tool_coder', ...init });
    this.name = 'ToolCoderError';
  }
}

/**
 * Thrown by Inspector when sandbox orchestration itself fails (e.g. Sandbox
 * unreachable). Failed-but-completed validations are returned as
 * `InspectionResult { pass: false, ... }` — not thrown.
 */
export class InspectorError extends SubAgentError {
  public constructor(
    message: string,
    init: Omit<SubAgentErrorInit, 'agentName'> & Partial<Pick<SubAgentErrorInit, 'agentName'>>,
  ) {
    super(message, { agentName: 'inspector', ...init });
    this.name = 'InspectorError';
  }
}

/**
 * Thrown by Shipper when the final deploy / Custom Agent wiring fails.
 */
export class ShipperError extends SubAgentError {
  public constructor(
    message: string,
    init: Omit<SubAgentErrorInit, 'agentName'> & Partial<Pick<SubAgentErrorInit, 'agentName'>>,
  ) {
    super(message, { agentName: 'shipper', ...init });
    this.name = 'ShipperError';
  }
}

/**
 * Thrown when both the primary provider AND the configured fallback fail.
 * The orchestrator surfaces this as a hard generation failure (no retry).
 */
export class ProviderFallbackError extends SubAgentError {
  public constructor(message: string, init: SubAgentErrorInit) {
    super(message, init);
    this.name = 'ProviderFallbackError';
  }
}
