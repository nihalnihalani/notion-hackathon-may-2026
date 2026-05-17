/**
 * Forge Operations self-monitoring metrics (PLAN.md §X).
 *
 * The "Forge Operations" Notion DB lives inside our own workspace and ingests
 * one row per Forge generation — including failures and cancellations — so we
 * can dogfood the platform. The DB itself is a regular Notion database created
 * by hand (or by a Forge-generated agent), with the following expected schema:
 *
 *   - **Title** (title)          → generation id
 *   - **Status** (select)        → succeeded | failed | cancelled |
 *                                  needs_clarification | cached
 *   - **Pattern** (select)       → database_query | webhook_trigger |
 *                                  sync_source | external_api_call | multi_step
 *   - **Workspace** (rich_text)  → PlanetScale workspace id (cuid)
 *   - **Latency ms** (number)
 *   - **Cost USD** (number)
 *   - **Description** (rich_text)→ truncated to 200 chars
 *   - **Error** (rich_text)      → present on failed runs only
 *   - **Created at** (created_time)  ← Notion auto-fill
 *
 * Property names are case-sensitive and configurable per workspace via
 * {@link OpsMetricsPropertyNames}. The publisher trusts the caller to ensure
 * the DB schema matches before wiring this in.
 *
 * Design notes:
 *  - Best-effort: every publish is wrapped in a try/catch by the workflow.
 *    A Notion outage here MUST NOT fail a Forge generation.
 *  - No fan-out: a single Notion API call per event. We rely on Notion's
 *    rate-limit pacer (`createPacer`) at the {@link NotionClientConfig} layer
 *    if many generations finish at once.
 *  - Structural-only deps: this module knows nothing about Prisma, AI provider
 *    credentials, etc. — the workflow assembles the event from its own state.
 */

import {
  asDatabaseId,
  createPage,
  type DatabaseId,
  type NotionClientConfig,
  type NotionPagePropertyInput,
  type NotionParent,
} from '@forge/notion-client';

import type { AgentPattern } from '@forge/agents';

// ─────────────────────────────────────────────────────────────────────────────
// Event payload — what the workflow hands the adapter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Terminal status reported to the ops DB. Matches the workflow's
 * `WorkflowSuccess.status` plus the failure / cancellation outcomes the
 * workflow's `handleFailure` path also surfaces.
 */
export type OpsGenerationStatus =
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'needs_clarification'
  | 'cached';

export interface OpsGenerationEvent {
  generationId: string;
  workspaceId: string;
  status: OpsGenerationStatus;
  pattern: AgentPattern | null;
  description: string;
  totalLatencyMs: number;
  totalCostUsd: number;
  /** Present on non-success outcomes. Truncated for the rich_text cap. */
  errorMessage?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Adapter interface — used by `WorkflowConfig.opsMetrics`
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The single method the workflow calls. Implementations are responsible for
 * their own error handling — the workflow only wraps in a swallowing
 * try/catch so a slow or 5xx publish never blocks the user's run.
 */
export interface OpsMetricsAdapter {
  publishGenerationEvent(event: OpsGenerationEvent): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Property names — overridable per workspace
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The Notion DB column names this adapter writes into. Override any field
 * to match a different schema. Unknown fields in the target DB are silently
 * ignored by Notion's REST API; missing required fields are rejected with a
 * `validation_error`, so check {@link assertOpsMetricsSchema}-style logs after
 * the first deploy.
 */
export interface OpsMetricsPropertyNames {
  readonly title: string;
  readonly status: string;
  readonly pattern: string;
  readonly workspace: string;
  readonly latencyMs: string;
  readonly costUsd: string;
  readonly description: string;
  readonly error: string;
}

export const DEFAULT_OPS_METRICS_PROPERTY_NAMES: OpsMetricsPropertyNames = {
  title: 'Generation',
  status: 'Status',
  pattern: 'Pattern',
  workspace: 'Workspace',
  latencyMs: 'Latency ms',
  costUsd: 'Cost USD',
  description: 'Description',
  error: 'Error',
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Notion adapter — the production implementation
// ─────────────────────────────────────────────────────────────────────────────

export interface NotionOpsMetricsAdapterOptions {
  /** Authenticated Notion client config (same shape used by the installer). */
  notionConfig: NotionClientConfig;
  /** Database id (UUID with or without dashes — `asDatabaseId` normalizes). */
  databaseId: DatabaseId | string;
  /** Optional property-name overrides. */
  propertyNames?: Partial<OpsMetricsPropertyNames>;
  /**
   * Optional clock injection (test seam). Used to populate timestamp-derived
   * fields if Notion's `created_time` is not the right signal for a caller.
   */
  now?: () => Date;
}

/**
 * Build the production Notion adapter. The returned adapter is fully synchronous
 * to instantiate (no Notion calls happen until `publishGenerationEvent` is
 * called) so it's safe to construct at module init time.
 */
export function createNotionOpsMetricsAdapter(
  opts: NotionOpsMetricsAdapterOptions,
): OpsMetricsAdapter {
  const databaseId = asDatabaseId(opts.databaseId as string);
  const propertyNames: OpsMetricsPropertyNames = {
    ...DEFAULT_OPS_METRICS_PROPERTY_NAMES,
    ...opts.propertyNames,
  };

  return {
    async publishGenerationEvent(event: OpsGenerationEvent) {
      const parent: NotionParent = { type: 'database_id', database_id: databaseId };
      const properties = buildOpsRowProperties(event, propertyNames);
      await createPage(opts.notionConfig, { parent, properties });
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Env-driven factory — the canonical way to wire the adapter in production
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the ops adapter from environment variables. Returns `undefined` if the
 * required env vars are not set so callers can simply pass the result through
 * `opsMetrics:` on {@link WorkflowConfig} — an unset env yields a no-op.
 *
 * Required env:
 *   - `FORGE_OPS_NOTION_DB_ID`     — target database id (with or without dashes)
 *   - `FORGE_OPS_NOTION_TOKEN`     — internal Notion integration token
 *
 * Optional env:
 *   - `FORGE_OPS_PROPERTY_*`       — override column names (see below)
 *   - `FORGE_OPS_NOTION_VERSION`   — pin the Notion API version
 *
 * The env reader is structural (`{ get(key): string | undefined }`) so callers
 * can hand in a sentinel for tests.
 */
export interface OpsMetricsEnvReader {
  get(key: string): string | undefined;
}

export function createOpsMetricsAdapterFromEnv(
  env: OpsMetricsEnvReader = defaultEnvReader,
): OpsMetricsAdapter | undefined {
  const databaseId = env.get('FORGE_OPS_NOTION_DB_ID');
  const token = env.get('FORGE_OPS_NOTION_TOKEN');
  if (databaseId === undefined || token === undefined) return undefined;
  if (databaseId.length === 0 || token.length === 0) return undefined;

  const notionVersion = env.get('FORGE_OPS_NOTION_VERSION');

  const overrideEntries: [keyof OpsMetricsPropertyNames, string][] = [];
  const titleOverride = env.get('FORGE_OPS_PROPERTY_TITLE');
  if (titleOverride !== undefined) overrideEntries.push(['title', titleOverride]);
  const statusOverride = env.get('FORGE_OPS_PROPERTY_STATUS');
  if (statusOverride !== undefined) overrideEntries.push(['status', statusOverride]);
  const patternOverride = env.get('FORGE_OPS_PROPERTY_PATTERN');
  if (patternOverride !== undefined) overrideEntries.push(['pattern', patternOverride]);
  const workspaceOverride = env.get('FORGE_OPS_PROPERTY_WORKSPACE');
  if (workspaceOverride !== undefined)
    overrideEntries.push(['workspace', workspaceOverride]);
  const latencyOverride = env.get('FORGE_OPS_PROPERTY_LATENCY_MS');
  if (latencyOverride !== undefined) overrideEntries.push(['latencyMs', latencyOverride]);
  const costOverride = env.get('FORGE_OPS_PROPERTY_COST_USD');
  if (costOverride !== undefined) overrideEntries.push(['costUsd', costOverride]);
  const descriptionOverride = env.get('FORGE_OPS_PROPERTY_DESCRIPTION');
  if (descriptionOverride !== undefined)
    overrideEntries.push(['description', descriptionOverride]);
  const errorOverride = env.get('FORGE_OPS_PROPERTY_ERROR');
  if (errorOverride !== undefined) overrideEntries.push(['error', errorOverride]);
  const overrides: Partial<OpsMetricsPropertyNames> = Object.fromEntries(
    overrideEntries,
  ) as Partial<OpsMetricsPropertyNames>;

  return createNotionOpsMetricsAdapter({
    notionConfig: {
      token,
      ...(notionVersion !== undefined && { notionVersion }),
    },
    databaseId,
    ...(Object.keys(overrides).length > 0 && { propertyNames: overrides }),
  });
}

const defaultEnvReader: OpsMetricsEnvReader = {
  get(key) {
    return process.env[key];
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Row builder — exported so tests can assert the wire shape without standing
// up an HTTP server.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert a {@link OpsGenerationEvent} into the property bag Notion expects
 * for `POST /v1/pages` against the Forge Operations DB. Pure — no IO, no
 * module state.
 *
 * Long strings (description, error) are truncated to {@link MAX_RICH_TEXT_LEN}
 * to stay under Notion's 2000-char rich_text limit; we use 1900 to leave room
 * for an ellipsis + future surrounding metadata.
 */
export function buildOpsRowProperties(
  event: OpsGenerationEvent,
  names: OpsMetricsPropertyNames = DEFAULT_OPS_METRICS_PROPERTY_NAMES,
): NotionPagePropertyInput {
  const properties: NotionPagePropertyInput = {
    [names.title]: {
      title: [{ type: 'text', text: { content: event.generationId } }],
    },
    [names.status]: {
      select: { name: event.status },
    },
    [names.workspace]: richText(event.workspaceId),
    [names.latencyMs]: { number: Math.max(0, Math.round(event.totalLatencyMs)) },
    [names.costUsd]: { number: Math.max(0, roundUsd(event.totalCostUsd)) },
    [names.description]: richText(truncate(event.description, MAX_RICH_TEXT_LEN)),
  };

  if (event.pattern !== null) {
    properties[names.pattern] = { select: { name: event.pattern } };
  }

  if (event.errorMessage !== undefined && event.errorMessage.length > 0) {
    properties[names.error] = richText(
      truncate(event.errorMessage, MAX_RICH_TEXT_LEN),
    );
  }

  return properties;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

const MAX_RICH_TEXT_LEN = 1900;

function richText(value: string): NotionPagePropertyInput[string] {
  return {
    rich_text: [{ type: 'text', text: { content: value } }],
  };
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

/**
 * Round to 6 decimal places — matches `Generation.totalCostUsd`'s Decimal(10,6)
 * column. Avoids 1e-15 float noise polluting the Notion DB.
 */
function roundUsd(usd: number): number {
  return Math.round(usd * 1_000_000) / 1_000_000;
}
