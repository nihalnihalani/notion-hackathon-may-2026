/**
 * Shipper — the fourth (and final) Forge sub-agent.
 *
 * Job (PLAN.md §IV.4): promote the validated Worker into the user's Notion
 * workspace, wire it into a Custom Agent, archive the source, persist
 * everything, and notify the user.
 *
 * The Shipper does NOT call a model. Every step is pure orchestration of:
 *   - `@forge/ntn-wrapper`     — deploy, capability discovery, OAuth, webhooks, files
 *   - `@forge/notion-client`   — Custom Agent REST attempt + workspace deep-link
 *   - `@forge/db`              — GeneratedAgent persistence, audit log, usage meter
 *   - `@forge/connectors`      — MiniMax avatar generation (optional)
 *   - `@vercel/blob`           — source archive (dynamic-imported / injectable)
 *
 * Hard rules:
 *   1. PRODUCTION ONLY. No demo paths, no `if (testing) return mock`. The
 *      injection points exist for *unit testing*; production callers pass real
 *      clients.
 *   2. Deploy failure (Step 1) → throw {@link ShipperError}. Everything after
 *      Step 1 has a documented failure mode (avatar, OAuth surfacing, REST
 *      Custom Agent wiring) — those gracefully degrade, the result still
 *      ships.
 *   3. Idempotency: the brief calls this out explicitly. If a `GeneratedAgent`
 *      already exists for this `generationId`, we UPDATE the row instead of
 *      creating a duplicate. The `@unique` constraint on
 *      `GeneratedAgent.generationId` (see prisma/schema.prisma) also enforces
 *      this at the DB layer.
 *   4. The Vercel Blob token comes ONLY from `config.vercelBlob.token` — we
 *      never read `process.env.BLOB_READ_WRITE_TOKEN` directly. This keeps
 *      the agent runtime-agnostic (Edge, Node, Vercel Sandbox).
 *
 * Failure-mode matrix:
 *
 *   Step                     | Failure mode                       | Action
 *   ─────────────────────────|────────────────────────────────────|──────────
 *   1. Final deploy          | Any error                          | THROW ShipperError
 *   2. Discover capabilities | Wrapper throws                     | THROW ShipperError
 *   3. Custom Agent wire-up  | Endpoint missing / fails           | Fallback URL, continue
 *   4. OAuth bootstrap       | startProviderOAuth throws          | THROW ShipperError
 *   5. Webhook URL discovery | listWebhooks throws                | Log + continue (best-effort)
 *   6. Blob upload + ntn file| Either throws                      | THROW ShipperError
 *   7. Avatar generation     | MiniMax throws / not configured    | Log warn, continue (no avatar)
 *   8. Persist               | DB throws                          | THROW ShipperError
 *   9. Audit                 | recordAuditEvent throws            | Log + continue (audit ≠ critical path)
 *  10. Usage meter           | recordUsage throws                 | Log + continue
 *  11. PostHog event         | logger swallows by contract        | n/a
 *  12. Email                 | Resend not provided                | Skip
 *                           | Resend throws                       | Log + continue
 */

import {
  createFile,
  deployWorker,
  listCapabilities,
  listWebhooks,
  startProviderOAuth,
  type WorkerCapability,
} from '@forge/ntn-wrapper';

// Runtime imports of `@forge/db` are kept dynamic (via a thin helper) so the
// agents package type-checks even when the DB package hasn't been built yet
// in this clone — `prisma generate` is a precondition for `@forge/db`'s
// `dist` to exist, and the brief forbids running `pnpm install` from this
// stage. The structural types below mirror the @forge/db public surface
// exactly; switching to a `import type { ... } from '@forge/db'` is a
// one-line change once the DB build pipeline catches up.

import type { NotionClientConfig, WorkspaceId } from './custom-agent-wiring.js';

import { ShipperError } from './errors.js';
import { deriveAvatarPrompt } from './avatar-prompt.js';
import { formatReleaseNotes } from './release-notes.js';
import { wireCustomAgent } from './custom-agent-wiring.js';
import type { SandboxRunner } from './sandbox.js';
import {
  noopLogger,
  type AgentPattern,
  type ProviderName,
  type SchemaSmithOutput,
  type ShipperResult,
  type SubAgentConfig,
  type SubAgentLogger,
  type ToolCoderOutput,
} from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Public surface
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Snake-case Prisma `AgentPattern` enum value. Mirrors
 * `prisma/schema.prisma` exactly — extracted as a string-literal union (not
 * imported from `@forge/db`) so the agents package can type-check even when
 * `prisma generate` hasn't been run.
 */
export type PrismaAgentPattern =
  | 'database_query'
  | 'webhook_trigger'
  | 'sync_source'
  | 'external_api_call'
  | 'multi_step';

/**
 * Structural shape of the `GeneratedAgent` Prisma row this Shipper writes
 * to + reads back. Subset; mirrors what the persistence helper actually
 * touches. The real Prisma model has additional fields (`createdAt`,
 * `totalInvocations`, etc.) that are defaulted on insert — we don't need to
 * reference them here.
 */
export interface GeneratedAgentRow {
  id: string;
  workspaceId: string;
  generationId: string;
  ntnWorkerName: string;
  ntnDeployUrl: string | null;
  notionCustomAgentId: string | null;
  pattern: PrismaAgentPattern;
  description: string;
  sourceBlobUrl: string;
  avatarUrl: string | null;
  capabilities: unknown;
  oauthProviders: string[];
  webhookUrl: string | null;
  status: 'active' | 'paused' | 'retracted';
}

/**
 * Structural subset of `PrismaClient` the Shipper actually consumes. The
 * real `@forge/db` singleton satisfies this shape; tests pass a hand-rolled
 * mock with the same surface. Excess properties on the real client are fine.
 *
 * Only `generatedAgent.{findUnique, create, update}` are exercised. Audit
 * + usage writes go through the dedicated `recordAuditEvent` / `recordUsage`
 * helpers (loaded dynamically — see {@link loadDbHelpers}).
 */
export interface ShipperPrismaClient {
  generatedAgent: {
    findUnique: (args: {
      where: { generationId: string };
      select?: { id?: boolean };
    }) => Promise<{ id: string } | null>;
    create: (args: {
      data: Omit<GeneratedAgentRow, 'id'> & { capabilities: unknown };
    }) => Promise<GeneratedAgentRow>;
    update: (args: {
      where: { id: string };
      data: Partial<GeneratedAgentRow>;
    }) => Promise<GeneratedAgentRow>;
  };
}

/**
 * Structural type for the (optional) Resend client. We intentionally do NOT
 * import `resend` directly — the brief allows skipping the dep entirely. The
 * shape mirrors `resend.emails.send` as of resend@4.x.
 */
export interface ShipperResendClient {
  emails: {
    send: (input: {
      from: string;
      to: string | readonly string[];
      subject: string;
      html?: string;
      text?: string;
    }) => Promise<unknown>;
  };
}

/**
 * Minimum surface from `@vercel/blob` we depend on. The Shipper accepts the
 * function directly so tests can supply a vi.fn(); production callers pass
 * the real `put` import.
 *
 * Returning a single object with `url` + `pathname` matches the documented
 * `PutBlobResult` shape (https://vercel.com/docs/vercel-blob/using-blob-sdk).
 */
export type VercelBlobPutFn = (
    pathname: string,
    body: string | ArrayBuffer | Uint8Array | Blob | ReadableStream,
    options: {
      access: 'public' | 'private';
      token: string;
      contentType?: string;
      addRandomSuffix?: boolean;
      cacheControlMaxAge?: number;
      allowOverwrite?: boolean;
      abortSignal?: AbortSignal;
    },
  ) => Promise<{
    url: string;
    pathname: string;
    contentType?: string;
    contentDisposition?: string;
    downloadUrl?: string;
  }>;

/**
 * MiniMax client config for avatar generation. Only required when the caller
 * wants an avatar (PLAN.md §IV.4 step 7 is explicitly optional).
 *
 * Both `apiKey` and `groupId` are forwarded into `createMinimaxClient`. The
 * `groupId` is currently unused by the image-gen endpoint but documented in
 * the brief — we capture it on the config so the Shipper stays forward-
 * compatible if MiniMax later requires it.
 */
export interface MinimaxConfig {
  apiKey: string;
  groupId: string;
}

/**
 * Shipper sub-agent config. Extends the shared {@link SubAgentConfig} with
 * the integrations the Shipper needs on top of the LLM clients (which the
 * Shipper does NOT use itself — kept for shape uniformity across the four
 * sub-agents).
 */
export type ShipperSubAgentConfig = SubAgentConfig & {
  sandbox: SandboxRunner;
  notionClient: NotionClientConfig;
  vercelBlob: {
    token: string;
    /**
     * Injection seam for tests + alt runtimes. Production callers omit this
     * field and we dynamic-import `@vercel/blob` lazily.
     */
    put?: VercelBlobPutFn;
  };
  minimaxConfig?: MinimaxConfig;
  /**
   * Pre-built prisma-shaped client. The brief explicitly requires this for
   * testability; production callers pass `prisma` from `@forge/db`.
   */
  dbClient: ShipperPrismaClient;
  /** Optional Resend client; when omitted, email step is skipped. */
  resendClient?: ShipperResendClient;
  /**
   * Notion workspace id (the URL slug used to build the deep-link). The DB
   * `Workspace.notionWorkspaceId` column carries the same value.
   */
  notionWorkspaceIdForLink?: string;
  /**
   * Email recipient address. When the Shipper has a Resend client but no
   * `to` address is configured, the email step is skipped (a configured
   * Resend client with no recipient is a config bug — we log a warning).
   */
  emailTo?: string;
  /**
   * `From` address for the Resend email. Defaults to
   * `Forge <notifications@forge.dev>` when omitted.
   */
  emailFrom?: string;
  /**
   * Injection seam for the MiniMax client factory. Tests supply a stub; in
   * production we dynamic-import `@forge/connectors/minimax` lazily.
   */
  minimaxClientFactory?: (cfg: MinimaxConfig) => {
    generateImage: (params: {
      prompt: string;
      size?: string;
      count?: number;
    }) => Promise<{ data?: { image_urls?: string[] } }>;
  };
  /**
   * Injection seam for the `@forge/db` audit + usage-meter writers. Tests
   * supply vi.fn()'s; production callers omit and we resolve them via the
   * lazy {@link loadDbHelpers} import.
   */
  dbHelpers?: {
    recordAuditEvent?: DbHelpers['recordAuditEvent'];
    recordUsage?: DbHelpers['recordUsage'];
  };
};

/**
 * Input shape for {@link shipper}.
 */
export interface ShipperInput {
  /** Generation id (cuid). Used as the idempotency key against the DB. */
  generationId: string;
  /** PlanetScale `Workspace.id` (cuid). NOT the Notion workspace id. */
  workspaceId: string;
  /** Notion workspace id (UUID-ish). Used to build the Custom Agent deep-link. */
  notionWorkspaceId: string;
  /** Schema Smith's output — only `pattern`, `requiredOAuth`, etc. are read. */
  schema: SchemaSmithOutput;
  /** Tool Coder's output — `source`, `sourceLines`, `workerName` are read. */
  code: ToolCoderOutput;
  /**
   * Original user-typed description. Persisted into
   * `GeneratedAgent.description`, used for the release-notes body, and fed
   * into the MiniMax avatar prompt. The orchestrator pulls this off the
   * `Generation` row before invoking the Shipper.
   *
   * Optional for orchestrator-flexibility — when omitted we fall back to the
   * Schema Smith `rationale` so the column is never empty.
   */
  description?: string;
  /** Sub-agent config bundle. */
  config: ShipperSubAgentConfig;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert kebab-case {@link AgentPattern} → the snake_case prisma enum value.
 *
 * Lives here (not in `types.ts`) because this is a *boundary translation*:
 * the agents layer speaks kebab-case (PLAN.md §IV.1) and the DB layer speaks
 * snake_case (prisma schema). Centralising the table keeps the conversion
 * auditable in one place.
 */
function patternToPrismaEnum(pattern: AgentPattern): PrismaAgentPattern {
  const map: Record<AgentPattern, PrismaAgentPattern> = {
    'database-query': 'database_query',
    'webhook-trigger': 'webhook_trigger',
    'sync-source': 'sync_source',
    'external-api-call': 'external_api_call',
    'multi-step': 'multi_step',
  };
  return map[pattern];
}

/**
 * Surface a {@link ShipperSubAgentConfig} hook for the audit + usage-meter
 * writers. Tests can pass their own implementations through `config.dbHelpers`
 * to keep the assertion surface tight (e.g. `expect(audit).toHaveBeenCalled`);
 * production calls resolve to `@forge/db`'s `recordAuditEvent` / `recordUsage`
 * via the dynamic loader below.
 */
interface DbHelpers {
  recordAuditEvent: (params: {
    workspaceId: string;
    userId: string | null;
    action: 'agent.deployed';
    resourceType: string;
    resourceId: string;
    metadata: { ntnWorkerName: string; pattern: string; generationId: string };
  }) => Promise<void>;
  recordUsage: (
    workspaceId: string,
    fields: { deploysCount?: number },
  ) => Promise<void>;
}

/**
 * Best-effort dynamic loader for `@forge/db`'s audit + usage writers. Both
 * are non-critical to the deploy itself (PLAN.md says audit + usage are
 * append-only side-effects). If the import fails we return a pair of no-ops
 * so the Shipper still ships, and log the load failure once.
 */
async function loadDbHelpers(
  override: Partial<DbHelpers> | undefined,
  logger: SubAgentLogger,
): Promise<DbHelpers> {
  if (override?.recordAuditEvent !== undefined && override.recordUsage !== undefined) {
    return {
      recordAuditEvent: override.recordAuditEvent,
      recordUsage: override.recordUsage,
    };
  }
  try {
    const mod = (await import(/* @vite-ignore */ '@forge/db' as string)) as Partial<DbHelpers>;
    return {
      recordAuditEvent:
        override?.recordAuditEvent ??
        (mod.recordAuditEvent ??
          (async () => {
            /* no-op */
          })),
      recordUsage:
        override?.recordUsage ??
        (mod.recordUsage ??
          (async () => {
            /* no-op */
          })),
    };
  } catch (error) {
    logger.error('shipper.db_helpers.load_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      recordAuditEvent: async () => {
        /* no-op */
      },
      recordUsage: async () => {
        /* no-op */
      },
    };
  }
}

/**
 * Dynamic import of `@vercel/blob` — only invoked when the caller did NOT
 * supply `config.vercelBlob.put`. We use a function-scoped dynamic import so
 * the Edge bundle stays lean when the Shipper isn't pulled in.
 *
 * If the import fails (package not installed in this runtime), surface a
 * detailed {@link ShipperError} so the caller knows to either install the
 * dep or pass `config.vercelBlob.put` explicitly.
 */
async function resolveBlobPut(config: ShipperSubAgentConfig): Promise<VercelBlobPutFn> {
  if (config.vercelBlob.put !== undefined) return config.vercelBlob.put;
  try {
    // The package is declared as a runtime dependency in `package.json` but
    // typed structurally via {@link VercelBlobPutFn} so this module stays
    // type-checkable even when `node_modules/@vercel/blob` hasn't been
    // installed yet (the brief forbids running pnpm install). The dynamic
    // string + `as any` keeps tsc from following the (potentially missing)
    // module resolution path.
    const mod = (await import(
      /* @vite-ignore */ '@vercel/blob' as string
    )) as { put?: VercelBlobPutFn };
    if (typeof mod.put !== 'function') {
      throw new TypeError('`@vercel/blob` resolved but does not export `put`');
    }
    return mod.put;
  } catch (error) {
    throw new ShipperError(
      'Shipper could not load @vercel/blob — install the package or pass config.vercelBlob.put explicitly.',
      { cause: error, detail: { step: 'blob_resolve' } },
    );
  }
}

/**
 * Same pattern as {@link resolveBlobPut}, but for the MiniMax connector. Only
 * called when the caller asked for an avatar (i.e. `minimaxConfig` is set).
 */
async function resolveMinimaxFactory(
  config: ShipperSubAgentConfig,
): Promise<NonNullable<ShipperSubAgentConfig['minimaxClientFactory']>> {
  if (config.minimaxClientFactory !== undefined) return config.minimaxClientFactory;
  const mod = (await import('@forge/connectors/minimax')) as {
    createMinimaxClient?: (cfg: { apiKey: string }) => {
      generateImage: (params: {
        prompt: string;
        size?: string;
        count?: number;
      }) => Promise<{ data?: { image_urls?: string[] } }>;
    };
  };
  const { createMinimaxClient } = mod;
  if (typeof createMinimaxClient !== 'function') {
    throw new TypeError('@forge/connectors/minimax does not export createMinimaxClient');
  }
  return (cfg) => createMinimaxClient({ apiKey: cfg.apiKey });
}

/**
 * Helper: best-effort op that swallows-and-logs instead of throwing. Used for
 * audit + usage-meter writes which must NEVER block a successful ship.
 */
async function bestEffort<T>(
  description: string,
  logger: SubAgentLogger,
  op: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await op();
  } catch (error) {
    logger.error(`shipper.best-effort.failed: ${description}`, {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

/**
 * Pacing helper: when the user-supplied AbortSignal fires we want to bail out
 * cleanly between steps. Throws a {@link ShipperError} on abort.
 */
function assertNotAborted(signal: AbortSignal | undefined, step: string): void {
  if (signal?.aborted === true) {
    throw new ShipperError(`Shipper aborted before ${step}`, {
      detail: { step, reason: 'aborted' },
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Promote a validated Worker into the user's Notion workspace, wire it up,
 * archive its source, persist its metadata, and (optionally) email the user.
 *
 * Returns a fully-populated {@link ShipperResult}. Throws {@link ShipperError}
 * only on infrastructure-level failures (deploy / capability discovery /
 * source archive / DB write).
 *
 * @see PLAN.md §IV.4 for the per-step spec.
 */
export async function shipper(input: ShipperInput): Promise<ShipperResult> {
  const logger = input.config.logger ?? noopLogger;
  const startedAt = Date.now();
  const { code, schema, config, generationId, workspaceId } = input;
  const { workerName } = code;
  /**
   * Resolved description: prefer the caller-supplied original prompt, fall
   * back to Schema Smith's rationale so the DB column is never empty.
   */
  const description =
    input.description !== undefined && input.description.length > 0
      ? input.description
      : schema.rationale;

  // ── Step 1: Final deploy ────────────────────────────────────────────────
  assertNotAborted(config.abortSignal, 'final_deploy');
  let deployUrl: string;
  try {
    const deployResult = await deployWorker(workerName, {
      dryRun: false,
      ...(config.abortSignal === undefined ? {} : { signal: config.abortSignal }),
    });
    if (deployResult.deployUrl === undefined || deployResult.deployUrl.length === 0) {
      // The CLI didn't print a URL we could parse — a known edge case on
      // older `ntn` releases. We synthesise a best-effort URL from the
      // worker name so the user at least sees something actionable.
      deployUrl = `https://${workerName}.notion.app/agent`;
      logger.error('shipper.deploy.no_url', { workerName });
    } else {
      deployUrl = deployResult.deployUrl;
    }
  } catch (error) {
    throw new ShipperError(`Shipper failed at final deploy for worker "${workerName}"`, {
      cause: error,
      detail: { step: 'final_deploy', workerName },
    });
  }

  // ── Step 2: Discover capabilities ───────────────────────────────────────
  assertNotAborted(config.abortSignal, 'discover_capabilities');
  let capabilities: WorkerCapability[];
  try {
    capabilities = await listCapabilities(workerName, {
      ...(config.abortSignal === undefined ? {} : { signal: config.abortSignal }),
    });
  } catch (error) {
    throw new ShipperError(`Shipper failed at capability discovery for "${workerName}"`, {
      cause: error,
      detail: { step: 'discover_capabilities', workerName },
    });
  }

  // ── Step 3: Wire Custom Agent (REST attempt → deep-link fallback) ──────
  assertNotAborted(config.abortSignal, 'wire_custom_agent');
  const wireResult = await wireCustomAgent({
    notionConfig: config.notionClient,
    workerName,
    capabilities,
    // `WorkspaceId` is a branded string alias — the helper just stringifies it.
    workspaceId: input.notionWorkspaceId as unknown as WorkspaceId,
  });
  logger.info('shipper.custom-agent.attempt', {
    via: wireResult.via,
    customAgentId: wireResult.customAgentId,
    capabilityCount: capabilities.length,
  });

  // ── Step 4: OAuth bootstrap (per provider) ──────────────────────────────
  assertNotAborted(config.abortSignal, 'oauth_bootstrap');
  let oauthRedirectUrl: string | undefined;
  const oauthProviders: ProviderName[] = [...schema.requiredOAuth];
  if (oauthProviders.length > 0) {
    for (const provider of oauthProviders) {
      try {
        const oauth = await startProviderOAuth(provider, {
          ...(config.abortSignal === undefined ? {} : { signal: config.abortSignal }),
        });
        // First non-empty redirect URL wins — the Shipper surfaces one in
        // the result for the user to click; subsequent providers will be
        // listed in the email via `release notes` (Step 12).
        if (oauthRedirectUrl === undefined && oauth.redirectUrl !== undefined) {
          oauthRedirectUrl = oauth.redirectUrl;
        }
      } catch (error) {
        throw new ShipperError(
          `Shipper failed at OAuth bootstrap for provider "${provider}"`,
          { cause: error, detail: { step: 'oauth_bootstrap', provider } },
        );
      }
    }
  }

  // ── Step 5: Webhook URL discovery (best-effort) ─────────────────────────
  assertNotAborted(config.abortSignal, 'webhook_discovery');
  let webhookUrl: string | undefined;
  const workerDeclaresWebhook = capabilities.some((c) => c.kind === 'webhook');
  if (workerDeclaresWebhook) {
    const endpoints = await bestEffort('webhook_discovery', logger, () =>
      listWebhooks({
        filter: { workerName },
        ...(config.abortSignal === undefined ? {} : { signal: config.abortSignal }),
      }),
    );
    if (endpoints !== undefined && endpoints.length > 0) {
      const first = endpoints[0];
      if (first?.url !== undefined && first.url.length > 0) {
        webhookUrl = first.url;
      }
    }
  }

  // ── Step 6: Archive source (Vercel Blob + ntn files create) ─────────────
  assertNotAborted(config.abortSignal, 'archive_source');
  const put = await resolveBlobPut(config);
  // Use a deterministic-ish path tied to the generation so re-runs of the
  // same generation overwrite (instead of accumulating duplicates) but
  // separate generations never collide. `addRandomSuffix: false` makes the
  // URL predictable across retries.
  const blobPathname = `forge/generated-agents/${generationId}/${workerName}.ts`;
  let artifactBlobUrl: string;
  try {
    const putResult = await put(blobPathname, code.source, {
      access: 'public',
      token: config.vercelBlob.token,
      contentType: 'text/typescript',
      addRandomSuffix: false,
      allowOverwrite: true,
      ...(config.abortSignal === undefined ? {} : { abortSignal: config.abortSignal }),
    });
    artifactBlobUrl = putResult.url;
  } catch (error) {
    throw new ShipperError('Shipper failed at Vercel Blob upload', {
      cause: error,
      detail: { step: 'archive_source', pathname: blobPathname },
    });
  }

  // Attach the blob URL to the generated-agent's Notion DB row via
  // `ntn files create`. Failure here is non-fatal — the source still lives
  // on the blob URL we just got back.
  await bestEffort('ntn_files_create', logger, () =>
    createFile(
      {
        name: `${workerName}.ts`,
        url: artifactBlobUrl,
        contentType: 'text/typescript',
        generationId,
      },
      config.abortSignal === undefined ? {} : { signal: config.abortSignal },
    ),
  );

  // ── Step 7: Avatar generation (optional, best-effort) ───────────────────
  assertNotAborted(config.abortSignal, 'avatar_generation');
  let avatarUrl: string | undefined;
  if (config.minimaxConfig !== undefined && schema.pattern !== null) {
    try {
      const factory = await resolveMinimaxFactory(config);
      const minimax = factory(config.minimaxConfig);
      const prompt = deriveAvatarPrompt(description, schema.pattern);
      const imageResponse = await minimax.generateImage({
        prompt,
        size: '512x512',
        count: 1,
      });
      const firstUrl = imageResponse.data?.image_urls?.[0];
      if (typeof firstUrl === 'string' && firstUrl.length > 0) {
        avatarUrl = firstUrl;
      } else {
        logger.error('shipper.avatar.empty', { workerName });
      }
    } catch (error) {
      logger.error('shipper.avatar.failed', {
        workerName,
        error: error instanceof Error ? error.message : String(error),
      });
      // Non-critical: continue without an avatar.
    }
  }

  // ── Step 8: Persist (with idempotency) ──────────────────────────────────
  assertNotAborted(config.abortSignal, 'persist');
  const persistedPattern: AgentPattern = schema.pattern ?? 'multi-step';
  let persistedAgent: GeneratedAgentRow;
  try {
    persistedAgent = await persistGeneratedAgent({
      db: config.dbClient,
      generationId,
      workspaceId,
      workerName,
      deployUrl,
      customAgentId: wireResult.customAgentId,
      pattern: persistedPattern,
      description,
      sourceBlobUrl: artifactBlobUrl,
      avatarUrl,
      capabilities,
      oauthProviders,
      webhookUrl,
    });
  } catch (error) {
    throw new ShipperError('Shipper failed at GeneratedAgent persistence', {
      cause: error,
      detail: { step: 'persist', generationId, workspaceId },
    });
  }

  // Resolve audit + usage writers (test-injectable, falls back to @forge/db).
  const dbHelpers = await loadDbHelpers(config.dbHelpers, logger);

  // ── Step 9: Audit log (best-effort) ─────────────────────────────────────
  await bestEffort('audit_log', logger, () =>
    dbHelpers.recordAuditEvent({
      workspaceId,
      userId: null,
      action: 'agent.deployed',
      resourceType: 'GeneratedAgent',
      resourceId: persistedAgent.id,
      metadata: {
        ntnWorkerName: workerName,
        pattern: persistedPattern,
        generationId,
      },
    }),
  );

  // ── Step 10: Usage meter (best-effort) ──────────────────────────────────
  await bestEffort('usage_meter', logger, () =>
    dbHelpers.recordUsage(workspaceId, { deploysCount: 1 }),
  );

  // ── Step 11: PostHog event (via logger; orchestrator forwards) ──────────
  logger.info('shipper.deployed', {
    agent: 'shipper',
    generationId,
    workspaceId,
    workerName,
    deployUrl,
    customAgentId: wireResult.customAgentId,
    via: wireResult.via,
    capabilityCount: capabilities.length,
    hasWebhook: webhookUrl !== undefined,
    hasOauth: oauthRedirectUrl !== undefined,
    hasAvatar: avatarUrl !== undefined,
    latencyMs: Date.now() - startedAt,
  });

  // ── Step 12: Email via Resend (optional, best-effort) ───────────────────
  const resendClient = config.resendClient;
  if (resendClient !== undefined) {
    const emailTo = config.emailTo;
    if (emailTo === undefined || emailTo.length === 0) {
      logger.error('shipper.email.skipped_no_recipient', { workerName });
    } else {
      const releaseNotes = formatReleaseNotes({
        description,
        pattern: persistedPattern,
        deployUrl,
        webhookUrl,
        oauthRedirectUrl,
        sourceLines: input.code.sourceLines,
      });
      await bestEffort('resend_email', logger, () =>
        resendClient.emails.send({
          from: config.emailFrom ?? 'Forge <notifications@forge.dev>',
          to: emailTo,
          subject: `Your Notion agent "${workerName}" is live`,
          text: releaseNotes,
        }),
      );
    }
  }

  // ── Final result ────────────────────────────────────────────────────────
  return {
    customAgentId: wireResult.customAgentId,
    deployUrl,
    ntnWorkerName: workerName,
    ...(webhookUrl === undefined ? {} : { webhookUrl }),
    ...(oauthRedirectUrl === undefined ? {} : { oauthRedirectUrl }),
    artifactBlobUrl,
    capabilitiesDiscovered: capabilities.length,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Persistence: idempotent create-or-update on generationId
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Persist a GeneratedAgent row, idempotent on `generationId`. If a row
 * already exists for this generation (i.e. the Shipper is being re-run after
 * a Workflow restart), we update it in place instead of inserting a duplicate
 * — the DB also enforces this with `@unique` on `generationId`, but checking
 * first lets us avoid a constraint-violation round-trip on the hot path.
 *
 * Uses `prisma.generatedAgent.upsert` which is one round-trip in either
 * direction. Wrapped in this helper to keep the Shipper entry point readable.
 */
async function persistGeneratedAgent(args: {
  db: ShipperPrismaClient;
  generationId: string;
  workspaceId: string;
  workerName: string;
  deployUrl: string;
  customAgentId: string | null;
  pattern: AgentPattern;
  description: string;
  sourceBlobUrl: string;
  avatarUrl: string | undefined;
  capabilities: readonly WorkerCapability[];
  oauthProviders: readonly ProviderName[];
  webhookUrl: string | undefined;
}): Promise<GeneratedAgentRow> {
  const prismaPattern = patternToPrismaEnum(args.pattern);
  const capabilitiesJson: unknown = args.capabilities.map((c) => ({
    kind: c.kind,
    key: c.key,
    ...(c.title === undefined ? {} : { title: c.title }),
    ...(c.description === undefined ? {} : { description: c.description }),
  }));

  // Use the actual `createGeneratedAgent` repository helper for the create
  // branch (so we preserve any cross-cutting concerns it adds, e.g. status
  // defaults), and a plain `update` for the update branch.
  const existing = await args.db.generatedAgent.findUnique({
    where: { generationId: args.generationId },
    select: { id: true },
  });

  if (existing === null) {
    // We could call the repository helper here, but the repository helper
    // imports the singleton `prisma` directly — which would bypass the
    // injected `dbClient`. We re-implement the create path against the
    // injected client to keep tests deterministic.
    return args.db.generatedAgent.create({
      data: {
        workspaceId: args.workspaceId,
        generationId: args.generationId,
        ntnWorkerName: args.workerName,
        ntnDeployUrl: args.deployUrl,
        notionCustomAgentId: args.customAgentId,
        pattern: prismaPattern,
        description: args.description,
        sourceBlobUrl: args.sourceBlobUrl,
        avatarUrl: args.avatarUrl ?? null,
        capabilities: capabilitiesJson,
        oauthProviders: [...args.oauthProviders],
        webhookUrl: args.webhookUrl ?? null,
        status: 'active',
      },
    });
  }

  return args.db.generatedAgent.update({
    where: { id: existing.id },
    data: {
      ntnWorkerName: args.workerName,
      ntnDeployUrl: args.deployUrl,
      notionCustomAgentId: args.customAgentId,
      pattern: prismaPattern,
      description: args.description,
      sourceBlobUrl: args.sourceBlobUrl,
      avatarUrl: args.avatarUrl ?? null,
      capabilities: capabilitiesJson,
      oauthProviders: [...args.oauthProviders],
      webhookUrl: args.webhookUrl ?? null,
      status: 'active',
    },
  });
}

// Re-export the helper types for downstream callers (tests + orchestrator).
export type { WorkerCapability } from '@forge/ntn-wrapper';
