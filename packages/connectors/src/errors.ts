/**
 * Typed error hierarchy thrown by every connector.
 *
 * Every error carries the HTTP status, the parsed body (best-effort), and
 * the provider name so generated agent code can catch + react narrowly.
 */

export interface ConnectorErrorInit {
  status: number;
  body: unknown;
  provider: string;
  cause?: unknown;
}

export class ConnectorError extends Error {
  public readonly status: number;
  public readonly body: unknown;
  public readonly provider: string;

  constructor(message: string, init: ConnectorErrorInit) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = 'ConnectorError';
    this.status = init.status;
    this.body = init.body;
    this.provider = init.provider;
  }
}

export class RateLimitError extends ConnectorError {
  /** Seconds the server asked us to wait (from Retry-After). */
  public readonly retryAfter: number | undefined;

  constructor(
    message: string,
    init: ConnectorErrorInit & { retryAfter?: number },
  ) {
    super(message, init);
    this.name = 'RateLimitError';
    this.retryAfter = init.retryAfter;
  }
}

export class AuthError extends ConnectorError {
  constructor(message: string, init: ConnectorErrorInit) {
    super(message, init);
    this.name = 'AuthError';
  }
}

export class NotFoundError extends ConnectorError {
  constructor(message: string, init: ConnectorErrorInit) {
    super(message, init);
    this.name = 'NotFoundError';
  }
}

export class ValidationError extends ConnectorError {
  constructor(message: string, init: ConnectorErrorInit) {
    super(message, init);
    this.name = 'ValidationError';
  }
}

/**
 * Maps HTTP status → typed error. Used by the shared HTTP helper after
 * retries are exhausted (or immediately for non-retryable statuses).
 */
export function errorFromStatus(args: {
  status: number;
  body: unknown;
  provider: string;
  retryAfter?: number;
}): ConnectorError {
  const { status, body, provider, retryAfter } = args;
  const message = `${provider} request failed: HTTP ${status}`;
  if (status === 401 || status === 403) {
    return new AuthError(message, { status, body, provider });
  }
  if (status === 404) {
    return new NotFoundError(message, { status, body, provider });
  }
  if (status === 422 || status === 400) {
    return new ValidationError(message, { status, body, provider });
  }
  if (status === 429) {
    return new RateLimitError(message, {
      status,
      body,
      provider,
      ...(retryAfter === undefined ? {} : { retryAfter }),
    });
  }
  return new ConnectorError(message, { status, body, provider });
}
