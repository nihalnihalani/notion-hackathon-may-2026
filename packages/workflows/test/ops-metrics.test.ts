/**
 * Tests for the Forge Operations self-monitoring adapter (PLAN.md §X).
 *
 * Two layers covered:
 *   1. `buildOpsRowProperties` — pure shape-builder. Asserted strictly: an
 *      accidental rename of a Notion column would silently start producing
 *      rows that Notion `validation_error`s on, so we lock the wire format.
 *   2. `createNotionOpsMetricsAdapter` — verifies the adapter calls the
 *      injected `notionConfig`'s `fetch` once per event with the expected
 *      pages URL + body shape.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_OPS_METRICS_PROPERTY_NAMES,
  buildOpsRowProperties,
  createNotionOpsMetricsAdapter,
  createOpsMetricsAdapterFromEnv,
  type OpsGenerationEvent,
  type OpsMetricsEnvReader,
} from '../src/ops-metrics.js';

const DB_ID = '11111111-2222-3333-4444-555555555555';

function baseEvent(overrides: Partial<OpsGenerationEvent> = {}): OpsGenerationEvent {
  return {
    generationId: 'gen_test_1',
    workspaceId: 'ws_test_1',
    status: 'succeeded',
    pattern: 'database_query',
    description: 'Pull my open Linear bugs hourly into Notion.',
    totalLatencyMs: 12345,
    totalCostUsd: 0.012345,
    ...overrides,
  };
}

describe('buildOpsRowProperties', () => {
  it('emits the documented property shape on a succeeded run', () => {
    const props = buildOpsRowProperties(baseEvent());
    expect(props).toEqual({
      Generation: {
        title: [{ type: 'text', text: { content: 'gen_test_1' } }],
      },
      Status: { select: { name: 'succeeded' } },
      Pattern: { select: { name: 'database_query' } },
      Workspace: {
        rich_text: [{ type: 'text', text: { content: 'ws_test_1' } }],
      },
      'Latency ms': { number: 12345 },
      'Cost USD': { number: 0.012345 },
      Description: {
        rich_text: [
          {
            type: 'text',
            text: { content: 'Pull my open Linear bugs hourly into Notion.' },
          },
        ],
      },
    });
  });

  it('omits the Pattern column when pattern is null (clarification halts)', () => {
    const props = buildOpsRowProperties(
      baseEvent({ status: 'needs_clarification', pattern: null }),
    );
    expect(props).not.toHaveProperty('Pattern');
    expect(props['Status']).toEqual({ select: { name: 'needs_clarification' } });
  });

  it('includes the Error column on failure', () => {
    const props = buildOpsRowProperties(
      baseEvent({ status: 'failed', errorMessage: 'tsc exited with 1' }),
    );
    expect(props['Error']).toEqual({
      rich_text: [{ type: 'text', text: { content: 'tsc exited with 1' } }],
    });
  });

  it('truncates long descriptions to stay under the rich_text cap', () => {
    const long = 'x'.repeat(5000);
    const props = buildOpsRowProperties(baseEvent({ description: long }));
    const rt = props['Description'] as {
      rich_text: { text: { content: string } }[];
    };
    const content = rt.rich_text[0]!.text.content;
    expect(content.length).toBeLessThanOrEqual(1900);
    expect(content.endsWith('…')).toBe(true);
  });

  it('rounds negative latency / cost to 0 (defense-in-depth)', () => {
    const props = buildOpsRowProperties(
      baseEvent({ totalLatencyMs: -10, totalCostUsd: -0.5 }),
    );
    expect(props['Latency ms']).toEqual({ number: 0 });
    expect(props['Cost USD']).toEqual({ number: 0 });
  });

  it('honors custom property name overrides', () => {
    const props = buildOpsRowProperties(baseEvent(), {
      ...DEFAULT_OPS_METRICS_PROPERTY_NAMES,
      title: 'Run ID',
      status: 'State',
    });
    expect(props).toHaveProperty('Run ID');
    expect(props).toHaveProperty('State');
    expect(props).not.toHaveProperty('Generation');
    expect(props).not.toHaveProperty('Status');
  });
});

describe('createNotionOpsMetricsAdapter', () => {
  it('POSTs to /v1/pages with the ops-row body on publish', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ object: 'page', id: 'page_1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const adapter = createNotionOpsMetricsAdapter({
      notionConfig: { token: 'test-token', fetch: fetchMock },
      databaseId: DB_ID,
    });

    await adapter.publishGenerationEvent(baseEvent());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/v1/pages');
    expect(init.method).toBe('POST');
    const body = JSON.parse(String(init.body)) as {
      parent: { type: string; database_id: string };
      properties: Record<string, unknown>;
    };
    expect(body.parent).toEqual({ type: 'database_id', database_id: DB_ID });
    expect(body.properties['Status']).toEqual({ select: { name: 'succeeded' } });
  });

  it('returns undefined from env factory when required vars are missing', () => {
    const env: OpsMetricsEnvReader = { get: () => undefined };
    expect(createOpsMetricsAdapterFromEnv(env)).toBeUndefined();
  });

  it('builds an adapter from env when both required vars are present', () => {
    const values: Record<string, string> = {
      FORGE_OPS_NOTION_DB_ID: DB_ID,
      FORGE_OPS_NOTION_TOKEN: 'secret_test_token',
    };
    const env: OpsMetricsEnvReader = { get: (key) => values[key] };
    const adapter = createOpsMetricsAdapterFromEnv(env);
    expect(adapter).toBeDefined();
    // Smoke: the returned adapter exposes the publish method.
    expect(typeof adapter?.publishGenerationEvent).toBe('function');
  });

  it('returns undefined when env vars are empty strings (treats as unset)', () => {
    const values: Record<string, string> = {
      FORGE_OPS_NOTION_DB_ID: '',
      FORGE_OPS_NOTION_TOKEN: 'secret',
    };
    const env: OpsMetricsEnvReader = { get: (key) => values[key] };
    expect(createOpsMetricsAdapterFromEnv(env)).toBeUndefined();
  });

  it('propagates errors so the workflow can log + swallow', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          object: 'error',
          status: 401,
          code: 'unauthorized',
          message: 'invalid token',
        }),
        {
          status: 401,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );
    const adapter = createNotionOpsMetricsAdapter({
      notionConfig: { token: 'bad-token', fetch: fetchMock },
      databaseId: DB_ID,
    });

    await expect(adapter.publishGenerationEvent(baseEvent())).rejects.toBeDefined();
  });
});
