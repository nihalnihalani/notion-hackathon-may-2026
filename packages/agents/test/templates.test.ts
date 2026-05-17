/**
 * Worker code template unit tests.
 *
 * For each pattern:
 *   - the template returns non-empty source,
 *   - the source parses with @typescript-eslint/parser,
 *   - the source passes @forge/safety/scan against the default Notion
 *     network allowlist + an EXTENDED dep allowlist that includes the
 *     workspace-internal `@forge/connectors` aggregate.
 *
 * Also covers the few-shot catalog: every `expectedSource` MUST pass the
 * same checks. The Tool Coder ships them verbatim into the model's prompt
 * cache, so a broken example would teach broken code on every call.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DEP_ALLOWLIST,
  DEFAULT_NETWORK_ALLOWLIST,
  scan,
} from '@forge/safety';
import { databaseQueryTemplate } from '../src/templates/database-query.js';
import { webhookTriggerTemplate } from '../src/templates/webhook-trigger.js';
import { syncSourceTemplate } from '../src/templates/sync-source.js';
import { externalApiCallTemplate } from '../src/templates/external-api-call.js';
import { multiStepTemplate } from '../src/templates/multi-step.js';
import { parseGeneratedTs } from '../src/ts-validation.js';
import { FEW_SHOT_EXAMPLES } from '../src/few-shot/index.js';
import type { JSchemaSpec } from '../src/types.js';

const NETWORK_ALLOWLIST = [...DEFAULT_NETWORK_ALLOWLIST];
const DEP_ALLOWLIST = [
  ...DEFAULT_DEP_ALLOWLIST,
  // Tool Coder + few-shot expected sources can import the workspace
  // connectors aggregate. The Inspector wires this same allowlist in
  // production via the per-generation OAuth provider list.
  '@forge/connectors',
];

const INPUT_SCHEMA: JSchemaSpec = {
  kind: 'object',
  describe: 'Input',
  properties: { q: { kind: 'string', describe: 'query' } },
  required: ['q'],
};
const OUTPUT_SCHEMA: JSchemaSpec = {
  kind: 'object',
  describe: 'Output',
  properties: { ok: { kind: 'boolean', describe: 'ok' } },
  required: ['ok'],
};

const SHARED = {
  workerName: 'forge-test-worker-abc123',
  description: 'A sample worker',
  inputSchema: INPUT_SCHEMA,
  outputSchema: OUTPUT_SCHEMA,
};

function expectSafe(source: string): void {
  expect(source.length).toBeGreaterThan(0);
  const parse = parseGeneratedTs(source);
  expect(parse.ok, parse.ok ? '' : parse.errors.join('; ')).toBe(true);
  const scanResult = scan(source, {
    networkAllowlist: NETWORK_ALLOWLIST,
    depAllowlist: DEP_ALLOWLIST,
  });
  const blocking = scanResult.violations.filter((v) => v.severity === 'block');
  expect(
    blocking,
    blocking.length === 0
      ? ''
      : `blocking violations:\n${blocking.map((v) => `${v.rule}@${v.line}: ${v.message}`).join('\n')}`,
  ).toEqual([]);
  expect(scanResult.pass).toBe(true);
  expect(source).not.toMatch(/console\.log/u);
}

describe('databaseQueryTemplate', () => {
  it('returns parseable + safety-clean source (no connector)', () => {
    const source = databaseQueryTemplate({ ...SHARED, requiredOAuth: [] });
    expectSafe(source);
    expect(source).toContain('worker.tool({');
    expect(source).toContain('@notion/workers-sdk');
  });

  it('returns parseable + safety-clean source (with linear connector)', () => {
    const source = databaseQueryTemplate({
      ...SHARED,
      requiredOAuth: ['linear'],
      connectorImport: 'linear',
    });
    expectSafe(source);
    expect(source).toContain('@forge/connectors/linear');
    expect(source).toContain('createLinearClient');
  });
});

describe('webhookTriggerTemplate', () => {
  it('returns parseable + safety-clean source (github)', () => {
    const source = webhookTriggerTemplate({
      ...SHARED,
      requiredOAuth: ['github'],
      connectorImport: 'github',
    });
    expectSafe(source);
    expect(source).toContain('worker.webhook({');
    expect(source).toContain('@forge/connectors/github');
  });

  it('returns parseable + safety-clean source (stripe)', () => {
    const source = webhookTriggerTemplate({
      ...SHARED,
      requiredOAuth: ['stripe'],
      connectorImport: 'stripe',
    });
    expectSafe(source);
    expect(source).toContain('@forge/connectors/stripe');
  });
});

describe('syncSourceTemplate', () => {
  it('returns parseable + safety-clean source (vercel)', () => {
    const source = syncSourceTemplate({
      ...SHARED,
      requiredOAuth: ['vercel'],
      connectorImport: 'vercel',
    });
    expectSafe(source);
    expect(source).toContain('worker.sync({');
    expect(source).toContain('@forge/connectors/vercel');
  });

  it('returns parseable + safety-clean source (sentry)', () => {
    const source = syncSourceTemplate({
      ...SHARED,
      requiredOAuth: ['sentry'],
      connectorImport: 'sentry',
    });
    expectSafe(source);
    expect(source).toContain('@forge/connectors/sentry');
  });
});

describe('externalApiCallTemplate', () => {
  it('returns parseable + safety-clean source (github)', () => {
    const source = externalApiCallTemplate({
      ...SHARED,
      requiredOAuth: ['github'],
      connectorImport: 'github',
    });
    expectSafe(source);
    expect(source).toContain('worker.tool({');
    expect(source).toContain('@forge/connectors/github');
    // External-API-call template doesn't use the Notion client.
    expect(source).not.toContain('@notionhq/client');
  });
});

describe('multiStepTemplate', () => {
  it('returns parseable + safety-clean source (github + slack)', () => {
    const source = multiStepTemplate({
      ...SHARED,
      requiredOAuth: ['github', 'slack'],
    });
    expectSafe(source);
    expect(source).toContain('worker.tool({');
    expect(source).toContain('@forge/connectors/github');
    expect(source).toContain('@forge/connectors/slack');
  });
});

describe('FEW_SHOT_EXAMPLES', () => {
  it('has at least one example per pattern', () => {
    const counts = new Map<string, number>();
    for (const ex of FEW_SHOT_EXAMPLES) {
      const p = String(ex.schema.pattern);
      counts.set(p, (counts.get(p) ?? 0) + 1);
    }
    for (const pattern of [
      'database-query',
      'webhook-trigger',
      'sync-source',
      'external-api-call',
      'multi-step',
    ] as const) {
      expect(counts.get(pattern), `missing example for ${pattern}`).toBeGreaterThanOrEqual(1);
    }
    expect(FEW_SHOT_EXAMPLES).toHaveLength(8);
  });

  it.each(FEW_SHOT_EXAMPLES.map((ex, i) => [i, ex.description, ex]))(
    'example %i (%s) — parses + scans clean',
    (_i, _desc, ex) => {
      expectSafe(ex.expectedSource);
    },
  );
});
