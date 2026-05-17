# Forge — Notion Custom Agent Studio
## Production Plan

> **Status:** Primary pick per [DEBATE.md](DEBATE.md). Production target — **no demo mode, no seed data, no mocks, no bypass paths**. Real auth from minute one, real DB from minute one, real OAuth into real Notion workspaces.

## North Star

One English sentence describes an agent → a working, deployed, wired-up Notion Custom Agent appears in the user's workspace in **≤120 seconds**, including AST safety checks, `tsc --noEmit`, and a live `ntn workers exec` against synthetic input — all visible in a Notion page that *is* the studio.

## Non-Goals (v1, locked)

- ❌ No mobile / native — pure web + Notion-as-UI
- ❌ No custom GUI editor for generated code — Notion page is the only surface
- ❌ No agent marketplace UI in v1 (DB schema is ready; UI deferred)
- ❌ No multi-workspace switching within a session
- ❌ No tool patterns outside the 5 supported families (see §4)
- ❌ No on-the-fly model fine-tuning
- ❌ No support for non-Custom-Agent destinations (no Slack-as-target, etc.)

## Definition of Done

- [ ] **Auth:** Clerk-issued JWT, Notion OAuth flow, workspace bind, refresh-on-expire — no demo-skip path
- [ ] **Install:** On first sign-in, Notion API creates the Forge page + Forge Requests DB in user's workspace
- [ ] **Trigger:** User types into the DB row → clicks ⚡ Forge → Notion webhook fires Vercel function
- [ ] **Pipeline:** Vercel Workflow DevKit runs Schema Smith → Tool Coder → Inspector → Shipper, durable + retried + cancellable
- [ ] **Safety:** AST safety check + `tsc --noEmit` + `ntn workers exec` against synthetic input — failure paths surface in the Notion log, not crashes
- [ ] **Deploy:** `ntn workers deploy` from Vercel Sandbox to user's workspace; Custom Agent wired via Notion API
- [ ] **Persistence:** Every step recorded in PlanetScale; audit log immutable; same-prompt re-runs are idempotent
- [ ] **Live log:** Notion page Build Log block updates at ≤500ms latency without 429s
- [ ] **Observability:** Sentry on error path, PostHog on funnel, Vercel Analytics on the dashboard, Forge "Operations" Notion DB for self-monitoring
- [ ] **Testing:** Vitest ≥80% on core logic, Playwright on the install→trigger→deploy E2E, prompt evals (Promptfoo) for each sub-agent
- [ ] **CI/CD:** GitHub Actions runs tests + Vercel preview deploy on PR; merge to main = prod deploy + PlanetScale migration
- [ ] **Submission:** Public repo, MIT license, 1-min Loom, Cerebral Valley form completed

---

# Part I — Agent Planning Team

Ten planning personas. Each owns a section. Devil's Advocate has veto power on every decision and is quoted inline.

| # | Persona | One-line owner statement |
|---|---|---|
| 1 | **The Architect** | I draw the system. I pick the seams. I keep the blast radius small. |
| 2 | **The AI Engineer** | I own every prompt, every model choice, every eval, every retry. |
| 3 | **The Backend Engineer** | I own the Vercel endpoints, the Workflow DAG, idempotency, queue behavior. |
| 4 | **The Platform Engineer** | I own everything that touches the `ntn` CLI and the Notion API. Heavy CLI specialist. |
| 5 | **The Frontend Engineer** | I own Notion-as-UI and the optional Vercel dashboard. |
| 6 | **The Data Engineer** | I own PlanetScale schema, migrations, queries, audit log. |
| 7 | **The Security Engineer** | I own auth, code-gen safety, OAuth, secrets, sandbox limits. |
| 8 | **The DevOps Engineer** | I own CI/CD, observability, env mgmt, billing meter. |
| 9 | **The Integrations Engineer** | I own first-party connectors for generated agents (GitHub, Linear, Stripe, Slack, Google). |
| 10 | **The Devil's Advocate** | I will kill every idea twice and you will have to defend it. I am brutal. |
| 11 | **The Demo Director** | I own the pitch, validation pics, judge Q&A choreography. |

---

# Part II — Tech Stack with Sponsor Mapping

> Goal: integrate every hackathon sponsor in a way that's load-bearing for the product, not a logo on a slide.

| Sponsor / Tool | Role in Forge | Why | Where in code |
|---|---|---|---|
| **Notion Developer Platform** | The host runtime for generated Custom Agents; Forge's UI surface; OAuth provider | The whole point | `notion-client/`, `ntn-wrapper/`, `studio-page/` |
| **Anthropic Claude** (Opus 4.7) | Primary model for all 4 sub-agents | Strongest at structured TS code-gen + reasoning chains | `agents/*` via Vercel AI Gateway |
| **Anthropic prompt caching** | Cache the worker template + `j` schema reference (~8K tokens) across every Tool Coder call | ≥90% cost + latency reduction per call | `agents/tool-coder.ts` w/ `cache_control: { type: 'ephemeral' }` |
| **Anthropic extended thinking** | Tool Coder uses extended thinking for the code-gen step only | Better TS correctness on first pass | Same |
| **OpenAI** (GPT-5) | Fallback model for Schema Smith via Vercel AI Gateway routing; embeddings (text-embedding-3-large) for prompt similarity cache | Redundancy + cheaper embeddings | `agents/schema-smith.ts`, `cache/embeddings.ts` |
| **Vercel** | Hosting (Next.js 16 dashboard + API routes); AI Gateway (multi-model routing + cost tracking); Workflow DevKit (durable orchestrator); Sandbox (runs `tsc` + `ntn workers exec`); Blob (archive generated TS); Edge Config (feature flags); Analytics + Speed Insights | Native end-to-end Vercel stack maxes sponsor credits + minimizes glue | `vercel.json`, `next.config.ts`, `apps/web/`, `workflows/forge.ts`, `lib/sandbox.ts` |
| **PlanetScale** (Postgres) | Source of truth: workspaces, users, generations, generation_steps, generated_agents, audit_log, usage_meter, prompt_cache, evaluations, billing_events | Strong consistency + branching for migrations + sponsor credits | `prisma/schema.prisma`, `db/` |
| **MiniMax** | Voice-to-text "describe an agent by voice" alt-input + image gen for agent avatars saved on each generated agent | Real multimodal use, sponsor logo on real surface | `multimodal/voice.ts`, `multimodal/avatar.ts` |
| **Clerk** | Auth (Notion OAuth proxy + JWT for Vercel → Notion handshake) | Fastest path to production auth | `lib/auth.ts`, middleware |
| **Inngest** *(backup if Vercel WDK falls over)* | Durable workflow w/ retries, fan-out, cancellation | Battle-tested pivot if WDK has rough edges | `inngest/forge.ts` (built but not wired by default) |
| **Upstash Redis** | Rate limiter (per user / per workspace) + ephemeral job state | Subsecond rate-limit checks at the edge | `lib/ratelimit.ts` |
| **Sentry** | Error tracking on Vercel + Sandbox + studio runs | Production triage | `sentry.client.config.ts`, `sentry.server.config.ts` |
| **PostHog** | Funnel: install → first prompt → first deploy → re-deploy; feature flags | Product analytics + judge-validation funnel | `lib/posthog.ts` |
| **Resend** | Transactional email: deploy success, weekly Forge digest, billing receipts | Production-grade email | `lib/email.ts` |
| **shadcn/ui + Tailwind** | Vercel dashboard primitives (settings, history, prompt cache stats) | Minimal custom UI, fast iteration | `apps/web/components/ui/` |
| **GitHub Actions** | CI: lint + typecheck + test + preview deploy on PR; prod deploy + DB migrate on merge | Standard CI/CD | `.github/workflows/*.yml` |
| **Promptfoo** | Eval harness for each sub-agent (golden inputs → expected outputs) | Prevents prompt regressions | `evals/*` |
| **Playwright** | E2E test: install → button click → deployed agent runs | Production-grade verification | `e2e/forge-happy-path.spec.ts` |

### Why this stack composition

- **Single hosting plane (Vercel)** keeps DX tight + maxes Vercel credits.
- **Vercel AI Gateway** = multi-model failover with one API surface; no per-provider wiring.
- **PlanetScale** = production-grade Postgres with safe branching for migrations.
- **Notion-as-UI** for the studio + Next.js dashboard for power-user views (settings, history, evals) — *not* required for v1 but ready for v1.5.

---

# Part III — NTN CLI Deep-Dive

> The Platform Engineer's section. Forge uses **most of the `ntn` CLI command surface**. This is the showcase of CLI capabilities.

| `ntn` command | What Forge uses it for | Where it lives | Notes |
|---|---|---|---|
| `ntn login` | Initial dev setup; documented for users in onboarding | README + `scripts/setup.sh` | OAuth in browser → keychain |
| `ntn workers new <name>` | Scaffolds the *generated* Worker project before Tool Coder writes files | `lib/ntn-wrapper.ts: scaffoldWorker()` | Output dir is per-generation in `/tmp/forge/{generationId}` |
| `ntn workers deploy` | **Shipper agent runs this** to deploy generated Worker to user's workspace | `agents/shipper.ts` via Vercel Sandbox | Captures deploy URL from stdout, parses worker ID |
| `ntn workers exec <name> --input <json>` | **Inspector agent runs this** to validate the generated Worker actually runs end-to-end on synthetic input | `agents/inspector.ts` via Vercel Sandbox | Stream-parses stdout/stderr; treats non-zero exit as test failure |
| `ntn workers list` / `get <name>` | Surface "all my Forge-generated agents" view in Notion DB + dashboard | `lib/registry.ts` | Polled hourly to reconcile our DB with platform state |
| `ntn workers delete <name>` | "Retract this agent" button in Notion DB | `lib/registry.ts: deleteAgent()` | Soft-deletes our DB record + hard-deletes via CLI |
| `ntn workers env set/list/unset/pull/push` | Per-generated-agent secret management (e.g., the GitHub PAT for a GitHub-reading agent) | `agents/shipper.ts: setAgentSecrets()` | Read from PlanetScale; never logged to Sentry |
| `ntn workers capabilities list` | Introspect what tools/syncs/webhooks a deployed Worker exposes; used for the Notion-side Custom Agent wiring step | `agents/shipper.ts: discoverCapabilities()` | Required because Custom Agent wire-up needs the tool keys |
| `ntn workers runs list <name>` | "Run history" tab inside the Notion DB row for each generated agent | `lib/registry.ts: getRunHistory()` | Cached 60s |
| `ntn workers runs logs <runId>` | "Show me the last run" deep-link from the Notion DB row | Same | Limitation: logs are post-execution, not streaming |
| `ntn workers sync trigger <name>` | "Trigger now" button for sync-source agents | `lib/registry.ts: triggerSync()` | Surfaces last-run status |
| `ntn workers sync pause/resume <name>` | "Pause this agent" toggle | Same | Idempotent |
| `ntn workers sync state get/reset <name>` | Recovery UI for cursor corruption (rare but real per RESEARCH.md sharp edges) | `lib/registry.ts: resetSync()` | Confirms with user via Notion comment before resetting |
| `ntn oauth start <provider>` | Onboarding flow for generated agents that need third-party OAuth (GitHub, Linear, etc.) | `agents/shipper.ts: bootstrapProviderOAuth()` | Solves the chicken-egg per RESEARCH.md |
| `ntn oauth token <provider>` | Read the OAuth token to seed the generated Worker's env | Same | Token is never sent to client |
| `ntn oauth show-redirect-url <provider>` | Surface the URL to the user when manually configuring an OAuth app on the provider side | Same | Shown as a callout block in the generated agent's Notion DB row |
| `ntn webhooks list` | Get the webhook URL of a newly-deployed Worker, for showing in the generated-agent DB row + for the user to paste into the external provider | `agents/shipper.ts: wireWebhook()` | Auto-extracted; surfaced as a copy-to-clipboard block |
| `ntn api <endpoint> [--data]` | Generic Notion API calls inside the studio when the typed SDK is overkill (rare) | `lib/notion.ts: rawApi()` | Last-resort path; covered by tests |
| `ntn datasources query <id>` | Schema-aware DB queries for "what existing data sources are in this workspace?" (powers the Schema Smith context) | `agents/schema-smith.ts: discoverContext()` | Caches per-workspace for 5min |
| `ntn datasources resolve <id>` | Resolve a relation/foreign-key when generating multi-table agents | Same | |
| `ntn pages create/update/trash` | **Installs the Forge page** + Forge Requests DB in user's workspace on first auth; also updates the Build Log block during runs | `installer/install-forge-page.ts`, `lib/build-log.ts` | Idempotent: skips create if page exists |
| `ntn pages get <id>` | Reads the current state of the Forge page (e.g., what the user typed) | `lib/notion.ts: getForgePageState()` | Webhook payload usually has it but this is the verifier |
| `ntn files create/get/list` | Attach the generated TS file to the generated-agent DB row as a downloadable artifact | `agents/shipper.ts: archiveSource()` | Also pushed to Vercel Blob for redundancy |
| `ntn workers tui` | Documented escape-hatch for users (not used in code) | README troubleshooting section | |
| `ntn runs list/logs` | Aggregate run history across all generated agents for the dashboard | `lib/dashboard.ts: aggregateRuns()` | |
| `ntn doctor` | Health check run during `scripts/setup.sh` and surfaced in dashboard | `scripts/setup.sh`, `lib/diagnostics.ts` | |
| `ntn update` | Documented in README; CI ensures we test against the latest CLI version | `.github/workflows/test.yml` | |

**Why we shell out to `ntn` (not the raw Notion API for everything):**
- `ntn workers deploy` orchestrates packaging + upload + slot reservation atomically — no equivalent raw call
- `ntn workers exec` runs against the actual Worker runtime — the only way to validate the generated code in the real environment
- `ntn oauth start/token` handles the platform-managed OAuth flows we'd otherwise reimplement
- `ntn` is what users will see in docs; using it inside Forge means we eat our own dog food
- CLI version is the source of truth — tests pin to a known CLI version (`NTN_VERSION` env var) and CI updates it weekly via Dependabot

---

# Part IV — Sub-Agent Specifications

> The AI Engineer's section. Each sub-agent is a focused, prompt-cacheable call with a structured output. The orchestrator is dumb — it just runs them in order with retries.

### Common configuration

- **Primary model:** `claude-opus-4-7` via Vercel AI Gateway
- **Fallback model:** `gpt-5` (Vercel AI Gateway auto-fails over on Anthropic 5xx after 1 retry)
- **Prompt caching:** the Worker template + `j` schema reference + Notion API reference (≈12K tokens) is cached on every Tool Coder + Inspector call
- **Retries:** 2 retries per sub-agent (Inngest/WDK durable retries); after 2 failures the run is marked `failed` and surfaced in the Notion Build Log
- **Timeouts:** 90s per sub-agent (Vercel Workflow step timeout)
- **Tracing:** every step emits a structured trace event to PostHog + a row to `generation_steps`

### 4.1 Schema Smith

**Job:** From English description, propose the `j` schema for tool inputs + output type.

- **Model:** Opus 4.7 (extended thinking off — schema generation is a structured-output task, not a reasoning one)
- **Input:** user description + workspace context (databases available via `ntn datasources query`)
- **Output (Zod-validated):**
  ```ts
  {
    pattern: 'database-query' | 'webhook-trigger' | 'sync-source' | 'external-api-call' | 'multi-step',
    inputSchema: JSchemaSpec,   // restricted subset of j builder ops
    outputSchema: JSchemaSpec,
    requiredScopes: NotionScope[],
    requiredOAuth: ProviderName[],
    rationale: string,           // shown in Notion Build Log
  }
  ```
- **Self-eval:** schema must round-trip through the `j` builder without throwing; else retry with the error in prompt
- **Devil's Advocate:** *"What if the user asks for something that doesn't fit a pattern?"* → Schema Smith returns `pattern: null` + a clarification question in `rationale`; pipeline halts with a comment back to the Notion page

### 4.2 Tool Coder

**Job:** Given Schema Smith output + the description, write a single `src/index.ts` for the Worker using `worker.tool()`, `worker.sync()`, or `worker.webhook()` as appropriate.

- **Model:** Opus 4.7 with **extended thinking on** (budget 4096 tokens for thinking, output limited to 4096)
- **Prompt cache:** the cached prefix contains the Worker template + `j` reference + 8 few-shot examples covering all 5 patterns
- **Output:** raw TS source + a `package.json` patch (if extra deps needed; restricted to allowlist)
- **Self-eval:** AST parse with `@typescript-eslint/parser`; if parse fails, regenerate once
- **Devil's Advocate:** *"Claude hallucinates the API."* → Mitigation: prompt cache contains the **exact** SDK signatures from `@notionhq/client` + `@notion/workers-sdk`; the few-shot examples cover the edge cases. We track hallucination rate as a PostHog event.

### 4.3 Inspector

**Job:** Prove the generated code compiles AND runs against synthetic input.

- **No model call** — pure orchestration of `tsc` + `ntn workers exec` in a Vercel Sandbox
- **Steps:**
  1. AST safety check (`SecurityScanner` — see §IX): block `process.exec`, `fs.writeFileSync` outside `/tmp`, network to non-allowlisted hosts
  2. `npm install` (vendored deps only — no live npm during Inspector)
  3. `tsc --noEmit` — capture errors
  4. `ntn workers deploy --dry-run` (validates against platform without publishing)
  5. `ntn workers exec <name> --input <synthetic>` — uses LLM-generated synthetic input matching the inputSchema
- **Output:** `{pass: bool, stage: 'parse'|'tsc'|'dryrun'|'exec', errors: string[], output?: any}`
- **On failure:** errors fed back to Tool Coder for 1 retry (cap 2 total Tool Coder runs per generation)
- **Devil's Advocate:** *"You can't actually `exec` without deploying."* → Confirmed via RESEARCH.md: `ntn workers exec` requires deploy. We use `--dry-run` for the static check; for the live exec we deploy to a per-generation staging slot, exec, then promote-or-delete in Shipper.

### 4.4 Shipper

**Job:** Promote the staging deploy to the user's workspace + wire it into a Custom Agent + write the result back to Notion.

- **No model call** — pure orchestration
- **Steps:**
  1. Promote staging Worker via `ntn workers deploy` (final)
  2. Discover capabilities via `ntn workers capabilities list`
  3. For each tool: create/wire it into a Notion Custom Agent via Notion REST API
  4. If the generated agent needs OAuth to a provider: run `ntn oauth start <provider>` and surface the redirect URL in the Notion Build Log
  5. If the generated agent declares webhooks: surface webhook URL via `ntn webhooks list` for the user to paste into the external provider
  6. Archive the generated TS file to Vercel Blob + `ntn files create` (attached to Notion DB row)
  7. Emit `billing_events.deploy_success` to PlanetScale and PostHog
  8. Email the user via Resend with the deploy summary
- **Output:** `{customAgentId, deployUrl, webhookUrl?, oauthRedirectUrl?, artifactBlobUrl}`
- **Devil's Advocate:** *"Custom Agent wiring via REST API isn't documented."* → If REST API doesn't expose Custom Agent creation, fall back to surfacing a deep-link the user clicks to wire it manually in their Notion Settings → Custom Agents UI. That's 1 click. Acceptable.

### 4.5 Orchestrator (the Manager)

**Job:** Run Schema Smith → Tool Coder → Inspector → Shipper as a Vercel Workflow with durable state.

- Each step is a `workflow.step()` call with retry config
- State persisted between steps so a Vercel rollover doesn't lose progress
- Cancellation hook: user clicks "Cancel" button in Notion → webhook fires → workflow cancelled mid-step
- Concurrency limit: 3 in-flight generations per user; new requests queue
- Idempotency key: hash of (workspace_id, normalized_description) — re-running the same prompt within 1h returns the cached result

---

# Part V — Data Model (PlanetScale)

> Data Engineer's section. Prisma schema (Postgres on PlanetScale).

```prisma
// prisma/schema.prisma — Postgres on PlanetScale

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

generator client {
  provider = "prisma-client-js"
}

model Workspace {
  id                String    @id @default(cuid())
  notionWorkspaceId String    @unique  // from Notion OAuth
  name              String
  ownerUserId       String
  installedAt       DateTime  @default(now())
  forgePageId       String?   // the installed Forge page in their workspace
  forgeDbId         String?   // the installed Forge Requests DB
  users             User[]
  generations       Generation[]
  generatedAgents   GeneratedAgent[]
  usage             UsageMeter[]
}

model User {
  id              String    @id @default(cuid())
  clerkId         String    @unique
  email           String    @unique
  workspaceId     String
  workspace       Workspace @relation(fields: [workspaceId], references: [id])
  generations     Generation[]
  createdAt       DateTime  @default(now())
}

model Generation {
  id              String    @id @default(cuid())
  workspaceId     String
  workspace       Workspace @relation(fields: [workspaceId], references: [id])
  userId          String
  user            User      @relation(fields: [userId], references: [id])
  notionRowId     String    // Forge Requests DB row in Notion
  description     String    @db.Text
  descriptionHash String    @db.VarChar(64)  // for idempotency
  status          GenerationStatus
  pattern         AgentPattern?
  agentId         String?   // GeneratedAgent.id once shipped
  startedAt       DateTime  @default(now())
  completedAt     DateTime?
  totalLatencyMs  Int?
  totalCostUsd    Decimal?  @db.Decimal(10, 6)
  steps           GenerationStep[]
  @@index([workspaceId, descriptionHash])
  @@index([status, startedAt])
}

model GenerationStep {
  id              String    @id @default(cuid())
  generationId    String
  generation      Generation @relation(fields: [generationId], references: [id], onDelete: Cascade)
  agent           AgentName  // schema_smith | tool_coder | inspector | shipper
  attempt         Int
  status          StepStatus
  modelUsed       String?    // claude-opus-4-7 | gpt-5 | n/a
  promptTokens    Int?
  completionTokens Int?
  cacheReadTokens Int?
  cacheWriteTokens Int?
  costUsd         Decimal?  @db.Decimal(10, 6)
  inputJson       Json
  outputJson      Json?
  errorJson       Json?
  latencyMs       Int?
  startedAt       DateTime  @default(now())
  completedAt     DateTime?
}

model GeneratedAgent {
  id                String    @id @default(cuid())
  workspaceId       String
  workspace         Workspace @relation(fields: [workspaceId], references: [id])
  generationId      String    @unique
  ntnWorkerName     String    // the slug used in `ntn workers ...`
  ntnDeployUrl      String?
  notionCustomAgentId String?
  pattern           AgentPattern
  description       String    @db.Text
  sourceBlobUrl     String    // Vercel Blob URL for generated TS
  avatarUrl         String?   // MiniMax-generated image
  capabilities      Json      // [{ kind, key, title }]
  oauthProviders    String[]  // ["github", "linear"]
  webhookUrl        String?
  status            AgentStatus  // active | paused | retracted
  createdAt         DateTime  @default(now())
  lastInvokedAt     DateTime?
  totalInvocations  Int       @default(0)
  @@index([workspaceId, status])
}

model PromptCache {
  id              String    @id @default(cuid())
  descriptionHash String    @db.VarChar(64)
  embedding       Bytes     // pgvector-compatible
  schemaSmithOutput Json
  toolCoderOutput String    @db.Text
  hitCount        Int       @default(0)
  createdAt       DateTime  @default(now())
  expiresAt       DateTime
  @@index([descriptionHash])
}

model AuditLog {
  id              String    @id @default(cuid())
  workspaceId     String
  userId          String?
  action          String    // "agent.deployed" | "agent.deleted" | "oauth.granted" | ...
  resourceType    String
  resourceId      String
  metadata        Json
  ipAddress       String?
  userAgent       String?
  createdAt       DateTime  @default(now())
  @@index([workspaceId, action, createdAt])
}

model UsageMeter {
  id              String    @id @default(cuid())
  workspaceId     String
  workspace       Workspace @relation(fields: [workspaceId], references: [id])
  date            DateTime  @db.Date
  generationsCount Int      @default(0)
  deploysCount    Int       @default(0)
  invocationsCount Int      @default(0)
  totalLlmCostUsd Decimal   @default(0) @db.Decimal(10, 4)
  totalSandboxSeconds Int   @default(0)
  @@unique([workspaceId, date])
}

model Evaluation {
  id              String    @id @default(cuid())
  agent           AgentName
  goldenInputHash String    @db.VarChar(64)
  modelUsed       String
  pass            Boolean
  diffJson        Json?
  runAt           DateTime  @default(now())
  @@index([agent, runAt])
}

enum GenerationStatus { queued running succeeded failed cancelled }
enum StepStatus       { running succeeded failed retrying }
enum AgentPattern     { database_query webhook_trigger sync_source external_api_call multi_step }
enum AgentStatus      { active paused retracted }
enum AgentName        { schema_smith tool_coder inspector shipper }
```

**Migration policy:** Every PR that touches `schema.prisma` triggers a PlanetScale branch + `prisma migrate diff`. Reviewed before merge. Production migrations are deferred to scheduled deploy windows (post-hackathon).

---

# Part VI — API Design

> Backend Engineer's section.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/auth/notion/callback` | none (handled by Clerk) | OAuth completion — creates Workspace + User rows; calls installer to create Forge page |
| POST | `/api/forge/trigger` | Clerk JWT + workspace bind | Validates input, idempotency-checks via descriptionHash, enqueues Workflow |
| GET | `/api/forge/generations/:id` | JWT | SSR'd generation status page (used by the dashboard) |
| POST | `/api/forge/log` *(internal)* | Vercel internal token | Append a line to the Notion Build Log; called by orchestrator |
| POST | `/api/forge/cancel/:id` | JWT | Best-effort cancel of in-flight Workflow |
| POST | `/api/webhooks/notion-button` | Notion signature | Fires when user clicks ⚡ Forge button in Notion |
| POST | `/api/webhooks/notion-page-edit` | Notion signature | Catches description edits to a queued request (debounced) |
| GET | `/api/agents` | JWT | List user's generated agents (powers dashboard table) |
| POST | `/api/agents/:id/pause` | JWT | `ntn workers sync pause` |
| POST | `/api/agents/:id/resume` | JWT | `ntn workers sync resume` |
| DELETE | `/api/agents/:id` | JWT | `ntn workers delete` + soft-delete in DB |
| GET | `/api/mcp` *(SSE)* | API key | Exposes Forge as an MCP server so Claude Code / Cursor can drive it |
| POST | `/api/billing/usage` | Vercel internal | Stripe meter pushes for paid tier (future) |
| GET | `/api/healthz` | none | Liveness + dependency health |

### Notion Button → Webhook handshake

1. Notion button block has its action set to "Call webhook" pointing at `/api/webhooks/notion-button`
2. On click, Notion fires HTTP POST with `{ pageId, blockId, userId, workspaceId }` + signed header
3. Vercel handler:
   - Verifies signature against the per-workspace secret stored at install
   - Reads the Forge Requests DB row referenced by `pageId` to get the description
   - Hashes the description, checks PlanetScale for an existing successful generation in last 1h → returns idempotent result
   - Else writes a `Generation` row and emits `forge/generation.requested` to Workflow

### Idempotency

- `descriptionHash = sha256(workspaceId || normalize(description))`
- Same hash within 1h returns the cached `GeneratedAgent` instead of running
- "Re-forge anyway" button bypasses cache (sets `force: true` query)

---

# Part VII — Notion-as-UI Page Design

> Frontend Engineer's section. The Forge page in the user's workspace is installed by the installer (see §III, `ntn pages create`).

### Page blocks (top to bottom)

```
┌───────────────────────────────────────────────────────────────┐
│ # Forge — your agents, in plain English                       │
├───────────────────────────────────────────────────────────────┤
│ ▼ How it works                                                 │
│   1. Add a row to "Forge Requests" below                       │
│   2. Describe the agent you want in plain English              │
│   3. Click ⚡ Forge this Agent                                  │
│   4. Watch the Build Log; you'll have a Custom Agent in ~90s   │
├───────────────────────────────────────────────────────────────┤
│ 📋 Forge Requests (database, table view)                       │
│  Columns: Description (title), Status (select), Pattern,       │
│           Deployed Agent (relation→Forge Agents), Created      │
│           by, Created at, Cost, Build Log (relation)           │
├───────────────────────────────────────────────────────────────┤
│ [⚡ Forge this Agent]  (button block, calls webhook)           │
├───────────────────────────────────────────────────────────────┤
│ 🧱 Build Log (synced block, updated live)                      │
│  ▸ 12:01:03  Schema Smith: pattern = database-query ✅          │
│  ▸ 12:01:14  Tool Coder: 87 lines generated, AST ok ✅         │
│  ▸ 12:01:29  Inspector: tsc passed, exec returned ok ✅        │
│  ▸ 12:01:41  Shipper: deployed → linear-bug-triager.notion... │
├───────────────────────────────────────────────────────────────┤
│ 🤖 Forge Agents (database, gallery view)                       │
│  Cards: agent avatar, name, description, status, last run     │
├───────────────────────────────────────────────────────────────┤
│ ⚙️ Settings (toggle)                                            │
│   - Default model (Claude Opus 4.7 / GPT-5 / Auto)             │
│   - OAuth providers connected                                  │
│   - API key (for MCP access)                                   │
└───────────────────────────────────────────────────────────────┘
```

### Installation flow (idempotent)

`installer/install-forge-page.ts`:
1. Call Notion API to search for existing page named "Forge" in workspace
2. If exists: reconcile schema (add missing columns, don't drop) → store IDs in `Workspace`
3. Else: create page + 2 databases + button + Build Log block; store IDs

### Build Log streaming

- Orchestrator emits structured events: `{step, status, message, timestamp}`
- `/api/forge/log` appends a paragraph block via Notion API
- Rate-limited to 1 update per 500ms per generation (well under Notion's 3 req/sec)
- On generation complete: the row in Forge Requests gets its Status updated atomically + Deployed Agent relation populated

### Vercel dashboard (optional but ready)

Next.js 16 App Router @ `apps/web/`:
- `/` — overview: total generations, success rate, avg latency, top patterns
- `/agents` — table of all generated agents with status + actions
- `/generations/:id` — same as the Notion build log but with raw step JSON for debugging
- `/settings` — model defaults, API keys, billing
- `/evals` — Promptfoo eval results trending
- Auth: Clerk
- Uses shadcn/ui components + Tailwind

---

# Part VIII — Workflow Orchestration (Vercel Workflow DevKit)

```ts
// workflows/forge.ts (illustrative)

import { workflow, step } from '@vercel/workflow';
import { schemaSmith, toolCoder, inspector, shipper } from '@/agents';
import { db } from '@/db';
import { logToNotion } from '@/lib/build-log';

export const forgeGeneration = workflow({
  name: 'forge-generation',
  retries: { maxAttempts: 0 }, // inner steps own their retries
  concurrency: { key: ({ workspaceId }) => workspaceId, limit: 3 },
})(async ({ generationId, workspaceId, description }) => {
  await logToNotion(generationId, '🚀 Starting...');

  // Step 1: Schema Smith
  const schema = await step('schema-smith', { retries: 2, timeout: '90s' }, async () => {
    const out = await schemaSmith({ description, workspaceId });
    if (out.pattern === null) throw new Error(`Needs clarification: ${out.rationale}`);
    await db.generationStep.create({ data: { generationId, agent: 'schema_smith', /* ... */ } });
    await logToNotion(generationId, `✅ Schema Smith: pattern=${out.pattern}`);
    return out;
  });

  // Step 2: Tool Coder
  const code = await step('tool-coder', { retries: 2, timeout: '120s' }, async () => {
    const out = await toolCoder({ description, schema });
    await db.generationStep.create({ data: { generationId, agent: 'tool_coder', /* ... */ } });
    await logToNotion(generationId, `✅ Tool Coder: ${out.sourceLines} lines`);
    return out;
  });

  // Step 3: Inspector (with feedback loop to Tool Coder)
  let inspection;
  let inspectAttempt = 0;
  let currentCode = code;
  while (inspectAttempt < 2) {
    inspection = await step(`inspector-${inspectAttempt}`, { timeout: '90s' }, async () => {
      return await inspector({ generationId, code: currentCode });
    });
    if (inspection.pass) break;
    inspectAttempt++;
    await logToNotion(generationId, `🔄 Inspector found issues, retrying Tool Coder...`);
    currentCode = await step(`tool-coder-retry-${inspectAttempt}`, { timeout: '120s' }, async () => {
      return await toolCoder({ description, schema, prevErrors: inspection.errors });
    });
  }
  if (!inspection.pass) throw new Error(`Inspector failed after 2 retries`);
  await logToNotion(generationId, `✅ Inspector: passed at stage=${inspection.stage}`);

  // Step 4: Shipper
  const ship = await step('shipper', { retries: 1, timeout: '120s' }, async () => {
    const out = await shipper({ generationId, workspaceId, schema, code: currentCode });
    await db.generationStep.create({ data: { generationId, agent: 'shipper', /* ... */ } });
    await logToNotion(generationId,
      `✅ Shipper: deployed → ${out.deployUrl}\n🤖 Custom Agent: ${out.customAgentId}`);
    return out;
  });

  // Step 5: Finalize
  await step('finalize', {}, async () => {
    await db.generation.update({
      where: { id: generationId },
      data: { status: 'succeeded', completedAt: new Date(), agentId: ship.customAgentId },
    });
    // PostHog event, Resend email, audit log
  });
});
```

**Cancellation:** the cancel endpoint emits `forge/generation.cancelled`, which Workflow DevKit handles natively. In-flight Sandbox processes are killed via tag.

---

# Part IX — Code-Gen Safety

> Security Engineer.

### Forbidden API list (AST-checked)

Block in generated Worker code before Inspector runs:
- `child_process.*`, `process.exec`
- `fs.writeFile*` outside `/tmp` (relative paths default to `/tmp`)
- `fs.readFile*` of paths outside `/tmp` or the project root
- `eval`, `Function()` constructor
- `import()` of dynamic strings
- Network calls to non-allowlisted hosts (allowlist mirrors Notion's Workers allowlist + adds explicit providers when user has OAuth'd them)

### Schema validation

- All Tool Coder output passes through `j` builder's runtime validation
- `tsc --noEmit` with the canonical `tsconfig.json` (no overrides)
- Generated `package.json` is restricted to dependency allowlist: `@notionhq/client`, `@notion/workers-sdk`, `zod`, `date-fns`. Anything else → reject

### Secrets handling

- Per-generated-agent secrets stored encrypted in PlanetScale, never logged
- Pushed to Notion Worker env via `ntn workers env set` from inside Vercel Sandbox (no client roundtrip)
- Rotation: dashboard surface for re-running `ntn workers env set`; on rotation, audit log row is written

### Sandbox isolation

- Inspector runs Worker exec inside Vercel Sandbox (Firecracker microVM)
- Per-generation sandbox; killed on completion
- 60s wall clock + 256MB memory + no outbound network except Notion API + npm registry (vendored deps preferred)

### OAuth scope minimization

- For each generated agent, Forge declares the *minimum* Notion scopes needed (Schema Smith outputs `requiredScopes`); user is prompted to grant only what's needed

---

# Part X — Observability + Security

> DevOps + Security Engineers.

| Concern | Tool | Implementation |
|---|---|---|
| Errors (server) | Sentry | `@sentry/nextjs` on all API routes + Workflow steps; release tags from Vercel deploy hashes |
| Errors (client) | Sentry | Browser SDK on dashboard |
| Errors (Sandbox) | Sentry | Worker exec stderr piped to Sentry breadcrumbs |
| Product analytics | PostHog | Funnel: install → first prompt → first deploy → re-deploy; feature flags via PostHog flags |
| Web vitals | Vercel Speed Insights | Dashboard pages |
| Traffic | Vercel Analytics | Dashboard pages |
| Self-monitoring | Forge "Operations" Notion DB | A DB inside our own Notion workspace that ingests metrics via a *Forge-generated* agent — we eat our own dog food |
| Audit | PlanetScale `AuditLog` | Every state-changing action; immutable (no updates allowed by policy) |
| Health check | `/api/healthz` | Returns Notion API ping + PlanetScale ping + Vercel Workflow ping |
| Cost tracking | PostHog + PlanetScale `UsageMeter` | Per-workspace daily aggregates of LLM cost + Sandbox seconds + ntn deploys |
| On-call (post-hackathon) | PagerDuty | Wired to Sentry + Vercel deploy failures |

### Auth flow

1. User visits dashboard → Clerk hosted sign-in
2. Clerk redirects to Notion OAuth via OAuth proxy
3. On callback, server creates Workspace + User; runs Installer (creates Forge page); issues Clerk session
4. Each API request includes Clerk JWT + workspace_id; middleware enforces workspace binding
5. Notion webhooks authenticated via per-workspace HMAC secret (stored at install time)

---

# Part XI — Integrations Catalog

> Integrations Engineer. First-party connectors that generated agents can use.

| Provider | OAuth path | Worker SDK helper | Typical agent pattern |
|---|---|---|---|
| Notion (always) | `ntn login` (workspace-level) | `context.notion` | Database queries, page updates |
| GitHub | `ntn oauth start github` | `@forge/connectors/github` | PR webhook → Notion row; issue triage |
| Linear | `ntn oauth start linear` | `@forge/connectors/linear` | Bug sync → Notion DB; triage Custom Agent |
| Stripe | `ntn oauth start stripe` | `@forge/connectors/stripe` | Charge sync → Notion DB; refund tool |
| Slack | `ntn oauth start slack` | `@forge/connectors/slack` | Notify on Notion changes; slash-command webhook |
| Google Workspace | `ntn oauth start google` | `@forge/connectors/google` | Gmail/Calendar/Drive sync |
| Sentry | API token via `ntn workers env set` | `@forge/connectors/sentry` | Error → Notion incident row |
| Vercel | API token | `@forge/connectors/vercel` | Deploy events → Notion changelog |
| Anthropic | API key | `@forge/connectors/anthropic` | LLM call inside generated agent (recursive!) |
| OpenAI | API key | `@forge/connectors/openai` | LLM call inside generated agent |
| MiniMax | API key | `@forge/connectors/minimax` | Voice/video gen inside generated agent |

Each connector is a thin typed wrapper that exposes signed API methods + handles auth refresh. Connectors live in `packages/connectors/` and are imported by the Tool Coder's few-shot examples so generated code uses them idiomatically.

---

# Part XII — Repo Structure

```
.
├── README.md
├── IDEAS.md / DEBATE.md / RESEARCH.md
├── PLAN.md  ← this document
├── package.json (workspaces)
├── pnpm-workspace.yaml
├── apps/
│   └── web/                    # Next.js 16 dashboard
│       ├── app/
│       │   ├── (auth)/
│       │   ├── agents/
│       │   ├── generations/[id]/
│       │   ├── settings/
│       │   └── api/            # all the API routes from §VI
│       ├── components/ui/      # shadcn
│       └── middleware.ts       # Clerk + workspace bind
├── packages/
│   ├── agents/                 # the 4 sub-agents
│   │   ├── schema-smith.ts
│   │   ├── tool-coder.ts
│   │   ├── inspector.ts
│   │   └── shipper.ts
│   ├── ntn-wrapper/            # typed shell-out to ntn CLI
│   │   ├── workers.ts          # deploy, exec, delete, list, etc.
│   │   ├── oauth.ts
│   │   ├── pages.ts
│   │   ├── webhooks.ts
│   │   ├── sync.ts
│   │   └── doctor.ts
│   ├── notion-client/          # typed Notion REST wrapper for studio use
│   ├── connectors/             # first-party connector SDKs (GitHub, Linear, etc.)
│   ├── db/                     # Prisma client + helpers
│   │   ├── prisma/schema.prisma
│   │   └── client.ts
│   ├── safety/                 # AST scanner + forbidden API check
│   ├── workflows/
│   │   └── forge.ts            # Vercel Workflow DevKit DAG
│   ├── mcp-server/             # Forge as MCP server
│   ├── installer/              # creates Forge page in user workspace
│   └── eval-harness/           # Promptfoo configs + golden inputs
├── e2e/                        # Playwright
├── scripts/
│   ├── setup.sh                # dev onboarding
│   └── seed-prompt-cache.ts    # production prompt cache priming (NOT seed data — production cache)
└── .github/workflows/
    ├── ci.yml
    ├── deploy-preview.yml
    └── deploy-prod.yml
```

---

# Part XIII — Implementation Milestones (24h)

> Total ~25 hours Sat 10:45 → Sun 12:00.

| Block | Hours | Outcome |
|---|---|---|
| Plumbing | 4 | Repo scaffold, Clerk auth, PlanetScale provisioned, Vercel project linked, `ntn login` flow tested end-to-end |
| Installer | 2 | Forge page + DBs auto-installed on first OAuth |
| Schema Smith | 3 | Producing valid `j` schemas with 100% AST pass rate on 5-prompt eval set |
| Tool Coder | 4 | Producing compiling TS on ≥4/5 prompts (prompt cache + few-shot in place) |
| Inspector | 3 | Sandbox runs `tsc` + `ntn workers exec`, surfaces failures, feeds back to Tool Coder |
| Shipper | 2 | `ntn workers deploy` from Sandbox + Custom Agent wire-up via Notion API |
| Notion-as-UI live log | 3 | Build Log block updates at 500ms cadence |
| End-to-end hardening | 2 | Run all 5 golden prompts end-to-end ≥10 times each, ≥80% pass |
| Pitch rehearsal + validation pics | 2 | 5 rehearsals; 3 customer-validation walkthroughs with photos |
| Submission | 1 | Public repo, Loom uploaded, Cerebral Valley form |

### Pivot decision gates

| Time | Gate | If FAIL → |
|---|---|---|
| Sat 16:00 | Schema Smith produces valid `j` schema for ≥3/3 test prompts | Continue |
| Sat 20:00 | Inspector + 1-retry loop produces compiling Worker for ≥2/3 test prompts | If <2/3 → pivot to Triage Goblin |
| Sat 23:00 | End-to-end `ntn deploy` succeeds on ≥1 golden path | If 0/1 → pivot to Triage Goblin |
| Sun 02:00 | Notion-as-UI live log streams at ≥1 Hz without rate-limit errors | Tune (batch updates) or pivot |
| Sun 06:00 | Final pivot deadline | Whatever's running, polish + record |

See [DEBATE.md](DEBATE.md) for Triage Goblin + Standby pivot plans.

---

# Part XIV — Pitch Script (3:00) + Q&A

### Hook (0:00–0:15)
> "Right now, building a Custom Agent in Notion is a 4-hour engineering project. We made it 90 seconds, in plain English, from inside Notion itself. We're going to ship one live on this stage."

### Problem (0:15–0:35)
> "Notion shipped Workers and Custom Agents four days ago. They're powerful, but you have to write TypeScript, design `j` schemas, deploy via CLI, debug — and the platform is so new there are barely any examples. Every PM, every designer, every solo dev in this room has agent ideas and no way to ship them."

### Live demo (0:35–2:15) — 90 seconds
1. Open Notion page titled "Forge"
2. Type into the input row: *"Make me an agent that pulls my open Linear bugs every hour and writes a triaged summary into this database, ordered by severity."*
3. Click **⚡ Forge this Agent**
4. Live log streams: "Schema Smith: drafting schema ✅ → Tool Coder: writing 87 lines of TypeScript ✅ → Inspector: tsc passed, ntn exec returned valid output ✅ → Shipper: deployed to `linear-bug-triager.notion.app/agent` ✅"
5. Click the deploy link, open the Custom Agent, run it. Real data appears in a real Notion DB. Audience claps.

### Validation (2:15–2:35)
> "We made 3 Notion engineers at this hackathon describe an agent. Forge shipped all 3. Here's the photo." *(Show validation page with their names + agent descriptions.)*

### Why now / why us (2:35–2:50)
> "Notion's Developer Platform just unlocked this surface. Anyone in your workspace can ship a Custom Agent now if Forge does the engineering. This is the wedge for 100x more Custom Agents per workspace."

### Team + ask (2:50–3:00)
> "Three of us, 24 hours, full open source. Try it: github.com/nihalnihalani/notion-hackathon-may-2026."

### Live encore (round 2 only)
> "Pick a judge. Describe an agent you wish your workspace had. We'll Forge it right now."

(Golden-path #1 is the fallback if the live attempt flakes — "we shipped 3 of these in 24h, here's one we baked earlier.")

### Anticipated Q&A

| Q | Sharp answer |
|---|---|
| Why not just use GPT Builder for Notion? | GPT Builder doesn't ship code, doesn't deploy, doesn't run in production. Forge generates real TypeScript, deploys via `ntn`, wires a Custom Agent, and the artifact runs every day in your workspace. |
| Why is this on Notion's Worker runtime vs a GitHub App / Vercel function? | Two reasons: (1) the artifact has to live inside Notion to be a Custom Agent — that's a platform requirement; (2) Notion's Worker runtime gives us hosted secrets + OAuth + auto-token injection so the generated code is 90 lines instead of 900. |
| What if the generated code is wrong? | Inspector runs `tsc` and `ntn workers exec` against synthetic input *before* claiming success. Failed builds never reach the user. On `tsc` errors, Tool Coder gets the errors in its next prompt and self-corrects (cap 2 retries). |
| How is this different from Claude Code? | Claude Code builds anything. Forge ships a runnable, deployed-to-your-workspace Custom Agent in 90 seconds with no terminal, no editor, no git — just a Notion page. |
| Code-gen will hallucinate `j` schema. | We constrain to 5 tool patterns (database-query / webhook-trigger / sync-source / external-api-call / multi-step). Pre-baked templates parameterized by Schema Smith, not raw freeform generation. Hallucination surface is small. |
| What's the business model? | For Notion: 100x multiplier on Custom Agents per workspace = stickiness + platform stickiness for the entire Workers SKU. For an independent product: hosted Forge with one-click OAuth providers and a private Custom Agent marketplace. |
| Is this safe? Could an agent generate a destructive Worker? | Generated Workers respect the Custom Agent's existing permission scope (auto-injected `context.notion`). Inspector runs in sandbox via `ntn workers exec`. Shipper only deploys to the user's workspace they're already authed for. We don't escalate scope. |
| Who's the user — PMs or engineers? | Both. The English input is for PMs/designers. The generated code + deploy link is for engineers to audit if they want. We're the bridge. |
| What if I want to edit the generated agent after? | The deploy URL links to the source file in the user's Workers project — they can edit + `ntn workers deploy` like any other Worker. We're not a lock-in. |
| Why no UI outside Notion? | (a) Notion's own launch demo was a live agent in a Notion page — judges built the platform for this. (b) Notion is our design system. (c) The artifact-lives-where-the-creator-lives story is tighter. |
| You're rebuilding v0 for Notion. | No — opinionated code-gen for a 5-pattern surface, not general web apps. v0 is the analogy, not the competitor. |
| Andrew Qu from Vercel will see through this. | Andrew Qu is the customer, not the enemy. The pitch borrows Vercel's DX-as-moat playbook explicitly. |

---

# Part XV — Risks + Mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Generated TS doesn't compile live | Med | Inspector + 1 retry + 3 pre-baked golden paths if the live attempt flakes |
| Live `ntn deploy` slow (>30s) | Med | Pre-warm a "freshly-deployed" Worker; the headline demo can deploy in parallel with the pitch |
| Notion API 429 during log streaming | Low | Batch updates at 500ms intervals; max 2 req/sec |
| Schema-writer hallucinates wrong `j` types | Med | Few-shot prompt with full `j` reference inline; Zod validation on Schema Smith output |
| OAuth fails on demo (token expired) | Low | Re-auth before pitch; have backup workspace ready |
| Worker undocumented limits (timeouts, memory) | Med | All 3 golden-path Workers are <100 LOC, single API call each |
| Schema migration drops data on redeploy | Low | Don't redeploy the demo workspace's schema during pitch hour |
| Outbound domain not on allowlist | Med | Golden paths use Notion API + GitHub API + Linear API only — all confirmed on allowlist |
| Internet flakes at venue | Low | Run demo on cell hotspot as backup; pre-record Loom as final fallback |
| Brian Lovin says "this is just GPT Builder for Notion" | Med | Q&A answer above is rehearsed |
| Andrew Qu says "we already have v0" | Med | Sharp answer: "v0 ships React apps for the web. Forge ships Custom Agents for Notion. Different surface, different runtime, different scope. We borrowed your DX-as-moat playbook." |
| Demo internet between studio (laptop) and Notion page lags | Med | Co-locate studio + Notion API in same region during demo; tunnel via ngrok with reserved subdomain |
| Code-gen takes >90s and pitch overruns | High | Pre-warm Anthropic API connection; cache prompt prefixes; if a sub-agent takes >20s show "thinking deeper" message |
| Vercel Workflow DevKit too new for production | Med | Inngest backup is pre-wired (functions exist but feature-flagged off). Pivot is 30min if WDK misbehaves. |
| Custom Agent REST API isn't exposed | Med | Fall back to one-click deep-link to Notion Settings → Custom Agents UI. 1 click. |

---

# Part XVI — YAGNI Cuts (locked)

- ❌ No web UI — surface is a Notion page + local CLI
- ❌ No multi-tenancy / auth — single demo workspace
- ❌ No agent marketplace UI — that's future-rollout slide #1
- ❌ No payment / billing live (meter is scaffolded)
- ❌ No support for non-Custom-Agent destinations
- ❌ No fancy code-gen safety beyond AST + sandbox
- ❌ No support for >5 tool patterns at launch
- ❌ No "edit-in-place" — generated agents are edited via the user's Workers project
- ❌ No agent versioning beyond what `ntn` provides
- ❌ No mobile / native — pure web

---

# Part XVII — Devil's Advocate Consolidation

> Brutal. Each one answered.

| Brutal claim | Response |
|---|---|
| "You're rebuilding v0 for Notion in 24h. v0 has 50 engineers." | We're not building general code-gen. We're building **opinionated code-gen for a 5-pattern surface** on a 4-day-old platform with no incumbents. Constraint = quality. |
| "Andrew Qu from Vercel will see through this." | Andrew Qu is the **customer**, not the enemy. The pitch explicitly borrows Vercel's DX-as-moat playbook. He'll recognize the shape. |
| "Generated code will hallucinate `j` syntax." | Prompt cache contains the exact `j` reference + 8 few-shot examples covering all 5 patterns. AST safety check + tsc + ntn exec gate every result. Failed compiles are caught, never shown. |
| "Notion API rate limit will throttle the live log." | 500ms cadence = 2 req/sec; 3 req/sec sustained limit. We have headroom. If we approach the ceiling we batch. |
| "Workers can't shell out to ntn." | Confirmed. Forge studio runs **outside** Workers (Vercel Sandbox). It deploys **into** Workers as the artifact. This is the architecture, not a workaround. |
| "Custom Agent creation might not have a REST API." | Fallback: surface a one-click deep-link to the user's Notion Settings → Custom Agents UI. 1 click. Acceptable. |
| "What if the user's prompt is genuinely ambiguous?" | Schema Smith returns `pattern: null` with a clarifying question; pipeline halts; user edits the description; re-trigger. |
| "Vercel Workflow DevKit is too new for production." | Inngest backup is pre-wired (functions exist but feature-flagged off). Pivot is 30min if WDK misbehaves. |
| "OAuth chicken-egg will bite during demo." | Pre-deployed staging slot pattern: every workspace gets a slot reserved at install time so OAuth redirect URLs exist before user triggers their first generation. |
| "30s Worker timeout means slow integrations die." | Generated Workers are constrained to single-step `worker.tool()` calls or `worker.sync()` batches. Long ops are split via sync state cursors. Documented in patterns. |
| "Sentry will get flooded with code-gen errors." | Code-gen failures are *expected* outcomes, not errors. They emit PostHog events, not Sentry exceptions. Only platform errors (Sandbox crash, Workflow infrastructure failure, Notion API 5xx) reach Sentry. |
| "Notion launch was 4 days ago — what if the platform changes Saturday?" | We pin `NTN_VERSION` in CI. Any platform-breaking change is contained. We monitor `ntn doctor` output on every deploy. |
| "You don't have a designer; the Notion page will look amateur." | Cole Bemis judges the first round — but the Notion page uses Notion's native primitives, which Cole literally designs. Notion-as-UI is the design system. |
| "The MCP server is scope creep." | It's 1 endpoint that exposes the existing `/api/forge/trigger` with the MCP protocol wrapper. ~50 LOC. Adds the "you can drive Forge from Claude Code" demo line. Cheap surface, high optionality. |
| "Code-gen safety AST scanner will be wrong." | Erring on the side of false-positives. False-positive → user rewords slightly. False-negative → security incident. Asymmetric — we choose strict. |
| "PlanetScale + Clerk + Sentry + PostHog + Resend + Upstash + Inngest backup is too many vendors for 24h." | All on Vercel Marketplace = single sign-up, single billing, env vars auto-injected. Setup is `vercel link` + `vercel env pull` + 4 marketplace clicks. |
| "Nobody will validate this during the hackathon." | Plan: DM 3 Notion-engineer attendees at hour 20; each describes an agent; we Forge it; we take their photo + their generated agent's screenshot. **Customer validation per Gary's checklist, in the room.** |
| "Even if it works, judges will say 'cute but not a business.'" | Q&A answer prepared: for Notion, this is 100x stickiness on the Workers SKU; for an independent product, it's a hosted Forge w/ provider OAuth + private agent marketplace. |
| "You're shipping with no rollback story." | Every `ntn workers deploy` is a versioned slot; revert is `ntn workers deploy --version=<prev>`. Surfaced as "Revert" button in dashboard. |
| "What if Vercel Sandbox can't install `@notion/workers-sdk`?" | Vendored: dep is checked into the Inspector image during Vercel build. No live npm during Inspector. |

---

# Part XVIII — Production Readiness Checklist

| Area | Item | Status target |
|---|---|---|
| Auth | Clerk + Notion OAuth + workspace bind | ✅ no demo skip |
| Auth | JWT validation on every API route | ✅ middleware |
| Auth | Notion webhook signature verification | ✅ per-workspace HMAC |
| Data | PlanetScale provisioned + branched per env | ✅ |
| Data | Prisma migrations checked into git | ✅ |
| Data | Audit log immutable (DB-level policy) | ✅ |
| Data | No seed data — every row created by real user action | ✅ |
| AI | Prompt cache live with TTL + invalidation on schema bump | ✅ |
| AI | Eval harness gates merges to main on each sub-agent | ✅ |
| AI | Multi-model failover via Vercel AI Gateway | ✅ |
| Safety | AST scanner runs on every generated file | ✅ |
| Safety | Forbidden API list documented + tested | ✅ |
| Safety | Generated `package.json` dep allowlist enforced | ✅ |
| Obs | Sentry on all server entry points | ✅ |
| Obs | PostHog on all key funnel events | ✅ |
| Obs | Forge "Operations" Notion DB dogfooding | ✅ |
| CI | Vitest ≥80% on `packages/agents/`, `packages/ntn-wrapper/`, `packages/safety/` | ✅ |
| CI | Playwright happy-path E2E green | ✅ |
| CI | Vercel preview deploy on every PR | ✅ |
| CI | Lint + typecheck + format gate merges | ✅ |
| Deploy | Vercel prod deploy via merge to main | ✅ |
| Deploy | PlanetScale migration runs on deploy | ✅ |
| Deploy | Rollback documented (revert merge + redeploy) | ✅ |
| Docs | README clean + install steps + architecture | ✅ |
| Docs | Each `packages/*` has README explaining its surface | ✅ |
| Docs | API routes documented in `docs/api.md` | ✅ |
| Billing | UsageMeter recording per-workspace daily aggregates | ✅ (free tier in v1, surface ready) |
| Billing | Stripe meter wired for future paid tier (no live pricing yet) | ✅ scaffolded |
| Legal | MIT license | ✅ |
| Legal | Privacy policy stub | ✅ |
| Legal | Notion's marketplace terms acknowledged | ✅ |

---

# Part XIX — Submission Checklist (12pm Sunday)

- [ ] Flip GitHub repo PUBLIC (currently private — required by hackathon rules)
- [ ] README.md is clean (intro + install + demo Loom link)
- [ ] LICENSE file (MIT)
- [ ] 1-minute demo video uploaded to YouTube/Loom
- [ ] Submission form completed on [Cerebral Valley](https://cerebralvalley.ai/e/notion-developer-platform-hackathon/hackathon/submit) with all 3 teammates
- [ ] Demo workspace pre-loaded with the Forge page + 3 golden-path examples
- [ ] Hotspot ready, laptop charged, backup Loom on phone
- [ ] Customer validation photos saved in `/validation/` dir of repo
- [ ] Pitch rehearsed ≥5 times
- [ ] 1-page printed handout with URL + QR code

---

# Appendix — Sponsors at a Glance

| Sponsor | Product surface in Forge | Prize relevance |
|---|---|---|
| **Notion** | Host platform + Custom Agents + Workers + ntn CLI + UI surface | THE platform |
| **Anthropic** | Claude Opus 4.7 primary model + prompt caching + extended thinking | $7K 1st place credits |
| **OpenAI** | GPT-5 fallback + text-embedding-3-large for cache | $5K 1st place credits |
| **Vercel** | Hosting + AI Gateway + Workflow DevKit + Sandbox + Blob + Edge Config + Analytics | $1800 per teammate |
| **PlanetScale** | Postgres for all state + audit | $10K 1st place credits |
| **MiniMax** | Voice input + agent avatars | $5K 1st place credits + Mac Mini raffle |
