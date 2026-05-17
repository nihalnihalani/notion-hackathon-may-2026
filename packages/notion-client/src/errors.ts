/**
 * Typed error hierarchy thrown by every `notion-client` method.
 *
 * Mirrors `@forge/connectors/errors` so studio code can `catch` against a
 * familiar shape. Every error carries:
 *  - `status`: the HTTP status the Notion API returned (0 = network failure)
 *  - `body`: the parsed response body (best-effort JSON / text / null)
 *  - `code`: Notion's own machine-readable error code (`object_not_found`,
 *           `validation_error`, etc.) when present in the body
 *
 * Reference: https://developers.notion.com/reference/status-codes
 */

export interface NotionErrorInit {
  status: number;
  body: unknown;
  code?: string | undefined;
  cause?: unknown;
}

/** Provider tag — used by Sentry / logger correlation. */
export const NOTION_PROVIDER = 'notion';

export class NotionError extends Error {
  public readonly status: number;
  public readonly body: unknown;
  public readonly code: string | undefined;
  public readonly provider = NOTION_PROVIDER;

  constructor(message: string, init: NotionErrorInit) {
    super(
      message,
      init.cause === undefined ? undefined : { cause: init.cause },
    );
    this.name = 'NotionError';
    this.status = init.status;
    this.body = init.body;
    this.code = init.code;
  }
}

export class NotionRateLimitError extends NotionError {
  /** Seconds the server asked us to wait (parsed from `Retry-After`). */
  public readonly retryAfter: number | undefined;

  constructor(
    message: string,
    init: NotionErrorInit & { retryAfter?: number },
  ) {
    super(message, init);
    this.name = 'NotionRateLimitError';
    this.retryAfter = init.retryAfter;
  }
}

export class NotionAuthError extends NotionError {
  constructor(message: string, init: NotionErrorInit) {
    super(message, init);
    this.name = 'NotionAuthError';
  }
}

export class NotionNotFoundError extends NotionError {
  constructor(message: string, init: NotionErrorInit) {
    super(message, init);
    this.name = 'NotionNotFoundError';
  }
}

export class NotionValidationError extends NotionError {
  constructor(message: string, init: NotionErrorInit) {
    super(message, init);
    this.name = 'NotionValidationError';
  }
}

/**
 * Pull Notion's machine-readable `code` from the response body if present.
 * Notion error envelope:
 *   { "object": "error", "status": 400, "code": "validation_error",
 *     "message": "…", "request_id": "…" }
 */
function extractNotionCode(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const c = (body as Record<string, unknown>)['code'];
  return typeof c === 'string' ? c : undefined;
}

function extractNotionMessage(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const m = (body as Record<string, unknown>)['message'];
  return typeof m === 'string' ? m : undefined;
}

/**
 * Map a Notion HTTP response to the right typed error.
 *
 * Status code mapping per https://developers.notion.com/reference/status-codes:
 *   400 invalid request / validation_error → NotionValidationError
 *   401 unauthorized / invalid_token       → NotionAuthError
 *   403 restricted_resource                → NotionAuthError
 *   404 object_not_found                   → NotionNotFoundError
 *   409 conflict_error                     → NotionError (conflict; non-retryable)
 *   429 rate_limited                       → NotionRateLimitError
 *   5xx                                    → NotionError (base; retried upstream)
 */
export function errorFromNotionStatus(args: {
  status: number;
  body: unknown;
  retryAfter?: number;
}): NotionError {
  const { status, body, retryAfter } = args;
  const code = extractNotionCode(body);
  const apiMsg = extractNotionMessage(body);
  const baseMsg = `notion request failed: HTTP ${status}${
    code ? ` (${code})` : ''
  }${apiMsg ? ` — ${apiMsg}` : ''}`;

  if (status === 401) {
    return new NotionAuthError(baseMsg, { status, body, code });
  }
  if (status === 403) {
    return new NotionAuthError(baseMsg, { status, body, code });
  }
  if (status === 404) {
    return new NotionNotFoundError(baseMsg, { status, body, code });
  }
  if (status === 400 || status === 422) {
    return new NotionValidationError(baseMsg, { status, body, code });
  }
  if (status === 429) {
    return new NotionRateLimitError(baseMsg, {
      status,
      body,
      code,
      ...(retryAfter === undefined ? {} : { retryAfter }),
    });
  }
  return new NotionError(baseMsg, { status, body, code });
}
