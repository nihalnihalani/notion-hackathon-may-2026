/**
 * Tests for {@link wireCustomAgent}.
 *
 * Strategy:
 *   - Pass a custom `fetch` impl via the `args.fetch` injection seam so we
 *     never hit the network.
 *   - Assert on the request shape (method, url, headers, body) and on the
 *     returned `WireCustomAgentResult` for each scenario.
 *
 * Scenarios:
 *   1. Happy path: REST returns 200 + `{ id: '...' }` → success.
 *   2. 404 / 405: fallback path with deep-link.
 *   3. 5xx: fallback (single attempt; no retry in this layer).
 *   4. Empty capability list short-circuits to fallback without calling fetch.
 *   5. Timeout: fetch never resolves → fallback after the timeout window.
 *      We test a faster path: a fetch that rejects synchronously also yields
 *      fallback (covers the catch-block).
 *   6. Non-JSON 2xx: degraded fallback.
 *   7. 2xx with no `id`: fallback.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  wireCustomAgent,
  type NotionClientConfig,
  type WorkspaceId,
} from '../src/custom-agent-wiring.js';
import type { WorkerCapability } from '@forge/ntn-wrapper';

const NOTION_CONFIG: NotionClientConfig = {
  token: 'secret_abc',
  baseUrl: 'https://api.notion.com',
  notionVersion: '2026-03-11',
};

const SAMPLE_CAPS: WorkerCapability[] = [
  { kind: 'tool', key: 'fetch_bugs', title: 'Fetch bugs' },
  { kind: 'tool', key: 'mark_done' },
];

const SAMPLE_WORKSPACE = 'ws-1234' as WorkspaceId;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('wireCustomAgent — REST happy path', () => {
  it('returns the customAgentId when Notion returns 200 + id', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { id: 'agent_xyz' }));

    const result = await wireCustomAgent({
      notionConfig: NOTION_CONFIG,
      workerName: 'bug-triager',
      capabilities: SAMPLE_CAPS,
      workspaceId: SAMPLE_WORKSPACE,
      fetch: fetchMock,
    });

    expect(result.customAgentId).toBe('agent_xyz');
    expect(result.via).toBe('rest');
    expect(result.fallbackUrl).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends the correct method, url, headers, and body', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { id: 'agent_1' }));

    await wireCustomAgent({
      notionConfig: NOTION_CONFIG,
      workerName: 'bug-triager',
      capabilities: SAMPLE_CAPS,
      workspaceId: SAMPLE_WORKSPACE,
      fetch: fetchMock,
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.notion.com/v1/custom_agents/tools');
    expect(init?.method).toBe('POST');
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer secret_abc');
    expect(headers['Notion-Version']).toBe('2026-03-11');
    expect(headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(init?.body as string);
    expect(body.workerName).toBe('bug-triager');
    expect(body.capabilities).toHaveLength(2);
    expect(body.capabilities[0]).toEqual({
      kind: 'tool',
      key: 'fetch_bugs',
      title: 'Fetch bugs',
    });
    // No `description` was set on the second cap, so it shouldn't appear.
    expect(body.capabilities[1]).toEqual({ kind: 'tool', key: 'mark_done' });
  });

  it('honors a non-default baseUrl', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { id: 'a' }));
    await wireCustomAgent({
      notionConfig: { ...NOTION_CONFIG, baseUrl: 'https://api-staging.notion.com/' },
      workerName: 'w',
      capabilities: SAMPLE_CAPS,
      workspaceId: SAMPLE_WORKSPACE,
      fetch: fetchMock,
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://api-staging.notion.com/v1/custom_agents/tools',
    );
  });
});

describe('wireCustomAgent — fallback paths', () => {
  it('falls back on 404 with the workspace deep-link', async () => {
    const fetchMock = vi.fn(async () => new Response('not found', { status: 404 }));
    const result = await wireCustomAgent({
      notionConfig: NOTION_CONFIG,
      workerName: 'w',
      capabilities: SAMPLE_CAPS,
      workspaceId: SAMPLE_WORKSPACE,
      fetch: fetchMock,
    });
    expect(result.customAgentId).toBeNull();
    expect(result.via).toBe('fallback');
    expect(result.fallbackUrl).toBe('https://www.notion.so/ws-1234/settings/custom-agents');
  });

  it('falls back on 405', async () => {
    const fetchMock = vi.fn(async () => new Response('no', { status: 405 }));
    const result = await wireCustomAgent({
      notionConfig: NOTION_CONFIG,
      workerName: 'w',
      capabilities: SAMPLE_CAPS,
      workspaceId: SAMPLE_WORKSPACE,
      fetch: fetchMock,
    });
    expect(result.customAgentId).toBeNull();
    expect(result.via).toBe('fallback');
  });

  it('falls back on 5xx without retrying', async () => {
    const fetchMock = vi.fn(async () => new Response('oops', { status: 503 }));
    const result = await wireCustomAgent({
      notionConfig: NOTION_CONFIG,
      workerName: 'w',
      capabilities: SAMPLE_CAPS,
      workspaceId: SAMPLE_WORKSPACE,
      fetch: fetchMock,
    });
    expect(result.customAgentId).toBeNull();
    expect(result.via).toBe('fallback');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls back when fetch throws', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('ENETUNREACH');
    });
    const result = await wireCustomAgent({
      notionConfig: NOTION_CONFIG,
      workerName: 'w',
      capabilities: SAMPLE_CAPS,
      workspaceId: SAMPLE_WORKSPACE,
      fetch: fetchMock,
    });
    expect(result.customAgentId).toBeNull();
    expect(result.via).toBe('fallback');
  });

  it('short-circuits to fallback without calling fetch when capabilities is empty', async () => {
    const fetchMock = vi.fn();
    const result = await wireCustomAgent({
      notionConfig: NOTION_CONFIG,
      workerName: 'w',
      capabilities: [],
      workspaceId: SAMPLE_WORKSPACE,
      fetch: fetchMock as never,
    });
    expect(result.customAgentId).toBeNull();
    expect(result.via).toBe('fallback');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('falls back when 2xx body is not JSON', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response('definitely not json', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const result = await wireCustomAgent({
      notionConfig: NOTION_CONFIG,
      workerName: 'w',
      capabilities: SAMPLE_CAPS,
      workspaceId: SAMPLE_WORKSPACE,
      fetch: fetchMock,
    });
    expect(result.customAgentId).toBeNull();
    expect(result.via).toBe('fallback');
  });

  it('falls back when 2xx body lacks an `id` field', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { foo: 'bar' }));
    const result = await wireCustomAgent({
      notionConfig: NOTION_CONFIG,
      workerName: 'w',
      capabilities: SAMPLE_CAPS,
      workspaceId: SAMPLE_WORKSPACE,
      fetch: fetchMock,
    });
    expect(result.customAgentId).toBeNull();
    expect(result.via).toBe('fallback');
  });

  it('falls back when no fetch impl is available at all', async () => {
    // Shadow globalThis.fetch for the duration of this test so we can hit
    // the "fetchImpl === undefined" branch deterministically.
    const realFetch = globalThis.fetch;
    // @ts-expect-error — deliberate shadow of the global for this test
    delete (globalThis as { fetch?: unknown }).fetch;
    try {
      const result = await wireCustomAgent({
        notionConfig: { token: 't' },
        workerName: 'w',
        capabilities: SAMPLE_CAPS,
        workspaceId: SAMPLE_WORKSPACE,
      });
      expect(result.customAgentId).toBeNull();
      expect(result.via).toBe('fallback');
      expect(result.fallbackUrl).toContain('/settings/custom-agents');
    } finally {
      // Restore so other tests + other suites don't see a missing global.
      globalThis.fetch = realFetch;
    }
  });
});
