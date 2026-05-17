/**
 * Custom Agent wiring helper for the Shipper sub-agent.
 *
 * Job (PLAN.md §IV.4 step 3): given a freshly-deployed Worker, attach its
 * capabilities (tools / syncs / webhooks) to a Notion Custom Agent so the
 * agent can call them from a chat.
 *
 * ─── What we confirmed about Notion's REST surface (2026-05-17) ────────────
 *
 * The Notion Developer Platform docs at
 *   https://developers.notion.com/reference/intro
 *   https://developers.notion.com/llms.txt
 * do NOT expose a documented REST endpoint for creating or modifying Custom
 * Agents. The platform model is:
 *
 *   - Workers expose **capabilities** (tools / syncs / webhooks). These are
 *     declared in the worker source and discovered server-side after
 *     `ntn workers deploy` succeeds.
 *
 *   - A user wires those capabilities into a Custom Agent through the Notion
 *     Settings → Custom Agents UI. The UI offers an "Add tool from a worker"
 *     picker; tools attached this way are immediately callable from the
 *     agent's chat.
 *
 *   - There is no documented `POST /v1/custom_agents/.../tools` (or similar)
 *     endpoint as of Notion-Version 2026-03-11 — this is the Devil's
 *     Advocate concern raised in PLAN.md §4.4 and the documented fallback.
 *
 * ─── Strategy ──────────────────────────────────────────────────────────────
 *
 * We attempt the (unofficial / hypothetical) REST endpoint first because the
 * surface may land at any time without us noticing; on the 404 we fall back
 * to a deep-link to the Notion Settings UI. The fallback is one user click —
 * the brief and the PLAN both call that out as acceptable.
 *
 * The attempt is deliberately conservative: a single POST with a 5s timeout
 * and zero retries. If the endpoint is genuinely available some day, this
 * helper still returns within the Shipper step's deadline.
 *
 * ─── No outer retries ──────────────────────────────────────────────────────
 *
 * The Workflow DevKit's retry policy already covers Notion 429s / 5xx for
 * Build-Log writes and other Notion REST calls. Adding a second retry layer
 * here would compound the wait when the endpoint is permanently 404. We
 * surface every failure as the fallback path instead.
 */

import type { WorkerCapability } from '@forge/ntn-wrapper';

/**
 * Structural subset of `NotionClientConfig` from `@forge/notion-client`. We
 * intentionally do not import the type here:
 *
 *  - This module needs only `token`, `baseUrl`, `notionVersion`, and the
 *    optional `fetch` impl. Re-declaring the slice keeps the helper testable
 *    without pulling the full notion-client package into the type graph.
 *
 *  - Production callers pass the real `NotionClientConfig` directly — it
 *    satisfies this shape structurally (excess properties are fine).
 */
export interface NotionClientConfig {
  token: string;
  notionVersion?: string;
  baseUrl?: string;
  fetch?: (input: string | URL, init?: RequestInit) => Promise<Response>;
}

/**
 * Branded workspace id. Re-declared (vs imported) for the same reason
 * {@link NotionClientConfig} is — keeps this helper standalone-testable.
 * The runtime shape is just `string`.
 */
export type WorkspaceId = string & { readonly __brand: 'WorkspaceId' };

/**
 * Hypothetical endpoint path we POST to. Centralised here so a future
 * "endpoint moved" tweak is a one-line change.
 *
 * Currently 404s on every Notion-Version — see the comment block at the top
 * of this file for the documentation citation.
 */
const CUSTOM_AGENT_TOOLS_PATH = '/v1/custom_agents/tools';

/**
 * Hard timeout for the (single) attempt against Notion. Kept short so we
 * always fall back inside the Shipper deadline budget.
 */
const ATTEMPT_TIMEOUT_MS = 5000;

/** Arguments for {@link wireCustomAgent}. */
export interface WireCustomAgentArgs {
  /** Per-call Notion client config. The token is the workspace's API token. */
  notionConfig: NotionClientConfig;
  /** The Worker name we're attaching capabilities from. */
  workerName: string;
  /**
   * Capabilities to wire. Typically the full output of
   * `listCapabilities(workerName)` from `@forge/ntn-wrapper`.
   */
  capabilities: readonly WorkerCapability[];
  /** Branded Notion workspace id used to build the fallback deep-link. */
  workspaceId: WorkspaceId;
  /**
   * Optional injected fetch implementation. The Notion client config also
   * carries one; this parameter exists so call sites that want to swap the
   * fetch *only* for the Custom Agent attempt (e.g. to point at a mock in
   * tests) can do so without rebuilding the entire `NotionClientConfig`.
   * When omitted we use `notionConfig.fetch ?? globalThis.fetch`.
   */
  fetch?: (input: string | URL, init?: RequestInit) => Promise<Response>;
}

/** Return shape from {@link wireCustomAgent}. */
export interface WireCustomAgentResult {
  /**
   * The Custom Agent ID Notion assigned, OR `null` when the endpoint isn't
   * available and we fell back to the deep-link. Null is NOT an error — the
   * Shipper persists the null + surfaces the fallback URL to the user.
   */
  customAgentId: string | null;
  /**
   * When `customAgentId` is null, this is the deep-link the user clicks to
   * finish the wire-up in Notion's Settings → Custom Agents UI. Always
   * populated on fallback; undefined on success.
   */
  fallbackUrl?: string;
  /**
   * Brief diagnostic about which path we took. Forwarded by the Shipper into
   * `logger.info('shipper.custom-agent.attempt', …)` so the dashboard can
   * surface whether the live endpoint started working without a code change.
   */
  via: 'rest' | 'fallback';
}

/**
 * Build the Settings deep-link used as a fallback. Notion's settings URL
 * shape is `https://www.notion.so/<workspace>/settings/custom-agents`; we use
 * the workspace id as the slug. The exact slug format varies across Notion
 * accounts (a workspace can have a custom domain) but the id form is always
 * accepted as a redirect source.
 */
function buildFallbackUrl(workspaceId: string): string {
  return `https://www.notion.so/${encodeURIComponent(workspaceId)}/settings/custom-agents`;
}

/**
 * Race a promise against a timeout. Resolves to `null` on timeout so the
 * caller can treat the timeout the same as a 404 (i.e. fall back).
 */
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      resolve(null);
    }, ms);
  });
  try {
    const result = await Promise.race([p, timeout]);
    return result as T | null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Attempt to wire the worker's capabilities into a Notion Custom Agent.
 *
 * Behavior:
 *
 *  1. POSTs the capability list to {@link CUSTOM_AGENT_TOOLS_PATH} with the
 *     workspace token. If Notion returns 200 + a body with an `id` field, we
 *     consider it wired and return the id.
 *
 *  2. On 404 / 405 / any other non-2xx / timeout / network error, we
 *     gracefully fall back to the Settings deep-link. The user is one click
 *     away from completing the wire-up.
 *
 * Never throws — the Shipper treats Custom Agent wiring as non-fatal because
 * the deploy itself (Step 1 of §IV.4) is the load-bearing artifact. A failed
 * REST wire-up is recoverable; a failed deploy is not.
 *
 * @returns A {@link WireCustomAgentResult} describing the outcome.
 */
export async function wireCustomAgent(args: WireCustomAgentArgs): Promise<WireCustomAgentResult> {
  const fallbackUrl = buildFallbackUrl(String(args.workspaceId));

  // Empty capability list is still a valid request — some workers expose
  // zero capabilities (e.g. an internal helper). Posting an empty body would
  // be a no-op on the Notion side, so short-circuit straight to the fallback
  // to save the round trip.
  if (args.capabilities.length === 0) {
    return { customAgentId: null, fallbackUrl, via: 'fallback' };
  }

  // Use a structural fetch type (not `typeof fetch`) — the DOM lib's `fetch`
  // signature is wider than what we need and assigning the global into our
  // narrower contract would require a cast at every call site. The
  // declaration below is the intersection of all impls we accept.
  const fetchImpl: ((input: string | URL, init?: RequestInit) => Promise<Response>) | undefined =
    args.fetch ??
    args.notionConfig.fetch ??
    (typeof globalThis.fetch === 'function'
      ? (globalThis.fetch.bind(globalThis) as (
          input: string | URL,
          init?: RequestInit,
        ) => Promise<Response>)
      : undefined);

  if (fetchImpl === undefined) {
    // No fetch available at all — fall back rather than throwing because
    // missing fetch is an env issue, not a per-deploy failure.
    return { customAgentId: null, fallbackUrl, via: 'fallback' };
  }

  const baseUrl = args.notionConfig.baseUrl ?? 'https://api.notion.com';
  const url = `${baseUrl.replace(/\/$/, '')}${CUSTOM_AGENT_TOOLS_PATH}`;

  const body = JSON.stringify({
    workerName: args.workerName,
    capabilities: args.capabilities.map((cap) => ({
      kind: cap.kind,
      key: cap.key,
      ...(cap.title === undefined ? {} : { title: cap.title }),
      ...(cap.description === undefined ? {} : { description: cap.description }),
    })),
  });

  try {
    const response = await withTimeout(
      fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${args.notionConfig.token}`,
          'Notion-Version': args.notionConfig.notionVersion ?? '2026-03-11',
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body,
      }),
      ATTEMPT_TIMEOUT_MS,
    );

    if (response === null) {
      // Timed out — fall back.
      return { customAgentId: null, fallbackUrl, via: 'fallback' };
    }

    if (!response.ok) {
      // 404 / 405 / 400 / 5xx all route to the fallback. We log nothing here
      // — the Shipper sees the `via: 'fallback'` flag and logs once at the
      // pipeline boundary.
      // Drain the body to free the socket on runtimes that care.
      try {
        await response.text();
      } catch {
        /* swallow */
      }
      return { customAgentId: null, fallbackUrl, via: 'fallback' };
    }

    let parsed: { id?: unknown } | null = null;
    try {
      parsed = (await response.json()) as { id?: unknown };
    } catch {
      // Not JSON despite a 2xx — treat as a degraded success and fall back.
      return { customAgentId: null, fallbackUrl, via: 'fallback' };
    }

    if (typeof parsed.id === 'string' && parsed.id.length > 0) {
      return { customAgentId: parsed.id, via: 'rest' };
    }
    return { customAgentId: null, fallbackUrl, via: 'fallback' };
  } catch {
    // Network error, DNS failure, fetch implementation throw — all fall back.
    return { customAgentId: null, fallbackUrl, via: 'fallback' };
  }
}
