# Forge — Notion Custom Agent Studio

> Describe an agent in plain English. Get a real, deployed Notion Custom Agent in 90 seconds.

Forge is a Notion-native page that turns one sentence into a working, sandbox-validated, OAuth-wired Custom Agent in your workspace — no editor, no terminal, no git. A manager-of-agents pipeline (Schema Smith → Tool Coder → Inspector → Shipper) generates TypeScript, runs `tsc` and `ntn workers exec` against synthetic input, and only then promotes the deploy to your workspace.

---

## Demo

- **Loom (90s):** _TODO: paste link after recording — see [`docs/Loom-script.md`](docs/Loom-script.md)_
- **Screenshot:**

  ![Forge page in Notion](docs/screenshots/forge-page.png)

  _(see [`docs/screenshots/README.md`](docs/screenshots/README.md) for the screenshot capture checklist)_

---

## Why Forge

- **Manager-of-agents pattern that actually ships an artifact.** Four focused sub-agents (Schema Smith, Tool Coder, Inspector, Shipper) run in a durable Vercel Workflow DevKit DAG; the Inspector runs the generated Worker before declaring success, so failed compiles never reach the user.
- **Notion-as-UI.** The studio _is_ a Notion page in the user's workspace — the same shape Notion used in their launch demo. No second tab, no second design system.
- **Production-grade, open source.** Real Clerk + Notion OAuth from minute one, PlanetScale source-of-truth, AST safety scanner + Vercel Sandbox isolation, Promptfoo evals gating sub-agent merges. MIT-licensed.

---

## What it does

Forge constrains code-gen to **five tool patterns** so output is reliable. Each pattern is parameterized by Schema Smith, not freeform LLM output.

| Pattern | One-line | Example prompt |
|---|---|---|
| `database-query` | Reads/writes a Notion DB on a schedule or trigger | "Every morning, summarize yesterday's `Tasks` into a `Daily Digest` row." |
| `webhook-trigger` | External webhook → Notion row | "When a Stripe charge succeeds, append a row to my `Revenue` DB." |
| `sync-source` | Polls a third-party API → Notion DB | "Pull my open Linear bugs every hour into `Bug Triage`, sorted by severity." |
| `external-api-call` | Notion-triggered call to a third-party API | "When I flip `Status` to `Refund`, refund the Stripe charge linked on the row." |
| `multi-step` | Chains 2–3 of the above with intermediate state | "On a new GitHub issue, summarize, label, and assign — then mirror to Notion." |

The list of supported patterns lives in [`PLAN.md` §4.1](PLAN.md#41-schema-smith); changes to it are gated by the Promptfoo eval suite.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│   Notion workspace (user's)                                              │
│   ┌────────────────────────────┐    ┌────────────────────────────┐       │
│   │  Forge page (installed)    │    │  Generated Custom Agent     │      │
│   │  - Forge Requests DB       │    │  (Notion Workers runtime)   │      │
│   │  - ⚡ Forge button         │◀───┤  Wired by Shipper           │      │
│   │  - Build Log (live stream) │    └─────────────────────────────┘      │
│   └────────────┬───────────────┘                                         │
└────────────────│─────────────────────────────────────────────────────────┘
                 │  Button click → signed webhook
                 ▼
┌──────────────────────────────────────────────────────────────────────────┐
│   Vercel (Next.js 16 + Workflow DevKit + Sandbox)                        │
│                                                                          │
│   apps/web ─▶  /api/webhooks/notion-button                               │
│                   │                                                      │
│                   ▼                                                      │
│   @forge/workflows  ─ Schema Smith ─▶ Tool Coder ─▶ Inspector ─▶ Shipper │
│                          (Anthropic / OpenAI via Vercel AI Gateway)      │
│                          AST safety + tsc + ntn exec in Vercel Sandbox   │
│                   │                                                      │
│                   ▼                                                      │
│   @forge/db (PlanetScale Postgres)                                       │
│     workspaces · generations · generation_steps · generated_agents       │
│     prompt_cache · audit_log · usage_meter · evaluations                 │
└──────────────────────────────────────────────────────────────────────────┘
```

See [`docs/architecture.md`](docs/architecture.md) for the full request flow, sub-agent responsibilities, and data model.

---

## Tech stack (sponsor mapping)

Every sponsor is load-bearing. None are decorative.

| Sponsor | Role in Forge | Where |
|---|---|---|
| **Notion Developer Platform** | Host runtime for generated Custom Agents; OAuth provider; UI surface. `Notion-Version` header pinned to `2026-03-11` per [docs.notion.com](https://docs.notion.com/). | `@forge/notion-client`, `@forge/ntn-wrapper`, `@forge/installer` |
| **Anthropic Claude (Opus 4.7)** | Primary model for all four sub-agents. Prompt caching on the Worker template + `j` reference (~12K tokens) per Tool Coder call. Extended thinking on for the code-gen step. | `@forge/agents`, via Vercel AI Gateway |
| **OpenAI (GPT-5)** | Fallback model on Anthropic 5xx via Vercel AI Gateway. `text-embedding-3-large` for the prompt-similarity cache. | `@forge/agents`, `@forge/db/prompt-cache` |
| **Vercel** | Hosting (Next.js 16 + API routes), AI Gateway (multi-model routing + cost tracking), Workflow DevKit (durable DAG), Sandbox (runs `tsc` + `ntn workers exec`), Blob (TS artifact archive), Edge Config (flags), Analytics + Speed Insights. | `apps/web`, `@forge/workflows`, `vercel.json` |
| **PlanetScale** (Postgres) | Source of truth for workspaces, generations, steps, agents, prompt cache, audit log, usage meter. Branch-per-PR for migrations. | `@forge/db` (Prisma schema) |
| **MiniMax** | Voice-to-text for "describe an agent by voice" input; image gen for per-agent avatars stored on each `GeneratedAgent`. | `apps/web/lib/multimodal/*` |
| **Clerk** | Auth: Notion OAuth proxy + JWT issued to the dashboard. Workspace bind in middleware. | `apps/web/proxy.ts`, `apps/web/lib/auth.ts` |

Secondary infra (Upstash rate-limit, Sentry, PostHog, Resend, shadcn/ui, Promptfoo, Playwright) is documented in [`PLAN.md` Part II](PLAN.md#part-ii--tech-stack-with-sponsor-mapping).

---

## Quickstart

### Prerequisites

- Node.js **20+** — `nvm use` picks up `.nvmrc`
- pnpm **9+** — `corepack enable && corepack prepare pnpm@9 --activate`
- The Notion `ntn` CLI — `curl -fsSL https://ntn.dev | bash`

### Setup

```bash
git clone https://github.com/nihalnihalani/forge.git
cd forge
bash scripts/setup.sh
```

`scripts/setup.sh` verifies Node + pnpm + `ntn` versions, copies `.env.example` → `.env`, installs workspace dependencies, and runs `ntn doctor`.

### Fill in `.env`, then validate

```bash
pnpm verify:env
```

### Run the dev stack

```bash
pnpm dev
```

The Next.js dashboard comes up on `http://localhost:3000`. Sign in with Notion → the installer creates the **Forge** page + **Forge Requests** DB in your workspace → describe an agent → click **⚡ Forge this Agent** → watch the Build Log.

### Vercel deployment note

This is a pnpm + Turborepo monorepo. The Next.js app lives at `apps/web`, so the Vercel project's **Root Directory** must be set to `apps/web` (Project → Settings → General → Root Directory). `vercel.json` declares `framework: nextjs` and the deploy region but cannot set the Root Directory — that is a dashboard-only setting.

---

## Repo tour

| Path | What lives here |
|---|---|
| [`apps/web/`](apps/web/) | Next.js 16 dashboard + every `/api/*` route, Clerk middleware (`proxy.ts`), the Notion-button webhook |
| [`packages/agents/`](packages/agents/) | The four sub-agents (Schema Smith, Tool Coder, Inspector, Shipper) + shared types, errors, pricing helpers |
| [`packages/ntn-wrapper/`](packages/ntn-wrapper/) | Typed, audit-logged wrapper around the `ntn` CLI — workers, oauth, pages, webhooks, sync, files |
| [`packages/notion-client/`](packages/notion-client/) | Typed Notion REST wrapper for studio-side ops the CLI doesn't cover ergonomically |
| [`packages/connectors/`](packages/connectors/) | First-party connector SDKs (GitHub, Linear, Stripe, Slack, Google, Sentry, Vercel, Anthropic, OpenAI, MiniMax) imported by generated agents |
| [`packages/workflows/`](packages/workflows/) | Vercel Workflow DevKit DAG that sequences the sub-agents with retries, cancellation, idempotency |
| [`packages/db/`](packages/db/) | Prisma schema + Node and Edge clients + repositories + append-only audit log |
| [`packages/safety/`](packages/safety/) | AST scanner + forbidden-API check + `package.json` dep allowlist + `j` schema validator |
| [`packages/installer/`](packages/installer/) | Idempotent bootstrap of the Forge page + Forge Requests DB + Build Log block in a fresh workspace |
| [`packages/mcp-server/`](packages/mcp-server/) | Forge as an MCP server (`forge_agent` tool) — drive Forge from Claude Code, Cursor, ChatGPT |
| [`packages/eval-harness/`](packages/eval-harness/) | Promptfoo configs + golden inputs per sub-agent; CI dry-run + nightly real-API sweep |
| [`scripts/`](scripts/) | `setup.sh`, env verifier, prompt-cache priming |
| [`e2e/`](e2e/) | Playwright happy-path tests |

---

## How we got here

This repo includes the unedited debate trail that led to Forge winning over 20+ candidate ideas. The product brief is in [`PLAN.md`](PLAN.md); everything else is exposition.

- [**PLAN.md**](PLAN.md) — production plan: agent team, architecture, every `ntn` CLI surface used, sponsor mapping, data model, code-gen safety, pitch script, Q&A, prod readiness checklist
- [**IDEAS.md**](IDEAS.md) — full pool of 20+ candidates with elimination notes
- [**DEBATE.md**](DEBATE.md) — multi-round Builder vs Devil's Advocate transcript
- [**RESEARCH.md**](RESEARCH.md) — raw findings: platform deep-dive, judge intel, viral-demo SHAPES, /last30days trends, platform sharp edges
- [**docs/architecture.md**](docs/architecture.md) — request flow, sub-agent responsibilities, data flow
- [**docs/api.md**](docs/api.md) — HTTP API reference
- [**docs/CI_CD.md**](docs/CI_CD.md) — pipeline + how to add a sub-agent eval

---

## Hackathon submission

- **Event:** [Notion Developer Platform Hackathon](https://cerebralvalley.ai/e/notion-developer-platform-hackathon/), Notion HQ, May 16–17, 2026
- **Themes:** Workflow Relay (primary) + Autonomous Sidekick (secondary)
- **Submission:** [Cerebral Valley form](https://cerebralvalley.ai/e/notion-developer-platform-hackathon/hackathon/submit)
- **License:** MIT
- **All work in this repo:** started during the event (per hackathon rules)

---

## Contributing

PRs welcome — see [`CONTRIBUTING.md`](CONTRIBUTING.md) for dev setup, branch/commit conventions, the test-typecheck-lint gate, and how to add a new agent pattern or connector. All contributors must follow the [Code of Conduct](CODE_OF_CONDUCT.md). For security issues, see [`SECURITY.md`](SECURITY.md).

---

## License

[MIT](LICENSE) © 2026 Nihal Nihalani, Charlie Gillet, Yahya.

---

## Team

- **Nihal Nihalani** — [@nihalnihalani](https://github.com/nihalnihalani)
- **Charlie Gillet** — [@charliegillet](https://github.com/charliegillet)
- **Yahya** — [@yhinai](https://github.com/yhinai)

---

## Acknowledgments

Thanks to **Notion** for building the Developer Platform and hosting the hackathon, and to the sponsors who make this stack possible: **Anthropic**, **OpenAI**, **Vercel**, **PlanetScale**, **MiniMax**, **Clerk**, **Sentry**, **PostHog**, **Resend**, and **Upstash**. Special thanks to the Notion engineers who walked us through the `ntn` CLI sharp edges (logged in [`RESEARCH.md`](RESEARCH.md)).
