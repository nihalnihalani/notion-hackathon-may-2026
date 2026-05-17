# Raw Research Findings

Consolidated output from 5 research agents + 1 /last30days run. Sources cited inline.

---

## 1. Notion Developer Platform — what's new, what's possible

**Platform launch date:** May 13, 2026 (per `notion.com/releases/2026-05-13`). **4 days old at hackathon kickoff.**

### Workers runtime
- **Language:** TypeScript / JavaScript only (Node ecosystem)
- **Triggers:** scheduled syncs (min 5m, configurable 5m/15m/1h/1d/7d, default 30m), inbound webhooks, agent-tool-calls, manual via `ntn workers exec`
- **Runtime cap:** ~30s per invocation ([fazm.ai update](https://fazm.ai/blog/notion-update-april-2026-new-features))
- **Memory cap:** ~128MB per invocation
- **No state between invocations** — external state mgmt required for multi-step flows
- **Outbound network:** allowlist only — calls to non-whitelisted domains fail silently
- **No shelling out** (can't exec `ntn` or any binary from inside a Worker)
- **Deploy lifecycle:** `ntn workers new` → edit `src/index.ts` → `ntn workers deploy`
- **Auth:** `ntn login` → OAuth in browser → credentials in macOS Keychain
- **Secrets:** `ntn workers env set/list/unset/pull/push`, encrypted
- **Pricing:** free through Aug 11, 2026, then ~$10 / 1000 credits (≈ $0.01/mo for daily syncs)

### ntn CLI commands
- `workers`: new / deploy / list / get / create / delete / exec / capabilities list / tui
- `sync`: status / trigger / pause / resume / state get / state reset
- `env`: set / list / unset / pull / push
- `oauth`: start / token / show-redirect-url
- `webhooks list` · `runs list/logs` · `api [endpoint]`
- `datasources query/resolve` · `pages get/create/update/trash` · `files create/get/list`
- `login` / `logout` / `doctor` / `update`

### Custom Agent tools
- Created via `worker.tool({ key, title, description, inputSchema, execute, outputSchema?, readOnlyHint? })`
- Schema uses fluent `j` builder (NOT raw JSON Schema): `j.string().describe(...)`, `j.integer()`, `j.enum(...)`, `j.nullable()`
- `context.notion` is auto-authed with the Custom Agent's permissions
- `readOnlyHint: true` → executes without user confirmation
- Tools become available in Custom Agent's Tools & Access UI after `ntn deploy`

### Webhooks
- Inbound: `worker.webhook()` generates a unique URL; Notion validates signature, returns 202, runs handler async
- Receives `WebhookEvent[]` with `deliveryId`, parsed `body`, raw string for verification, headers, method
- 5 consecutive signature-verification failures → webhook auto-blocked until redeploy
- Outbound (Notion → you): 30+ events across pages / databases / comments / data sources / files / views — create, update, delete, move, transcription, etc.

### Database sync
- Pull from any HTTP API returning JSON; transform; return records
- Notion handles schema, upsert by primary key, cursor/state, retries
- Two modes: Replace (full re-fetch, <10k records) and Incremental (return delta + nextState cursor)
- Conflict policy: last-write-wins (no merge)

### MCP
- Notion's MCP server is for AI assistants *consuming* Notion (Claude Code, Cursor, ChatGPT, VS Code)
- 18 tools (`notion-search`, `notion-fetch`, `notion-create-pages`, etc.)
- Rate limit: 180 req/min general, 30 req/min search
- **Not directly hackathon-relevant** — Workers are the *building* primitive; MCP is consumer-side

### What's genuinely novel vs old REST API
- Hosted runtime (no server mgmt)
- Sync state mgmt built-in
- Agent tool registry (tools discoverable inside Notion AI)
- Auto-token injection in `context.notion`
- Built-in `worker.pacer()` rate-limiter for outbound calls
- Unified CLI for everything

### Existing real examples (shockingly few)
- [Official template](https://github.com/makenotion/workers-template) — greeting tool + basic webhook + Sheets sync skeleton
- [Google Sheets → Notion sync tutorial](https://notionbackups.com/guides/notion-workers-sync-google-sheets-to-notion)
- [Matthias Frank Dev Day 2026 overview](https://matthiasfrank.de/en/notion-workers-dev-day-2026/) — 6 hypothetical case studies, not shipped builds
- [Notion blog launch post](https://www.notion.com/blog/introducing-developer-platform)
- **Zero other working public examples found in GitHub search.** Wide-open novelty space.

### Critical sharp edges for live demos
1. OAuth chicken-egg: must deploy worker first to get redirect URL → create OAuth app → store secrets → redeploy
2. Schema migration can silently drop data on redeploy if you change column types
3. No streaming logs (`ntn workers runs logs <runId>` is post-execution only)
4. No local dev / hot reload — every change is `ntn workers deploy` (10–30s)
5. No debugger / breakpoints — `console.log` only
6. Webhook double-fire possible on retry — must idempotency-key with provider event ID in your code
7. Sync state cursor can corrupt if you redeploy mid-sync — pause first
8. Rate limit: 3 req/sec sustained, 10 burst — agent tool calls count against this
9. Payload max: 500KB, 1000 blocks/request
10. Schema validation strict — `j` builder is the only spec format

### Capability sparks (only possible with the new platform)
- Real-time bidirectional sync + change tracking (webhook in + sync out + tool callback)
- Notion as middleware for external data pipelines with AI oversight
- Workspace-event-driven agent workflows (page edit → agent reacts via webhook)
- OAuth multi-provider unification into a single Notion DB
- Webhook-driven Notion feedback loop with tool validation back to external systems

---

## 2. Judge intel

### Final round (the ones who pick #1)

| Judge | Org | What they ship | What wins them | What loses them |
|---|---|---|---|---|
| **Simon Last** | Notion (cofounder) | The platform itself | Scheduled multi-tool agents with memory + shareable artifacts | Toy assistants, no real autonomy |
| **Max Schoening** | Notion (Head of Product) | Notion product surface | "Cultivating agency" — AI that expands humans not replaces them | Polished decks with broken demos; passive AI |
| **Anthony Morris** | Anthropic (Claude Code MTS) | Claude Code harness, sub-agents, skills, teammate-tool | Multi-turn agent patterns, sub-agents, skill orchestration | Single-shot chatbots, basic RAG |
| **Andrew Qu** | Vercel (Chief of Software, Office of CTO) | Vercel platform, v0, DX | Docs-as-moat for AI; Next.js as default for AI-native UIs | Sloppy DX, no documentation, blackbox tools |
| **Matt Palmer** | Conductor (DevEx) | Developer experience tooling | Clear API surfaces, opinionated DX | Half-baked DX |
| **Mike Vernal** | Conviction (Investor, ex-FB) | Investment thesis | Founder-market fit, defensible positioning, ecosystem moats | "Me-too" agent layers, weak differentiation |
| **Pavla Bobosikova** | Neo (Investor) | Early-stage check | Working MVPs + customer traction over slides | Decks > demos |

### First round (gates to the final)

| Judge | Org | One-line signal |
|---|---|---|
| Alfred Xing | Anthropic MTS | Technical depth + correctness |
| Alice Zhao | Anthropic MTS | Technical depth + correctness |
| **Brian Lovin** | Notion Product | Just built Side Project Chief of Staff — will spot chief-of-staff derivatives instantly |
| Carter Pedersen | Notion Eng | Implementation quality |
| Charmaine Lee | Anthropic Applied AI | Real-world deployability |
| **Cole Bemis** | Notion Product (Octicons/Primer) | Design polish; will downgrade Streamlit-tier UIs on sight |
| Jules Qiu | Radical Ventures | Investment angle |
| **Lakshmi Subbramanian** | Vercel (Head of Financial Infra) | B2B workflow rigor |
| Neena Parikh | Notion Eng | Implementation quality |
| Paul Scherer | Eigen (Founder/CEO) | Founder-market fit |

### Coverage map of Forge vs final-round judges

| Judge | Forge hits via | Strength |
|---|---|---|
| Simon Last | Platform multiplier (Notion-on-Notion); multi-agent w/ memory | ⭐⭐⭐⭐⭐ |
| Max Schoening | "Cultivating agency" = English → working agent | ⭐⭐⭐⭐⭐ |
| Anthony Morris | Sub-agent orchestration is literally his daily life | ⭐⭐⭐⭐⭐ |
| Andrew Qu | DX as moat; opinionated narrow-surface code-gen | ⭐⭐⭐⭐ |
| Matt Palmer | Opinionated DX | ⭐⭐⭐ |
| Mike Vernal | Developer ecosystem = defensible moat for Notion | ⭐⭐⭐⭐ |
| Pavla Bobosikova | Working MVP + traction (judges-as-customers validate live) | ⭐⭐⭐⭐ |

---

## 3. /last30days trend signals

(Limited run — ScrapeCreators payment-required mid-run + Bird JSON error. Surviving signals are clean.)

- **"Digital Chief of Staff" is the dominant trending agentic pattern** ([@achieveai_](https://x.com/achieveai_/status/2055799179004526795), [@teaganyuen1](https://x.com/teaganyuen1/status/2055808013693243609), [Yutori via @grok](https://x.com/grok/status/2052463919671714032))
- **Multi-skill orchestration + sub-agent teams** is the loudest Claude ecosystem story ([Grace Leung "AI Marketing Team in 16 Minutes"](https://www.youtube.com/watch?v=X8afcX2s2Mo), 175K views — skills + sub-agents + parallel agent teams + plugin packaging)
- **Implication:** Building another Chief-of-Staff puts you against 30+ other teams *and* on collision with Brian Lovin's recent project. Building a manager-of-agents or studio that *creates* CoS agents is differentiated.

---

## 4. Viral demo SHAPES (last 60 days, hand-picked)

The structural form, not the topic. Worth borrowing or subverting.

1. **"Single sentence to a swarm"** — Okara AI CMO (10M views, crashed own servers) — one prompt fans out to specialized parallel sub-agents producing a campaign deck in minutes. Spread because it framed an entire C-suite role as a one-liner. ([writeup](https://quasa.io/media/agentic-marketing-revolution-okara-s-ai-cmo-agent-hits-10-million-views-and-takes-down-its-own-infrastructure))
2. **"Agent vs Agent arena"** — Browser Brawl (YC winner) — two browser agents fight on a live website; each match emits a training trace. Built in <24h. Demo IS a game between AIs. ([HN](https://news.ycombinator.com/item?id=47248684))
3. **"48-agent studio mimics a real org"** — Claude Code Game Studios — 48 sub-agents in a game-studio org chart produce GDD, scaffolding, shaders, dialogue. The org chart visual makes "multi-agent" tangible. ([StraySpark](https://www.strayspark.studio/blog/claude-code-multi-agent-studios-game-development))
4. **"Hidden feature reveal"** — claude-sneakpeek (281 HN pts in hours) — reverse-engineered Anthropic's flag-gated TeammateTool. Spread on "secret unlocked." ([HN](https://news.ycombinator.com/item?id=46743908))
5. **"Manager-of-agents"** — Notion's own internal "Token Town" pattern (Latent Space pod) — 30+ specialist agents managed by one supervisor that collapses 70 notifications/day → ~5. **Notion engineers literally validated this shape** and it lives in Notion DBs/pages. No external UI. ([Latent Space](https://www.latent.space/p/notion))
6. **"Self-bootstrapping agent"** — also from Notion's pod — agent writes its own system prompt, tests itself end-to-end, debugs failures in same chat. Demo IS the agent setting itself up live. ([Latent Space](https://www.latent.space/p/notion))
7. **"Live triage agent over real inbox"** — Notion's own Dev Day launch demo — agent reads a real coworking-space application email → web-enriches → writes Notion DB row → triages reply. **This is the official shape Notion picked to evangelize.** ([Latent Space](https://www.latent.space/p/notion), [TechCrunch](https://techcrunch.com/2026/05/13/notion-just-turned-its-workspace-into-a-hub-for-ai-agents/))
8. **"It feels like a product"** — LORE (GitLab Grand Prize) — 8-agent system + knowledge graph + dashboard + 43 test cases captures org knowledge. Anthropic judge quote went around: "This feels like a product." Demo shape: dashboard showing agents coordinating on real repo. ([GitLab winners](https://about.gitlab.com/blog/gitlab-ai-hackathon-2026-meet-the-winners/))
9. **"Zero-touch security PR"** — Gitdefender (GitLab Google Cloud Grand Prize) — agent watches code review, finds vuln, writes fix, opens PR itself. Demo is a diff appearing with no human cursor. ([GitLab winners](https://about.gitlab.com/blog/gitlab-ai-hackathon-2026-meet-the-winners/))
10. **"Production time-travel"** — Time-Traveler (GitLab Most Technically Impressive) — 5 agents clone prod, run a migration against the clone, report results. Demo: "the scariest thing in ops, done live, safely." ([GitLab winners](https://about.gitlab.com/blog/gitlab-ai-hackathon-2026-meet-the-winners/))
11. **"Personal team in a box"** — Project Ollie — 14 agents on a $600 Mac Mini deliver an exec briefing to the founder's phone before they wake up. Demo IS the phone notification arriving. ([Smith Stephen](https://www.smithstephen.com/p/the-ai-agent-demo-was-easy-trusting))

### Forge borrows from: 1 (single sentence → swarm) + 5 (manager-of-agents) + 6 (self-bootstrapping) + 7 (Notion-as-UI) + 8 ("feels like a product") + 9 (zero-touch deploy artifact appears)

That's **six viral-validated shapes stacked into one demo**.

---

## 5. Notion-as-UI signal (most important strategic finding)

- Notion's own launch demo at Dev Day was a **live triage agent inside a Notion page** — that's the shape they chose to evangelize
- Notion's internal team built **manager-of-agents in Notion DBs/pages** — no external UI
- **Virtually no public viral demo uses Notion AS the UI surface yet** — first-mover wide-open
- Cole Bemis (Notion Product, Octicons/Primer) will reward Notion-as-UI polish on sight; will downgrade React-app-with-Notion-on-the-side
- Brian Lovin (Notion Product) ships things on Notion; will gravitate to Notion-native demos

**Strategic verdict:** Any finalist that uses Notion as a custom React UI is at a disadvantage vs one that uses Notion-as-UI. Forge's "Notion page IS the studio" angle is structurally aligned with judge preference.

---

## 6. Anti-patterns (auto-lose risks)

From the explicit hackathon rules + Gary-Yau Chan's guide:

| Banned by rules | Banned by Gary |
|---|---|
| Basic RAG | "Free" as business model |
| Medical / nutrition advisor | Big-co partnership dependency (farfetched) |
| AI-for-education chatbot | Basic API stick-on |
| AI-companion chatbot | Backend-heavy w/o polished UI |
| Personality analyzer | No customer validation |
| NSFW | No front-end engineer on team |
| **Streamlit** (will be a tell on sight) | Pitching deck > demo |
