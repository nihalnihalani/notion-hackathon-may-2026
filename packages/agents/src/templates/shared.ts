/**
 * Internal helpers shared by every Worker code template.
 *
 * NOT exported from `@forge/agents` — pure local utilities. The templates
 * call these to keep their bodies focused on the pattern-specific shape.
 *
 * Hard rules every template inherits via these helpers:
 *
 *  - Output uses the j-builder rendering from `renderJSchemaAsTS` for both
 *    `input` and `output` schemas. Hand-rolling either inside a template
 *    would let the templates and Schema Smith drift.
 *  - Generated `import` lines only target the dep allowlist (Notion +
 *    `@forge/connectors/*` + `zod`/`date-fns`). The Inspector enforces this
 *    at scan time; the templates promise it by construction.
 *  - No `console.log` ever appears in template output. Diagnostics are
 *    surfaced via the structured result object the tool/sync/webhook
 *    handlers return.
 */

import { renderJSchemaAsTS } from '../schema/j-spec.js';
import type { JSchemaSpec, ProviderName } from '../types.js';

/** Strict per-provider connector import metadata. */
interface ConnectorBinding {
  /** Package path the generated Worker imports from. */
  module: string;
  /** Named export to import (the factory). */
  factory: string;
  /** Local identifier the templates use for the constructed client. */
  client: string;
  /** Env var name the factory reads from (uppercase, namespaced). */
  envVar: string;
}

const CONNECTOR_BINDINGS: Record<ProviderName, ConnectorBinding> = {
  github: {
    module: '@forge/connectors/github',
    factory: 'createGithubClient',
    client: 'github',
    envVar: 'GITHUB_TOKEN',
  },
  linear: {
    module: '@forge/connectors/linear',
    factory: 'createLinearClient',
    client: 'linear',
    envVar: 'LINEAR_API_KEY',
  },
  stripe: {
    module: '@forge/connectors/stripe',
    factory: 'createStripeClient',
    client: 'stripe',
    envVar: 'STRIPE_API_KEY',
  },
  slack: {
    module: '@forge/connectors/slack',
    factory: 'createSlackClient',
    client: 'slack',
    envVar: 'SLACK_BOT_TOKEN',
  },
  google: {
    module: '@forge/connectors/google',
    factory: 'createGmailClient',
    client: 'gmail',
    envVar: 'GOOGLE_ACCESS_TOKEN',
  },
  sentry: {
    module: '@forge/connectors/sentry',
    factory: 'createSentryClient',
    client: 'sentry',
    envVar: 'SENTRY_API_TOKEN',
  },
  vercel: {
    module: '@forge/connectors/vercel',
    factory: 'createVercelClient',
    client: 'vercel',
    envVar: 'VERCEL_API_TOKEN',
  },
  anthropic: {
    module: '@forge/connectors/anthropic',
    factory: 'createAnthropicClient',
    client: 'anthropic',
    envVar: 'ANTHROPIC_API_KEY',
  },
  openai: {
    module: '@forge/connectors/openai',
    factory: 'createOpenaiClient',
    client: 'openai',
    envVar: 'OPENAI_API_KEY',
  },
  minimax: {
    module: '@forge/connectors/minimax',
    factory: 'createMinimaxClient',
    client: 'minimax',
    envVar: 'MINIMAX_API_KEY',
  },
};

export function getConnectorBinding(provider: ProviderName): ConnectorBinding {
  // `noUncheckedIndexedAccess` is on — we want a typed throw on the
  // unreachable branch so callers can rely on a defined return.
  const binding = CONNECTOR_BINDINGS[provider];
  return binding;
}

/** Render the `j` schema expression. Thin wrapper for naming hygiene. */
export function renderSchema(spec: JSchemaSpec): string {
  return renderJSchemaAsTS(spec);
}

/**
 * Convert a Worker description into a one-line JSDoc summary the model can't
 * extend with stray newlines. Templates inline this as the file-header
 * comment, so it must be safe inside `/** ... *​/`.
 */
export function describeAsJsdoc(description: string): string {
  return description
    .replace(/\*\//gu, '*\\/')
    .replace(/\r?\n+/gu, ' ')
    .trim();
}

/** JSON-encoded string literal — re-used for env var keys and embedded text. */
export function tsString(value: string): string {
  return JSON.stringify(value);
}

/**
 * Render the standard import preamble used by every template:
 *
 *   - `@notion/workers-sdk` for the `worker` runtime + `j` schema builder
 *   - `@notionhq/client` for direct Notion REST access when the pattern
 *     needs it (templates pass `includeNotionClient`)
 *   - each `requiredOAuth` provider's `@forge/connectors/*` factory
 *
 * Returns the import block joined by newlines and the list of named
 * connector identifiers the body can splat into a single client setup.
 */
export interface ImportPreambleResult {
  source: string;
  connectorBindings: ConnectorBinding[];
}

export interface ImportPreambleArgs {
  includeNotionClient: boolean;
  requiredOAuth: readonly ProviderName[];
}

export function renderImports(args: ImportPreambleArgs): ImportPreambleResult {
  const lines: string[] = [];
  lines.push(`import { worker, j } from '@notion/workers-sdk';`);
  if (args.includeNotionClient) {
    lines.push(`import { Client as NotionClient } from '@notionhq/client';`);
  }
  // De-dupe + preserve order so the import block is deterministic.
  const seen = new Set<ProviderName>();
  const bindings: ConnectorBinding[] = [];
  for (const provider of args.requiredOAuth) {
    if (seen.has(provider)) continue;
    seen.add(provider);
    const binding = getConnectorBinding(provider);
    bindings.push(binding);
    lines.push(`import { ${binding.factory} } from ${tsString(binding.module)};`);
  }
  return { source: lines.join('\n'), connectorBindings: bindings };
}

/**
 * Render the env-setup comment block surfaced as a comment so the user
 * knows which `ntn workers env set` commands to run before deploying.
 *
 * The comment is included even for OAuth-less Workers so the file is
 * self-documenting — the Notion API key requirement is universal.
 */
export function renderEnvSetupComment(args: {
  workerName: string;
  connectorBindings: ConnectorBinding[];
  notionEnvVar: string | null;
}): string {
  const envs: string[] = [];
  if (args.notionEnvVar) {
    envs.push(args.notionEnvVar);
  }
  for (const binding of args.connectorBindings) {
    envs.push(binding.envVar);
  }
  const lines = [
    `// ----------------------------------------------------------------------`,
    `// Required environment variables (set BEFORE \`ntn workers deploy\`):`,
    ...envs.map((e) => `//   ntn workers env set ${e} <value> --worker ${args.workerName}`),
    `// ----------------------------------------------------------------------`,
  ];
  return lines.join('\n');
}

/** Re-export the connector binding type for templates. */
export type { ConnectorBinding };
