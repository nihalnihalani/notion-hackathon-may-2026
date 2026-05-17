/**
 * Shared types used by every connector.
 *
 * Connectors are pure factories: nothing reads from `process.env`. All inputs
 * (apiKey, baseUrl, fetch impl) are passed via {@link ConnectorConfig}. This
 * keeps connectors Edge-runtime safe and trivially mockable in tests.
 */

/**
 * The shape of any fetch-like function. Lets callers inject a custom fetch
 * implementation (for tests, instrumentation, or alternate runtimes) while
 * still defaulting to the platform's native `fetch`.
 */
export type FetchLike = (
  url: string | URL,
  init?: RequestInit,
) => Promise<Response>;

/**
 * Base config every connector accepts.
 */
export interface ConnectorConfig {
  /** Auth credential for the provider — bearer token, API key, etc. */
  apiKey: string;
  /** Override the provider's base URL (useful for self-hosted / gateway). */
  baseUrl?: string;
  /** Inject a custom fetch implementation. Defaults to global `fetch`. */
  fetch?: FetchLike;
}

/**
 * Retry behaviour for the shared HTTP helper.
 *
 * The defaults are tuned for typical SaaS APIs:
 *  - 3 retries (4 total attempts)
 *  - 250ms initial delay, exponential backoff (×2 per attempt)
 *  - capped at 8s per delay
 *  - full jitter to avoid retry storms
 */
export interface RetryOptions {
  retries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  jitter: boolean;
}

export const DEFAULT_RETRY: RetryOptions = {
  retries: 3,
  initialDelayMs: 250,
  maxDelayMs: 8000,
  jitter: true,
};

/**
 * Rate-limit info parsed from response headers when available.
 * Connectors that surface rate-limit headers populate this; otherwise
 * callers fall back to {@link RateLimitError.retryAfter}.
 */
export interface RateLimitInfo {
  remaining: number;
  resetAt: Date;
}

/**
 * Per-request override options accepted by every connector method.
 *
 * - `validate`: when `true`, the response body is run through the connector's
 *   zod schema. Default `false`: LLM-generated code is the primary caller,
 *   we trust the API more than the LLM but validation is opt-in.
 * - `retry`: override the default {@link RetryOptions} for a single call.
 * - `signal`: AbortSignal — required for cancellation in workflow steps.
 */
export interface RequestOptions {
  validate?: boolean;
  retry?: Partial<RetryOptions>;
  signal?: AbortSignal;
}
