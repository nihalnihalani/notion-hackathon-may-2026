/**
 * Structured JSON error responses for every API route.
 *
 * Contract (PLAN.md §VI): every route returns
 *
 *   { error: '<kind>', message?: string, issues?: unknown[] }
 *
 * with the matching HTTP status. The body NEVER contains a stack trace —
 * Sentry receives the full exception via {@link withSentry} and clients only
 * see the safe-to-show summary.
 *
 * Pure module — no IO, no env reads. Safe in Edge and Node runtimes.
 */

import { NextResponse } from 'next/server';
import type { ZodIssue } from 'zod';

/**
 * Canonical error `kind` values. Listed centrally so the frontend can switch
 * on them without grepping the route handlers. New kinds must be added here.
 */
export type ApiErrorKind =
  | 'validation'
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'idempotent_conflict'
  | 'upstream_failure'
  | 'method_not_allowed'
  | 'internal';

/** Default HTTP status for each error kind. Routes may override per-call. */
const DEFAULT_STATUS: Record<ApiErrorKind, number> = {
  validation: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  rate_limited: 429,
  idempotent_conflict: 409,
  upstream_failure: 502,
  method_not_allowed: 405,
  internal: 500,
};

export interface ApiErrorBody {
  error: ApiErrorKind;
  message: string;
  /** Populated for `validation` errors with the zod issue array. */
  issues?: readonly ZodIssue[];
}

/**
 * Return a `NextResponse` with a uniform error envelope.
 *
 * @example
 *   if (!parsed.success) return apiError('validation', 'bad input', { issues: parsed.error.issues });
 */
export function apiError(
  kind: ApiErrorKind,
  message: string,
  options?: { status?: number; issues?: readonly ZodIssue[] },
): NextResponse<ApiErrorBody> {
  const status = options?.status ?? DEFAULT_STATUS[kind];
  const body: ApiErrorBody = { error: kind, message };
  if (options?.issues) body.issues = options.issues;
  return NextResponse.json(body, { status });
}
