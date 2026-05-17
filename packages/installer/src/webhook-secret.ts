/**
 * Per-workspace webhook secret generator.
 *
 * We mint a cryptographically random 256-bit secret on first install and
 * persist it on the `Workspace` row. The Forge webhook endpoint
 * (`/api/webhooks/notion-button`) uses it to verify the HMAC-SHA256 in
 * `X-Notion-Signature` via {@link verifyNotionWebhookSignature} in
 * `@forge/notion-client`.
 *
 * Format: 64-character lowercase hex (256 bits of entropy). We pick hex
 * over base64url so the value is safe to include in URL query strings,
 * config files, and audit logs without escaping concerns.
 *
 * Edge-runtime safe: uses Web Crypto (`crypto.getRandomValues`), never
 * `node:crypto`. The installer runs from Vercel Functions which may be
 * deployed to the Edge or Node runtime depending on the route config.
 */

/** Number of random bytes — 256 bits matches what Notion uses for its own
 *  verification tokens and gives a safe margin against birthday attacks. */
const SECRET_BYTES = 32;

/** Lower-case hex encoder for an arbitrary Uint8Array. */
function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, '0');
  }
  return out;
}

/**
 * Generate a fresh 256-bit per-workspace webhook secret.
 *
 * @returns 64-char lowercase hex string.
 *
 * @example
 *   const secret = generateWorkspaceWebhookSecret();
 *   await db.updateWorkspaceForgeRecord(workspaceId, { webhookSecret: secret });
 */
export function generateWorkspaceWebhookSecret(): string {
  const bytes = new Uint8Array(SECRET_BYTES);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}
