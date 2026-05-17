/**
 * Internal-token validator for `/api/forge/log` and `/api/billing/usage`.
 *
 * The token is the value of `FORGE_INTERNAL_TOKEN` (env). It is shared by:
 *   - Vercel Workflow steps that call back into the API to append Build Log
 *   - Future internal Cron jobs that push usage events to Stripe
 *
 * Security:
 *   - Constant-time comparison via byte-XOR (no `crypto.timingSafeEqual` on
 *     Edge runtime).
 *   - Fail-closed: if the env var is unset OR equals the placeholder
 *     `REPLACE_ME`, every call returns `false`. `scripts/verify-env.ts`
 *     enforces this at deploy time but the runtime check is the last line.
 */

const PLACEHOLDER = 'REPLACE_ME';

/** Constant-time string equality. Both sides must already be the same length;
 *  the length-check itself is a non-secret short-circuit. */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Validate the `Authorization: Bearer <token>` header against
 * `FORGE_INTERNAL_TOKEN`. Returns `true` only when both:
 *
 *   1. The env var is set AND not the placeholder.
 *   2. The bearer value matches the env exactly (constant-time).
 */
export function validateForgeInternalToken(req: Request): boolean {
  const expected = process.env['FORGE_INTERNAL_TOKEN'];
  if (!expected || expected === PLACEHOLDER) return false;

  const header = req.headers.get('authorization');
  if (!header) return false;
  if (!header.toLowerCase().startsWith('bearer ')) return false;
  const provided = header.slice('bearer '.length).trim();
  if (!provided) return false;
  return constantTimeEqual(provided, expected);
}
