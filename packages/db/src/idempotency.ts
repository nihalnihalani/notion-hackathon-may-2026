/**
 * Idempotency helpers — pure functions, safe to call from any runtime
 * (Node, Edge, browser if ever needed).
 *
 * The contract from PLAN.md Part VI:
 *
 *   descriptionHash = sha256(workspaceId || normalize(description))
 *
 * `normalize` is:
 *   1. trim leading/trailing whitespace
 *   2. lowercase
 *   3. collapse all internal whitespace runs (spaces, tabs, newlines) into a
 *      single space
 *
 * Same workspace + semantically-equivalent description → same hash → we can
 * short-circuit a new Generation to the cached GeneratedAgent.
 *
 * IMPORTANT: This function performs no IO. It is intentionally synchronous in
 * spirit (the async wrapping comes from the Web Crypto API, not from us). Do
 * not add network calls, DB lookups, or logging here — callers depend on it
 * being side-effect-free.
 */

/**
 * Normalize a free-text description so that trivial whitespace / casing
 * differences don't defeat the idempotency cache.
 *
 * Examples:
 *   normalize("  Triage Linear bugs ")        === "triage linear bugs"
 *   normalize("triage\n  linear\tbugs")       === "triage linear bugs"
 *   normalize("Triage Linear Bugs")           === "triage linear bugs"
 */
export function normalize(description: string): string {
  return description.trim().toLowerCase().replaceAll(/\s+/g, " ");
}

/**
 * Compute the SHA-256 hex digest of `workspaceId || normalize(description)`.
 *
 * Uses Web Crypto (`globalThis.crypto.subtle`) so this works on both the Node
 * and Edge runtimes. Node 20+ exposes `globalThis.crypto` natively. On Edge it
 * is always available.
 *
 * Returns a lowercase hex string of length 64 (matches the
 * `@db.VarChar(64)` constraint on `Generation.descriptionHash` and
 * `PromptCache.descriptionHash`).
 */
export async function descriptionHash(
  workspaceId: string,
  description: string,
): Promise<string> {
  const input = `${workspaceId}${normalize(description)}`;
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return bufferToHex(digest);
}

/**
 * Lowercase hex encoding of an ArrayBuffer. Pulled out for testability.
 */
function bufferToHex(buffer: ArrayBuffer): string {
  const view = new Uint8Array(buffer);
  let out = "";
  for (const byte of view) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}
