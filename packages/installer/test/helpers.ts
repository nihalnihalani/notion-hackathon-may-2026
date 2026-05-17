/**
 * Test helpers for `@forge/installer`.
 *
 * We intentionally do NOT pull `mockFetch` from `@forge/notion-client/test`
 * because that's a private path; we re-implement a tiny mock fetch here
 * that's shaped identically. Lets these tests run hermetically without
 * a test-time dep on the notion-client test surface.
 */

import type { FetchLike } from '@forge/notion-client';

import type {
  InstallerDbClient,
  WorkspaceForgeRecord,
} from '../src/types.js';

export interface RecordedCall {
  url: string;
  method: string;
  body: string | null;
}

export interface MockResponse {
  status?: number;
  body?: unknown;
}

/**
 * Per-route mock fetch. Each handler is keyed by `${METHOD} ${urlMatch}`
 * where `urlMatch` is a regex string matched against the Notion REST
 * path. Returns the next response for that route in order; reuses the
 * last response after exhaustion.
 */
export function mockNotion(routes: {
  [routeKey: string]: MockResponse | MockResponse[];
}): { fetch: FetchLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const queues: Record<string, MockResponse[]> = {};
  for (const [k, v] of Object.entries(routes)) {
    queues[k] = Array.isArray(v) ? [...v] : [v];
  }

  const fetchImpl: FetchLike = async (url, init) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const body =
      typeof init?.body === 'string'
        ? init.body
        : init?.body == null
          ? null
          : '<binary>';
    calls.push({ url: String(url), method, body });

    // Find first matching route.
    for (const [key, queue] of Object.entries(queues)) {
      const sep = key.indexOf(' ');
      const wantMethod = key.slice(0, sep);
      const wantUrl = key.slice(sep + 1);
      if (wantMethod !== method) continue;
      if (!new RegExp(wantUrl).test(String(url))) continue;
      const next: MockResponse =
        queue.length > 1 ? queue.shift()! : queue[0] ?? { status: 200 };
      const status = next.status ?? 200;
      const init: ResponseInit = { status };
      const responseBody: BodyInit | null =
        next.body === undefined
          ? null
          : typeof next.body === 'string'
            ? next.body
            : JSON.stringify(next.body);
      const headers = new Headers();
      if (typeof next.body !== 'string' && next.body !== undefined) {
        headers.set('content-type', 'application/json');
      }
      return new Response(responseBody, { ...init, headers });
    }
    return new Response(
      JSON.stringify({ object: 'error', code: 'no_mock_route', method, url: String(url) }),
      { status: 599, headers: { 'content-type': 'application/json' } },
    );
  };

  return { fetch: fetchImpl, calls };
}

/** In-memory `InstallerDbClient` for tests. */
export function fakeDb(initial?: Partial<WorkspaceForgeRecord>): {
  client: InstallerDbClient;
  state: WorkspaceForgeRecord;
  patches: Array<Partial<WorkspaceForgeRecord>>;
} {
  const state: WorkspaceForgeRecord = {
    forgePageId: initial?.forgePageId ?? null,
    forgeDbId: initial?.forgeDbId ?? null,
    forgeAgentsDbId: initial?.forgeAgentsDbId ?? null,
    forgeButtonBlockId: initial?.forgeButtonBlockId ?? null,
    forgeBuildLogBlockId: initial?.forgeBuildLogBlockId ?? null,
    webhookSecret: initial?.webhookSecret ?? null,
  };
  const patches: Array<Partial<WorkspaceForgeRecord>> = [];
  return {
    state,
    patches,
    client: {
      async getWorkspaceForgeRecord() {
        // Return a snapshot so callers can't mutate our state directly.
        return { ...state };
      },
      async updateWorkspaceForgeRecord(_workspaceId, patch) {
        patches.push(patch);
        for (const [k, v] of Object.entries(patch)) {
          (state as unknown as Record<string, unknown>)[k] = v;
        }
      },
    },
  };
}

/** Build a config object usable by notion-client functions in tests. */
export function cfg(fetch: FetchLike): { token: string; fetch: FetchLike } {
  return { token: 'test-token', fetch };
}
