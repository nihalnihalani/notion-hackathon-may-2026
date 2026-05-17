/**
 * Shipper sub-agent unit tests.
 *
 * Strategy:
 *  - `@forge/ntn-wrapper` is mocked at the module level with `vi.mock`. Every
 *    wrapper function we call (`deployWorker`, `listCapabilities`,
 *    `listWebhooks`, `startProviderOAuth`, `createFile`) is replaced with a
 *    vi.fn() so we can drive per-test behavior + assert call counts.
 *  - The Vercel Blob `put` function is injected via
 *    `config.vercelBlob.put` — no dynamic import in tests.
 *  - The MiniMax client factory is injected via
 *    `config.minimaxClientFactory`.
 *  - The Prisma client is injected via `config.dbClient` as a hand-rolled
 *    object with vi.fn()s for `generatedAgent.findUnique / create / update`.
 *  - The audit + usage-meter writers are injected via `config.dbHelpers` so
 *    the `@forge/db` dynamic import is never attempted from tests.
 *  - The Notion REST fetch is injected through `config.notionClient.fetch`
 *    (the wireCustomAgent helper picks it up).
 *
 * What this DOES NOT test:
 *  - End-to-end production behavior (would require a live `ntn` CLI + a
 *    Notion workspace). That belongs in the Playwright E2E suite.
 *  - The dynamic-import fallbacks for `@vercel/blob` / `@forge/connectors`
 *    — those branches are only hit when the test doesn't supply the
 *    injection, and exercising them requires the modules to be installed.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

// ── Module-level mocks ──────────────────────────────────────────────────────
//
// vi.mock hoists above imports, so we can use the mocked functions in the
// test body without re-importing them. We need to register a mock factory
// for `@forge/ntn-wrapper` since the Shipper imports its wrapper functions
// directly (no per-call client injection).
vi.mock('@forge/ntn-wrapper', () => ({
  deployWorker: vi.fn(),
  listCapabilities: vi.fn(),
  listWebhooks: vi.fn(),
  startProviderOAuth: vi.fn(),
  createFile: vi.fn(),
}));

import {
  deployWorker,
  listCapabilities,
  listWebhooks,
  startProviderOAuth,
  createFile,
  type WorkerCapability,
} from '@forge/ntn-wrapper';

import { shipper, type ShipperInput, type ShipperSubAgentConfig } from '../src/shipper.js';
import { ShipperError } from '../src/errors.js';
import type { SchemaSmithOutput, ToolCoderOutput } from '../src/types.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

const SCHEMA: SchemaSmithOutput = {
  pattern: 'database-query',
  inputSchema: { kind: 'object', describe: 'in', properties: {} },
  outputSchema: { kind: 'object', describe: 'out', properties: {} },
  requiredScopes: ['databases.read'],
  requiredOAuth: [],
  rationale: 'Fetch bug rows.',
};

const CODE: ToolCoderOutput = {
  source: 'export default async function tool() { return [] }',
  sourceLines: 1,
  packageJsonPatch: { dependencies: {} },
  workerName: 'bug-triager',
};

const CAPABILITIES: WorkerCapability[] = [
  { kind: 'tool', key: 'fetch_bugs', title: 'Fetch bugs' },
];

// ── Mock builders ───────────────────────────────────────────────────────────

interface CreatedRow {
  id: string;
  [k: string]: unknown;
}

function makeDbClient(opts?: {
  existingId?: string;
  /** Override what `create` resolves with. */
  createReturn?: Partial<CreatedRow>;
  /** Override what `update` resolves with. */
  updateReturn?: Partial<CreatedRow>;
}) {
  const create = vi.fn(async (args: { data: Record<string, unknown> }) => ({
    id: 'agent-new',
    ...args.data,
    ...opts?.createReturn,
  }));
  const update = vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => ({
    id: args.where.id,
    ...args.data,
    ...opts?.updateReturn,
  }));
  const findUnique = vi.fn(async () =>
    opts?.existingId !== undefined ? { id: opts.existingId } : null,
  );
  return {
    generatedAgent: { findUnique, create, update },
    _spies: { findUnique, create, update },
  };
}

/**
 * Builds a MiniMax client factory whose `generateImage` returns the given
 * urls. Pass `null` to simulate "no urls returned" (image_urls undefined);
 * pass `[]` for an empty array.
 */
function makeMinimaxFactory(
  image_urls: string[] | null = ['https://cdn/avatar.png'],
) {
  const generateImage = vi.fn(async () => ({
    base_resp: { status_code: 0, status_msg: 'ok' },
    data: image_urls === null ? undefined : { image_urls },
  }));
  return {
    factory: vi.fn(() => ({ generateImage })),
    generateImage,
  };
}

function makePut(opts?: { throws?: boolean; url?: string }) {
  return vi.fn(async (pathname: string) => {
    if (opts?.throws === true) throw new Error('blob upload failed');
    return {
      url: opts?.url ?? `https://blob.vercel/${pathname}`,
      pathname,
      contentType: 'text/typescript',
    };
  });
}

function makeResend() {
  const send = vi.fn(async () => ({ id: 'msg_1' }));
  return { send, client: { emails: { send } } };
}

/**
 * Default mock Notion fetch — returns 404 so wireCustomAgent takes the
 * fallback path. Tests that need the REST happy path pass their own
 * fetch via `notionClient.fetch`.
 *
 * Without this default the tests would either hit the real Notion API or
 * hang on `globalThis.fetch` resolving against an unreachable URL.
 */
function defaultNotionFetch(): (input: string | URL, init?: RequestInit) => Promise<Response> {
  return vi.fn(async () => new Response('not found', { status: 404 }));
}

function baseInput(
  config: Partial<ShipperSubAgentConfig> & Pick<ShipperSubAgentConfig, 'dbClient'>,
): ShipperInput {
  const { notionClient: notionOverride, ...rest } = config;
  return {
    generationId: 'gen-123',
    workspaceId: 'ws-internal-456',
    notionWorkspaceId: 'notion-ws-789',
    schema: SCHEMA,
    code: CODE,
    description: 'Triage open bugs into a Notion DB.',
    config: {
      anthropicApiKey: 'unused',
      sandbox: { id: 'test-sandbox' } as unknown as ShipperSubAgentConfig['sandbox'],
      notionClient: notionOverride ?? { token: 'secret_x', fetch: defaultNotionFetch() },
      vercelBlob: { token: 'blob_tok', put: makePut() },
      // Test-only: audit + usage are no-ops by default.
      dbHelpers: {
        recordAuditEvent: vi.fn(async () => undefined),
        recordUsage: vi.fn(async () => undefined),
      },
      ...rest,
    },
  };
}

// ── Default wrapper mock setup (reset every test) ──────────────────────────

beforeEach(() => {
  vi.mocked(deployWorker).mockReset();
  vi.mocked(listCapabilities).mockReset();
  vi.mocked(listWebhooks).mockReset();
  vi.mocked(startProviderOAuth).mockReset();
  vi.mocked(createFile).mockReset();

  vi.mocked(deployWorker).mockResolvedValue({
    workerName: 'bug-triager',
    workerId: 'wkr_1',
    deployUrl: 'https://bug-triager.notion.app/agent',
    dryRun: false,
    rawStdout: '',
  });
  vi.mocked(listCapabilities).mockResolvedValue(CAPABILITIES);
  vi.mocked(listWebhooks).mockResolvedValue([]);
  vi.mocked(startProviderOAuth).mockResolvedValue({
    result: {
      stdout: '',
      stderr: '',
      exitCode: 0,
      durationMs: 0,
      args: [],
    },
    redirectUrl: 'https://github.com/login/oauth/authorize?x',
  });
  vi.mocked(createFile).mockResolvedValue({ id: 'file_1' });
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe('shipper — happy path', () => {
  it('returns a fully-populated ShipperResult and persists the agent', async () => {
    const dbClient = makeDbClient();
    const result = await shipper(
      baseInput({
        dbClient,
      }),
    );

    expect(result.ntnWorkerName).toBe('bug-triager');
    expect(result.deployUrl).toBe('https://bug-triager.notion.app/agent');
    expect(result.capabilitiesDiscovered).toBe(1);
    expect(result.artifactBlobUrl).toMatch(/^https:\/\/blob\.vercel\//u);
    // No OAuth required in SCHEMA → no redirect URL.
    expect(result.oauthRedirectUrl).toBeUndefined();
    // No webhook capability → no webhook URL.
    expect(result.webhookUrl).toBeUndefined();
    // Custom Agent REST endpoint isn't real → fallback path.
    expect(result.customAgentId).toBeNull();

    expect(dbClient._spies.findUnique).toHaveBeenCalledTimes(1);
    expect(dbClient._spies.create).toHaveBeenCalledTimes(1);
    expect(dbClient._spies.update).not.toHaveBeenCalled();
  });

  it('writes audit log + usage meter on success', async () => {
    const dbClient = makeDbClient();
    const recordAuditEvent = vi.fn(async () => undefined);
    const recordUsage = vi.fn(async () => undefined);
    await shipper(
      baseInput({
        dbClient,
        dbHelpers: { recordAuditEvent, recordUsage },
      }),
    );
    expect(recordAuditEvent).toHaveBeenCalledTimes(1);
    expect(recordAuditEvent.mock.calls[0]?.[0]).toMatchObject({
      action: 'agent.deployed',
      workspaceId: 'ws-internal-456',
      resourceType: 'GeneratedAgent',
      metadata: {
        ntnWorkerName: 'bug-triager',
        pattern: 'database-query',
        generationId: 'gen-123',
      },
    });
    expect(recordUsage).toHaveBeenCalledWith('ws-internal-456', { deploysCount: 1 });
  });

  it('emits the shipper.deployed log line for PostHog forwarding', async () => {
    const dbClient = makeDbClient();
    const info = vi.fn();
    const error = vi.fn();
    await shipper(
      baseInput({
        dbClient,
        logger: { info, error },
      }),
    );
    const deployed = info.mock.calls.find((c) => c[0] === 'shipper.deployed');
    expect(deployed).toBeDefined();
    expect(deployed?.[1]).toMatchObject({
      agent: 'shipper',
      generationId: 'gen-123',
      workerName: 'bug-triager',
      capabilityCount: 1,
    });
  });
});

describe('shipper — avatar handling', () => {
  it('populates avatarUrl when MiniMax succeeds', async () => {
    const dbClient = makeDbClient();
    const { factory } = makeMinimaxFactory(['https://cdn/x.png']);
    await shipper(
      baseInput({
        dbClient,
        minimaxConfig: { apiKey: 'mm', groupId: 'g' },
        minimaxClientFactory: factory,
      }),
    );
    // Pull the persisted args off the spy.
    const created = dbClient._spies.create.mock.calls[0]?.[0].data;
    expect(created?.avatarUrl).toBe('https://cdn/x.png');
  });

  it('continues without avatar when MiniMax throws', async () => {
    const dbClient = makeDbClient();
    const factory = vi.fn(() => ({
      generateImage: vi.fn(async () => {
        throw new Error('minimax down');
      }),
    }));
    const result = await shipper(
      baseInput({
        dbClient,
        minimaxConfig: { apiKey: 'mm', groupId: 'g' },
        minimaxClientFactory: factory,
      }),
    );
    expect(result.ntnWorkerName).toBe('bug-triager');
    const created = dbClient._spies.create.mock.calls[0]?.[0].data;
    expect(created?.avatarUrl).toBeNull();
  });

  it('continues without avatar when MiniMax returns no urls', async () => {
    const dbClient = makeDbClient();
    const { factory } = makeMinimaxFactory(null);
    await shipper(
      baseInput({
        dbClient,
        minimaxConfig: { apiKey: 'mm', groupId: 'g' },
        minimaxClientFactory: factory,
      }),
    );
    const created = dbClient._spies.create.mock.calls[0]?.[0].data;
    expect(created?.avatarUrl).toBeNull();
  });

  it('skips MiniMax entirely when no config is supplied', async () => {
    const dbClient = makeDbClient();
    const factory = vi.fn();
    await shipper(
      baseInput({
        dbClient,
        minimaxClientFactory: factory as never,
      }),
    );
    expect(factory).not.toHaveBeenCalled();
  });
});

describe('shipper — Custom Agent REST fallback', () => {
  it('returns customAgentId=null and reports the fallback via the logger', async () => {
    const dbClient = makeDbClient();
    const info = vi.fn();
    const result = await shipper(
      baseInput({
        dbClient,
        logger: { info, error: vi.fn() },
        notionClient: {
          token: 'secret_x',
          // Force the 404 path.
          fetch: vi.fn(async () => new Response('nope', { status: 404 })),
        },
      }),
    );
    expect(result.customAgentId).toBeNull();
    const attempt = info.mock.calls.find((c) => c[0] === 'shipper.custom-agent.attempt');
    expect(attempt?.[1]).toMatchObject({ via: 'fallback', customAgentId: null });
  });

  it('returns customAgentId from REST when Notion responds 200 + id', async () => {
    const dbClient = makeDbClient();
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: 'custom_agent_42' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const result = await shipper(
      baseInput({
        dbClient,
        notionClient: { token: 'secret_x', fetch: fetchMock },
      }),
    );
    expect(result.customAgentId).toBe('custom_agent_42');
    const created = dbClient._spies.create.mock.calls[0]?.[0].data;
    expect(created?.notionCustomAgentId).toBe('custom_agent_42');
  });
});

describe('shipper — OAuth bootstrap', () => {
  it('populates oauthRedirectUrl when requiredOAuth is non-empty', async () => {
    const dbClient = makeDbClient();
    const input = baseInput({ dbClient });
    input.schema = {
      ...SCHEMA,
      requiredOAuth: ['github'],
    };
    const result = await shipper(input);
    expect(result.oauthRedirectUrl).toBe('https://github.com/login/oauth/authorize?x');
    expect(vi.mocked(startProviderOAuth)).toHaveBeenCalledWith(
      'github',
      expect.any(Object),
    );
  });

  it('omits oauthRedirectUrl when requiredOAuth is empty', async () => {
    const dbClient = makeDbClient();
    const result = await shipper(baseInput({ dbClient }));
    expect(result.oauthRedirectUrl).toBeUndefined();
    expect(vi.mocked(startProviderOAuth)).not.toHaveBeenCalled();
  });

  it('throws ShipperError when startProviderOAuth fails', async () => {
    const dbClient = makeDbClient();
    vi.mocked(startProviderOAuth).mockRejectedValueOnce(new Error('oauth boom'));
    const input = baseInput({ dbClient });
    input.schema = { ...SCHEMA, requiredOAuth: ['github'] };
    await expect(shipper(input)).rejects.toBeInstanceOf(ShipperError);
  });
});

describe('shipper — webhook URL discovery', () => {
  it('populates webhookUrl when a webhook capability + listing match', async () => {
    const dbClient = makeDbClient();
    vi.mocked(listCapabilities).mockResolvedValueOnce([
      { kind: 'webhook', key: 'on_bug' },
    ]);
    vi.mocked(listWebhooks).mockResolvedValueOnce([
      { id: 'wh_1', url: 'https://hooks.notion.so/abc', workerName: 'bug-triager' },
    ]);
    const result = await shipper(baseInput({ dbClient }));
    expect(result.webhookUrl).toBe('https://hooks.notion.so/abc');
  });

  it('skips webhook discovery when no webhook capability is declared', async () => {
    const dbClient = makeDbClient();
    await shipper(baseInput({ dbClient }));
    expect(vi.mocked(listWebhooks)).not.toHaveBeenCalled();
  });

  it('continues without webhook URL when listWebhooks fails', async () => {
    const dbClient = makeDbClient();
    vi.mocked(listCapabilities).mockResolvedValueOnce([
      { kind: 'webhook', key: 'on_bug' },
    ]);
    vi.mocked(listWebhooks).mockRejectedValueOnce(new Error('webhooks api down'));
    const result = await shipper(baseInput({ dbClient }));
    // Best-effort: result still ships, no webhook URL.
    expect(result.webhookUrl).toBeUndefined();
  });
});

describe('shipper — idempotency', () => {
  it('updates instead of inserting when a row for the generationId already exists', async () => {
    const dbClient = makeDbClient({ existingId: 'existing-agent-77' });
    const result = await shipper(baseInput({ dbClient }));
    expect(dbClient._spies.findUnique).toHaveBeenCalledTimes(1);
    expect(dbClient._spies.create).not.toHaveBeenCalled();
    expect(dbClient._spies.update).toHaveBeenCalledTimes(1);
    expect(dbClient._spies.update.mock.calls[0]?.[0]).toMatchObject({
      where: { id: 'existing-agent-77' },
    });
    expect(result.ntnWorkerName).toBe('bug-triager');
  });
});

describe('shipper — infrastructure failures', () => {
  it('throws ShipperError when deployWorker fails', async () => {
    const dbClient = makeDbClient();
    vi.mocked(deployWorker).mockRejectedValueOnce(new Error('deploy boom'));
    await expect(shipper(baseInput({ dbClient }))).rejects.toBeInstanceOf(ShipperError);
    // Persistence must NOT happen on deploy failure.
    expect(dbClient._spies.create).not.toHaveBeenCalled();
  });

  it('throws ShipperError when listCapabilities fails', async () => {
    const dbClient = makeDbClient();
    vi.mocked(listCapabilities).mockRejectedValueOnce(new Error('caps boom'));
    await expect(shipper(baseInput({ dbClient }))).rejects.toBeInstanceOf(ShipperError);
  });

  it('throws ShipperError when Vercel Blob put fails', async () => {
    const dbClient = makeDbClient();
    const cfg = baseInput({
      dbClient,
    });
    cfg.config = { ...cfg.config, vercelBlob: { token: 'tok', put: makePut({ throws: true }) } };
    await expect(shipper(cfg)).rejects.toBeInstanceOf(ShipperError);
  });

  it('throws ShipperError when the DB persistence fails', async () => {
    const dbClient = makeDbClient();
    dbClient._spies.create.mockRejectedValueOnce(new Error('db boom'));
    await expect(shipper(baseInput({ dbClient }))).rejects.toBeInstanceOf(ShipperError);
  });

  it('survives audit log failures (best-effort)', async () => {
    const dbClient = makeDbClient();
    const recordAuditEvent = vi.fn(async () => {
      throw new Error('audit boom');
    });
    const recordUsage = vi.fn(async () => undefined);
    const result = await shipper(
      baseInput({
        dbClient,
        dbHelpers: { recordAuditEvent, recordUsage },
      }),
    );
    expect(result.ntnWorkerName).toBe('bug-triager');
    expect(recordAuditEvent).toHaveBeenCalled();
  });

  it('survives usage-meter failures (best-effort)', async () => {
    const dbClient = makeDbClient();
    const recordUsage = vi.fn(async () => {
      throw new Error('usage boom');
    });
    const result = await shipper(
      baseInput({
        dbClient,
        dbHelpers: { recordAuditEvent: vi.fn(), recordUsage },
      }),
    );
    expect(result.ntnWorkerName).toBe('bug-triager');
  });
});

describe('shipper — email', () => {
  it('sends a Resend email when client + recipient are provided', async () => {
    const dbClient = makeDbClient();
    const resend = makeResend();
    await shipper(
      baseInput({
        dbClient,
        resendClient: resend.client,
        emailTo: 'user@example.com',
      }),
    );
    expect(resend.send).toHaveBeenCalledTimes(1);
    const args = resend.send.mock.calls[0]?.[0] as {
      from: string;
      to: string;
      subject: string;
      text: string;
    };
    expect(args.to).toBe('user@example.com');
    expect(args.subject).toContain('bug-triager');
    expect(args.text).toContain('Your new Notion agent is live');
  });

  it('skips the email when no Resend client is supplied', async () => {
    const dbClient = makeDbClient();
    const result = await shipper(baseInput({ dbClient }));
    expect(result.ntnWorkerName).toBe('bug-triager');
  });

  it('skips the email (but ships) when the recipient is missing', async () => {
    const dbClient = makeDbClient();
    const resend = makeResend();
    const error = vi.fn();
    await shipper(
      baseInput({
        dbClient,
        resendClient: resend.client,
        // emailTo intentionally absent.
        logger: { info: vi.fn(), error },
      }),
    );
    expect(resend.send).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      'shipper.email.skipped_no_recipient',
      expect.any(Object),
    );
  });
});

describe('shipper — abort signal', () => {
  it('throws ShipperError immediately when the signal is already aborted', async () => {
    const dbClient = makeDbClient();
    const ctrl = new AbortController();
    ctrl.abort();
    const input = baseInput({ dbClient, abortSignal: ctrl.signal });
    await expect(shipper(input)).rejects.toBeInstanceOf(ShipperError);
    expect(vi.mocked(deployWorker)).not.toHaveBeenCalled();
  });
});
