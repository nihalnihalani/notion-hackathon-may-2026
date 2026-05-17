/**
 * Error hierarchy for `@forge/mcp-server`.
 *
 * MCP defines two error channels:
 *
 *   1. **Protocol errors** — JSON-RPC `error` envelope. Returned by the
 *      transport for malformed messages / unknown methods. We don't construct
 *      these manually; the SDK does.
 *
 *   2. **Tool execution errors** — `{ isError: true, content: [{type:'text',
 *      text: ... }] }` inside a tool's CallToolResult. This is the right
 *      channel for "the tool ran but couldn't do its job" (e.g., the
 *      workflow trigger threw, the requested generation doesn't exist, the
 *      input failed business validation).
 *
 * Why one class per failure mode (instead of a single error with a `code`
 * field): each call site gets a typed catch and a code that flows into both
 * the MCP text payload and structured logs.
 *
 * The {@link toMcpErrorContent} helper turns any thrown value into the
 * `{isError: true, content: [...]}` shape the SDK expects.
 */

/** Stable, sortable error codes — keep in sync with logged-error dashboards. */
export type ForgeMcpErrorCode =
  | 'workflow_trigger_failed'
  | 'generation_not_found'
  | 'agent_list_failed'
  | 'invalid_input'
  | 'forbidden'
  | 'internal_error';

/**
 * Base class for everything thrown from this package. Carries a stable
 * `code` plus optional structured metadata that is safe to surface to the
 * MCP client (no PII, no secrets).
 */
export class ForgeMcpError extends Error {
  override readonly name: string = 'ForgeMcpError';
  readonly code: ForgeMcpErrorCode;
  readonly metadata: Readonly<Record<string, unknown>>;

  constructor(
    code: ForgeMcpErrorCode,
    message: string,
    options?: { cause?: unknown; metadata?: Record<string, unknown> },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.metadata = Object.freeze({ ...options?.metadata });
  }
}

/** The workflow trigger callback rejected. Likely transient. */
export class WorkflowTriggerError extends ForgeMcpError {
  override readonly name = 'WorkflowTriggerError';
  constructor(message: string, options?: { cause?: unknown; metadata?: Record<string, unknown> }) {
    super('workflow_trigger_failed', message, options);
  }
}

/**
 * `get_generation_status` was asked for an id that doesn't exist (or
 * belongs to another workspace — we intentionally don't distinguish, since
 * leaking existence is itself an info-disclosure bug).
 */
export class GenerationNotFoundError extends ForgeMcpError {
  override readonly name = 'GenerationNotFoundError';
  constructor(id: string) {
    super('generation_not_found', `No generation with id ${id} in this workspace.`, {
      metadata: { generationId: id },
    });
  }
}

/** `list_my_agents` DB read failed. */
export class AgentListError extends ForgeMcpError {
  override readonly name = 'AgentListError';
  constructor(message: string, options?: { cause?: unknown }) {
    super('agent_list_failed', message, options);
  }
}

/**
 * Input failed semantic validation that zod couldn't catch (e.g., business
 * rule).
 */
export class InvalidInputError extends ForgeMcpError {
  override readonly name = 'InvalidInputError';
  constructor(message: string, metadata?: Record<string, unknown>) {
    super('invalid_input', message, metadata ? { metadata } : undefined);
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Wrap any thrown value into MCP's tool-error CallToolResult shape.
 *
 * Includes a `structuredContent` block alongside the human-readable text so
 * clients that want to react programmatically don't have to parse the
 * message. The text content is kept readable for clients that don't.
 *
 * NEVER include the underlying `cause` chain in the user-facing payload —
 * stack traces leak file paths / DB column names / etc.
 */
export function toMcpErrorContent(err: unknown): {
  [key: string]: unknown;
  isError: true;
  content: { type: 'text'; text: string }[];
  structuredContent: { error: { code: ForgeMcpErrorCode; message: string; metadata: Record<string, unknown> } };
} {
  const wrapped = err instanceof ForgeMcpError ? err : toGenericForgeError(err);
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: `[${wrapped.code}] ${wrapped.message}`,
      },
    ],
    structuredContent: {
      error: {
        code: wrapped.code,
        message: wrapped.message,
        metadata: { ...wrapped.metadata },
      },
    },
  };
}

/**
 * Normalize a non-ForgeMcpError throw site into a generic `internal_error`.
 * Stringification is defensive — the value may be a plain object, a primitive,
 * or null.
 */
function toGenericForgeError(err: unknown): ForgeMcpError {
  const message =
    err instanceof Error
      ? err.message
      : (typeof err === 'string'
        ? err
        : 'Unknown internal error');
  return new ForgeMcpError('internal_error', message, { cause: err });
}
