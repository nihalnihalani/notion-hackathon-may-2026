# Forge Architecture

> This document distills [`PLAN.md`](../PLAN.md) Parts II, III, V, and VIII into a single standalone reference. Where it differs from `PLAN.md`, `PLAN.md` wins.

## High-level diagram

```
┌─────────────────────────────── Notion workspace (user's) ───────────────────────────────┐
│                                                                                          │
│   ┌──────────────────────────────┐         ┌──────────────────────────────┐              │
│   │  Forge page (installed)      │         │  Generated Custom Agent      │              │
│   │  ─────────────────────────── │         │  ─────────────────────────── │              │
│   │   How it works (toggle)      │         │   Runs on Notion Workers     │              │
│   │   📋 Forge Requests DB       │         │   Wired to the workspace by  │              │
│   │   ⚡ Forge button (webhook) ─┼──┐      │   Shipper                    │              │
│   │   🧱 Build Log (live stream) │  │      │                              │              │
│   │   🤖 Forge Agents DB         │  │      └──────────────────────────────┘              │
│   │   ⚙️ Settings (toggle)        │  │                ▲                                   │
│   └──────────────────────────────┘  │                │ deploys via ntn workers deploy    │
└─────────────────────────────────────┼────────────────┼────────────────────────────────────┘
                                      │                │
                                      │  signed POST   │
                                      ▼                │
┌──────────────────────────────── Vercel ──────────────┼────────────────────────────────────┐
│                                                      │                                    │
│   apps/web (Next.js 16)                              │                                    │
│   ├─ proxy.ts   (Clerk + workspace bind)             │                                    │
│   ├─ /api/webhooks/notion-button   ───────────────┐  │                                    │
│   ├─ /api/forge/trigger                           │  │                                    │
│   ├─ /api/forge/generations/:id                   │  │                                    │
│   ├─ /api/forge/log    (internal token)           │  │                                    │
│   └─ /api/mcp          (MCP server, SSE)          │  │                                    │
│                                                   ▼  │                                    │
│   @forge/workflows  ─ Vercel Workflow DevKit DAG     │                                    │
│   ┌──────────────┐  ┌────────────┐  ┌──────────┐  ┌────────────┐                          │
│   │ Schema Smith │─▶│ Tool Coder │─▶│ Inspector│─▶│  Shipper   │──┐                       │
│   └──────────────┘  └────────────┘  └─────┬────┘  └────────────┘  │                       │
│         ▲                ▲                │ (loop on fail)         │                      │
│         │                └────────────────┘                        │                      │
│         │                                                          │                      │
│         │ models via Vercel AI Gateway                             │                      │
│         │   primary: claude-opus-4-7   fallback: gpt-5             │                      │
│         │                                                          │                      │
│         │      Vercel Sandbox (per-generation Firecracker VM)      │                      │
│         │      runs: AST safety · tsc --noEmit · ntn workers exec  │                      │
│         │                                                          │                      │
│         ▼                                                          ▼                      │
│   @forge/db  (Prisma → PlanetScale Postgres)                                              │
│   workspaces · users · generations · generation_steps · generated_agents                  │
│   prompt_cache · audit_log · usage_meter · evaluations · billing_events                   │
│                                                                                           │
└───────────────────────────────────────────────────────────────────────────────────────────┘
```

## Request flow walkthrough

The headline path: **button click → workflow → deploy**, end-to-end.

1. **User describes an agent** in the `📋 Forge Requests` DB row in the installed Forge page (e.g. "Pull my open Linear bugs every hour into a triaged summary, sorted by severity").
2. **User clicks `⚡ Forge this Agent`**. The Notion button block is wired to call a webhook at `/api/webhooks/notion-button` with the per-workspace HMAC secret.
3. **Webhook handler (Next.js API route on Vercel)**:
   - Verifies the HMAC signature against the per-workspace secret stored at install time.
   - Reads the referenced row via `ntn pages get` to capture the description text.
   - Computes `descriptionHash = sha256(workspaceId || normalize(description))`.
   - Idempotency check: looks up `Generation` rows with the same hash in the last hour. If found, returns the cached `GeneratedAgent` and skips the pipeline.
   - Otherwise inserts a `Generation` row (`status: queued`) and triggers the `forgeGeneration` Workflow DevKit run.
4. **Workflow step 1 — Schema Smith** (Claude Opus 4.7, extended thinking off):
   - Calls `ntn datasources query` to discover the workspace's DBs.
   - Returns `{pattern, inputSchema, outputSchema, requiredScopes, requiredOAuth, rationale}`.
   - Output is Zod-validated; failure to round-trip through the `j` builder triggers a retry with the error in-prompt.
   - On `pattern: null` (ambiguous), the pipeline halts and posts a clarifying Notion comment.
5. **Workflow step 2 — Tool Coder** (Claude Opus 4.7, extended thinking on, 4096-token budget):
   - Prompt prefix is cached (`cache_control: { type: 'ephemeral' }`) — Worker template + `j` reference + 8 few-shot examples (~12K tokens).
   - Emits raw TS for `src/index.ts` using `worker.tool` / `worker.sync` / `worker.webhook` and an optional `package.json` patch (deps restricted to the allowlist in `@forge/safety`).
   - Self-eval: AST parse with `@typescript-eslint/parser`. On parse failure, regenerate once.
6. **Workflow step 3 — Inspector** (no model call; pure orchestration in Vercel Sandbox):
   1. AST safety check via `@forge/safety` (blocks `process.exec`, raw `fs` writes outside `/tmp`, non-allowlisted network, `eval`, dynamic `import()`).
   2. `npm install` against the vendored dep set (no live npm).
   3. `tsc --noEmit` with the canonical `tsconfig.json`.
   4. `ntn workers deploy --dry-run` to validate against the platform without publishing.
   5. `ntn workers exec <name> --input <synthetic>` against LLM-generated synthetic input matching `inputSchema`.
   - On failure, errors are fed back to a Tool Coder retry (cap 2 total Tool Coder runs).
7. **Workflow step 4 — Shipper** (no model call):
   1. `ntn workers deploy` (final, from Sandbox) — captures deploy URL + worker ID.
   2. `ntn workers capabilities list` to enumerate tools/syncs/webhooks the Worker exposes.
   3. For each tool, wires it into a Notion Custom Agent via the Notion REST API. If REST doesn't expose Custom Agent creation, surfaces a one-click deep-link to `Notion Settings → Custom Agents`.
   4. If `requiredOAuth` is non-empty, runs `ntn oauth start <provider>` and posts the redirect URL as a callout block in the row.
   5. If the agent declares webhooks, surfaces the webhook URL via `ntn webhooks list` as a copy-to-clipboard block.
   6. Archives the generated TS to Vercel Blob **and** attaches it to the Notion DB row via `ntn files create`.
   7. Emits `billing_events.deploy_success` to PlanetScale + a PostHog event, and emails the user via Resend.
8. **Finalize step** — `Generation.status = succeeded`, `completedAt`, `agentId` set; audit log row written.
9. **Throughout** — every step appends to the `🧱 Build Log` block via `/api/forge/log` (server-internal token), rate-limited to 1 update / 500ms / generation.

**Cancellation:** A `Cancel` button on the Forge page fires `/api/forge/cancel/:id` → Workflow DevKit native cancellation → in-flight Sandbox processes killed by tag.

## Sub-agent responsibilities

> See [`PLAN.md` Part IV](../PLAN.md#part-iv--sub-agent-specifications) for the canonical spec.

| Sub-agent | Job | Model | Key invariant |
|---|---|---|---|
| **Schema Smith** | English + workspace context → `{pattern, inputSchema, outputSchema, requiredScopes, requiredOAuth}` | Claude Opus 4.7 (extended thinking off) | Output must round-trip through the `j` builder; ambiguity returns `pattern: null` + clarification |
| **Tool Coder** | Schema Smith output + description → `src/index.ts` | Claude Opus 4.7 (extended thinking on, 4K budget) | AST-parses cleanly; `package.json` deps are on the allowlist |
| **Inspector** | Prove the generated code compiles and runs | No model — sandboxed orchestration | AST safety → `tsc` → `ntn workers deploy --dry-run` → `ntn workers exec` against synthetic input |
| **Shipper** | Promote staging deploy + wire Custom Agent + archive + notify | No model — pure orchestration | Idempotent on retries; failures surface in the Build Log, never crash the workflow |
| **Orchestrator (Manager)** | Sequence the above with durable retries + cancellation + idempotency | n/a | One in-flight generation per `descriptionHash` per workspace; concurrency limit 3 per workspace |

Every step writes a `GenerationStep` row with `attempt`, `status`, `modelUsed`, `promptTokens`, `cacheReadTokens`, `costUsd`, `inputJson`, `outputJson`, `errorJson`, `latencyMs`.

## Data flow (PlanetScale schema overview)

Full Prisma schema lives in [`packages/db/prisma/schema.prisma`](../packages/db/prisma/schema.prisma) and is documented in [`PLAN.md` Part V](../PLAN.md#part-v--data-model-planetscale).

```
Workspace ─┬─< User ─< Generation ─< GenerationStep
           │                  │
           │                  └──▶ GeneratedAgent (1:1 on success)
           │
           ├─< GeneratedAgent
           ├─< UsageMeter (daily aggregates)
           └─< AuditLog (append-only)

PromptCache  (descriptionHash + embedding → cached Schema/Tool outputs)
Evaluation   (per-agent Promptfoo run results)
```

Lifecycle of one generation in the DB:

| Step | Table writes |
|---|---|
| Trigger received | `Generation` (`status: queued`), `AuditLog` (`forge.trigger`) |
| Workflow starts | `Generation.status: running` |
| Each sub-agent runs | `GenerationStep` (insert with `status: running`, then update with `succeeded` / `failed` / `retrying`) |
| Tool Coder retry | New `GenerationStep` row with `attempt: 2` |
| Shipper deploys | `GeneratedAgent` insert, `Generation.agentId` set, `AuditLog` (`agent.deployed`) |
| Finalize | `Generation.status: succeeded`, `Generation.completedAt`, `UsageMeter` upsert for today |
| Idempotent re-run within 1h | Lookup hit on `(workspaceId, descriptionHash)` → returns existing `GeneratedAgent` without any new rows |

**Audit log is append-only by policy.** No `UPDATE` or `DELETE` is permitted at the application level; the table has a DB-level constraint enforcing this post-hackathon.

**Migration policy:** every PR touching `schema.prisma` triggers a PlanetScale branch + `prisma migrate diff`. Reviewed before merge. Production migrations are deferred to scheduled deploy windows.

## Cross-references

- HTTP API surface: [`docs/api.md`](api.md) and [`PLAN.md` Part VI](../PLAN.md#part-vi--api-design)
- `ntn` CLI commands Forge uses: [`PLAN.md` Part III](../PLAN.md#part-iii--ntn-cli-deep-dive)
- Code-gen safety model: [`PLAN.md` Part IX](../PLAN.md#part-ix--code-gen-safety) and [`SECURITY.md`](../SECURITY.md)
- Observability and auth: [`PLAN.md` Part X](../PLAN.md#part-x--observability--security)
- Notion-as-UI page design: [`PLAN.md` Part VII](../PLAN.md#part-vii--notion-as-ui-page-design)
