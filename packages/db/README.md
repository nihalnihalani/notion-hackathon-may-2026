# @forge/db

The Prisma schema and singleton client for Forge's PlanetScale (Postgres) source-of-truth database. Tables: `Workspace`, `User`, `Generation`, `GenerationStep`, `GeneratedAgent`, `AuditLog`, `UsageMeter`, `PromptCache`, `Evaluation`. Exports a singleton `prisma` client (Node) plus a per-request Edge factory and typed query helpers.

> Source of truth for the schema: `PLAN.md` Part V. Any change to `prisma/schema.prisma` must be reflected there first.

## Runtime split

- `@forge/db` — Node runtime. Imports the binary Prisma engine over a `pg` pool. Use in route handlers with `export const runtime = "nodejs"`, Vercel Workflow tasks, scripts, workers.
- `@forge/db/edge` — Edge runtime. Uses `@prisma/adapter-pg` (Neon-compatible HTTP/WS), so it runs in V8 isolates. Use in route handlers with `export const runtime = "edge"`. Returns a fresh client per request — do **not** cache on `globalThis`.

Importing the Node entry from an Edge bundle will fail at build time. That's intentional — it surfaces accidental misuse before deploy.

## Public API surface

### Runtime clients

- `prisma` — Node singleton, hot-reload-safe.
- `disconnect()` — graceful pool shutdown for scripts and workers.
- `createEdgePrisma({ connectionString? })` (from `@forge/db/edge`) — per-request Edge client factory.

### Pure helpers

- `normalize(description)` — trim → lowercase → collapse whitespace.
- `descriptionHash(workspaceId, description)` — SHA-256 over `workspaceId || normalize(description)`. Edge-safe (Web Crypto). Returns 64-char lowercase hex.

### Audit (append-only)

- `recordAuditEvent(event)` — single insert; never returns the row. See `src/audit.ts` for PII rules.

### Usage meter

- `recordUsage(workspaceId, fields, at?)` — upsert + atomic increment on today's UTC row.
- `getUsageSince(workspaceId, since)` — summed aggregate.

### Repositories (typed, no raw SQL)

- `workspaces`: `upsertWorkspace`, `findWorkspaceByNotionId`, `getForgePageIds`
- `generations`: `createGeneration`, `updateGenerationStatus`, `findRecentByHash` (idempotency lookup), `getGenerationWithSteps`
- `generation-steps`: `recordStep` (start | finish), `listStepsForGeneration`
- `generated-agents`: `createGeneratedAgent`, `findActiveAgentsByWorkspace`, `markAgentStatus`, `softDeleteAgent`
- `prompt-cache`: `lookupByHash`, `lookupByEmbedding` (bounded in-process cosine scan over Float32-encoded cache embeddings)

### Types

Re-exports of every Prisma model + enum, plus `AuditEvent`, `AuditEventInput`, `AuditEventBase`, `UsageMeterFields`, `UsageMeterAggregate`.

## Scripts

- `pnpm db:generate` — `prisma generate`
- `pnpm db:migrate` — `prisma migrate dev` (local dev; creates migrations)
- `pnpm db:deploy` — `prisma migrate deploy` (production; applies already-committed migrations)
- `pnpm db:studio` — `prisma studio`
- `pnpm test` — vitest run (pure helpers + type-level audit union tests)

CI deploys call `tsx packages/db/scripts/migrate-deploy.ts`, which is a guarded wrapper around `prisma migrate deploy`.
