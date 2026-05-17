/**
 * Pure exports of the property schemas for the two Forge databases.
 *
 * Why pure: the reconciler needs to diff installed-vs-desired without
 * re-doing the install. Keeping these as exported constants (well, a
 * builder for the Requests DB schema because it references the Agents DB
 * id for the relation property) lets the reconciler and installer share
 * exactly one source of truth.
 *
 * The shapes follow https://developers.notion.com/reference/property-schema-object
 * (Notion API version 2026-03-11).
 *
 * Each value is a "property-config" object keyed by the property *name* —
 * i.e. the value of `properties` in {@link CreateDatabaseParams}.
 */

// We re-export-as-const so callers in this package + tests can rely on the
// exact option lists (we do not want a typo silently creating a new option
// when Notion compares them by name).

/** Status of a generation request, surfaced on the Forge Requests DB row. */
export const REQUEST_STATUS_OPTIONS = [
  { name: 'queued', color: 'gray' },
  { name: 'running', color: 'blue' },
  { name: 'succeeded', color: 'green' },
  { name: 'failed', color: 'red' },
  { name: 'cancelled', color: 'default' },
  { name: 'needs_clarification', color: 'yellow' },
] as const;

/** Pattern enum — mirrors `AgentPattern` in `@forge/db`. */
export const PATTERN_OPTIONS = [
  { name: 'database-query', color: 'blue' },
  { name: 'webhook-trigger', color: 'purple' },
  { name: 'sync-source', color: 'orange' },
  { name: 'external-api-call', color: 'green' },
  { name: 'multi-step', color: 'pink' },
] as const;

/** Status of a deployed agent. */
export const AGENT_STATUS_OPTIONS = [
  { name: 'active', color: 'green' },
  { name: 'paused', color: 'yellow' },
  { name: 'retracted', color: 'red' },
] as const;

/**
 * Forge Agents DB schema.
 *
 * Note on `created_time`: Notion auto-creates a `created_time` system
 * property on every database; we still declare it here so the schema is
 * authoritative and the reconciler can verify it was not stripped.
 */
export const forgeAgentsDbSchema: Record<string, Record<string, unknown>> = {
  Name: { title: {} },
  Description: { rich_text: {} },
  Status: {
    select: { options: [...AGENT_STATUS_OPTIONS] },
  },
  Pattern: {
    select: { options: [...PATTERN_OPTIONS] },
  },
  'Deploy URL': { url: {} },
  'Webhook URL': { url: {} },
  Avatar: { files: {} },
  'Last Run': { date: {} },
  'Total Invocations': { number: { format: 'number' } },
  'Source Artifact': { files: {} },
  'Created at': { created_time: {} },
};

/**
 * Builder for the Forge Requests DB schema.
 *
 * The Requests DB has a `relation` property pointing at the Agents DB,
 * which means we need the Agents DB ID before we can author the schema.
 * That's why this is a function (not a constant) — the installer creates
 * the Agents DB first, then calls this with its id.
 *
 * @param agentsDbId Forge Agents DB id, as returned from `createDatabase`.
 */
export function buildForgeRequestsDbSchema(
  agentsDbId: string,
): Record<string, Record<string, unknown>> {
  return {
    Description: { title: {} },
    Status: {
      select: { options: [...REQUEST_STATUS_OPTIONS] },
    },
    Pattern: {
      select: { options: [...PATTERN_OPTIONS] },
    },
    'Deployed Agent': {
      relation: {
        database_id: agentsDbId,
        // `single_property` — back-relation will be added in the link step
        // (see installer.ts step 5). Notion ≥ 2022-06-28 requires this
        // discriminator on every relation property.
        single_property: {},
      },
    },
    'Created by': { people: {} },
    'Created at': { created_time: {} },
    Cost: { number: { format: 'dollar' } },
    // Per PLAN: keep Build Log as plain rich_text in v1 — a separate Logs
    // DB is YAGNI until we need cross-row queries.
    'Build Log': { rich_text: {} },
  };
}

/** Names of properties whose absence triggers a reconciler patch. */
export const FORGE_AGENTS_REQUIRED_PROPERTIES = Object.keys(
  forgeAgentsDbSchema,
);

/** Names of Requests properties the reconciler considers required. */
export const FORGE_REQUESTS_REQUIRED_PROPERTIES = [
  'Description',
  'Status',
  'Pattern',
  'Deployed Agent',
  'Created by',
  'Created at',
  'Cost',
  'Build Log',
];

/** Union over pattern names — mirrors `AgentPattern` in `@forge/db` but
 *  declared locally so the installer stays edge-bundle friendly. */
export type ForgePattern = (typeof PATTERN_OPTIONS)[number]['name'];
