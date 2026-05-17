/**
 * Notion webhook signature verification.
 *
 * Notion webhooks ship the HMAC of the request body in the `X-Notion-Signature`
 * header. The HMAC is keyed by the `verification_token` returned to us during
 * subscription verification and stored at install-time per workspace.
 *
 * Wire format (verified via https://developers.notion.com/reference/webhooks
 * as of 2026-05-17):
 *
 *   X-Notion-Signature: sha256=<hex-digest>
 *
 * The digest is `HMAC_SHA256(verificationToken, JSON.stringify(body))`. Note
 * that the body Notion signs is the **JSON-minified** body — i.e. exactly
 * what `JSON.stringify(parsedBody)` produces — NOT the raw bytes you may have
 * already pretty-printed. For maximum interop we accept the raw body **as a
 * string** and tell callers to pass it untouched (most Edge frameworks let
 * you grab `await req.text()` before parsing).
 *
 * This module is Edge-runtime safe: it uses `crypto.subtle` (Web Crypto)
 * exclusively, never `node:crypto`. Constant-time comparison is implemented
 * manually because `crypto.subtle` does not expose `timingSafeEqual`.
 *
 * Docs cited:
 *   https://developers.notion.com/reference/webhooks
 */

export interface VerifyWebhookInput {
  /** Raw request body **as a string**. Pass `await req.text()` directly. */
  rawBody: string;
  /** Header map. Case-insensitive lookup is performed internally. */
  headers: Record<string, string> | Headers;
  /** The per-workspace `verification_token` stored at install time. */
  secret: string;
  /** Override the header name for testing. Defaults to `x-notion-signature`. */
  headerName?: string;
}

export interface VerifyWebhookResult {
  valid: boolean;
  /** Populated when `valid === false` — for logging, never sent to caller. */
  reason?: string;
}

const DEFAULT_HEADER_NAME = 'x-notion-signature';
const SIG_PREFIX = 'sha256=';

function getHeader(headers: Record<string, string> | Headers, name: string): string | undefined {
  if (headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }
  // Case-insensitive lookup over a plain record.
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

/**
 * Constant-time string equality. Both strings are decoded to bytes via
 * TextEncoder so multibyte attackers can't shorten the comparison. Returns
 * `false` immediately on length mismatch — that's not a side-channel because
 * the *attacker already knows* the expected length (it's a fixed-length hex
 * SHA-256 = 64 chars).
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const enc = new TextEncoder();
  const A = enc.encode(a);
  const B = enc.encode(b);
  if (A.length !== B.length) return false;
  let diff = 0;
  for (const [i, element] of A.entries()) {
    const expected = B[i];
    if (expected === undefined) return false;
    diff |= element ^ expected;
  }
  return diff === 0;
}

/** Lower-case hex encoding of a byte array (no `Buffer` — Edge safe). */
function toHex(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let out = '';
  for (const element of view) {
    out += element.toString(16).padStart(2, '0');
  }
  return out;
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return toHex(sig);
}

/**
 * Verify a Notion webhook signature.
 *
 * Returns `{ valid: true }` on success or `{ valid: false, reason }` on
 * failure. **Never throws** for verification failures — only for malformed
 * inputs (missing secret). This shape lets caller code use a single
 * `if (!result.valid) return new Response(null, { status: 401 })` branch.
 *
 * @example
 *   const raw = await req.text();
 *   const result = await verifyNotionWebhookSignature({
 *     rawBody: raw,
 *     headers: req.headers,
 *     secret: workspace.notionVerificationToken,
 *   });
 *   if (!result.valid) {
 *     logger.warn('webhook rejected', { reason: result.reason });
 *     return new Response(null, { status: 401 });
 *   }
 *   const body = JSON.parse(raw);
 *   // …handle event…
 */
export async function verifyNotionWebhookSignature(
  input: VerifyWebhookInput,
): Promise<VerifyWebhookResult> {
  if (!input.secret) {
    return { valid: false, reason: 'missing_secret' };
  }

  const headerName = input.headerName ?? DEFAULT_HEADER_NAME;
  const provided = getHeader(input.headers, headerName);
  if (!provided) {
    return { valid: false, reason: 'missing_signature_header' };
  }
  if (!provided.startsWith(SIG_PREFIX)) {
    return { valid: false, reason: 'invalid_signature_format' };
  }

  const providedHex = provided.slice(SIG_PREFIX.length);
  if (providedHex.length !== 64 || !/^[0-9a-f]+$/i.test(providedHex)) {
    return { valid: false, reason: 'invalid_signature_encoding' };
  }

  const expectedHex = await hmacSha256Hex(input.secret, input.rawBody);
  // Normalize case so a server that sends upper-case hex still verifies.
  if (constantTimeEqual(providedHex.toLowerCase(), expectedHex)) {
    return { valid: true };
  }
  return { valid: false, reason: 'signature_mismatch' };
}

/** Exposed for test parity with the constant-time helper. */
export const __test = { constantTimeEqual, hmacSha256Hex };
