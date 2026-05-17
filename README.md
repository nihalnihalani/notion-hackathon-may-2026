# notion-hackathon-may-2026

Working repo for **Nihal**, **Charlie** ([@charliegillet](https://github.com/charliegillet)), and **Yahya** ([@yhinai](https://github.com/yhinai)) at the **Notion Developer Platform Hackathon** (Notion HQ, May 16–17, 2026).

## TL;DR

After two rounds of brutal debate across 20+ candidate ideas with three research agents (Notion platform, judge panel, viral-demo SHAPES, /last30days trends, platform sharp-edges) and a maximally-brutal devil's advocate:

### 🏆 PRIMARY: **Forge — Notion Custom Agent Studio**

A Notion-native page where you describe an agent in plain English, click **⚡ Forge this Agent**, and watch a manager-of-agents pipeline (schema-writer → tool-coder → evaluator → deployer) ship a real, deployed Custom Agent in 90 seconds. The evaluator actually runs the generated Worker before declaring success. Open source.

**Why it wins:** Hits 5 of 7 final-round judges directly (Schoening's "cultivating agency," Simon Last's "platform multiplier," Morris's sub-agent orchestration, Qu's DX-as-moat, Vernal's ecosystem defensibility). Uses Notion-as-UI — the exact shape Notion's own launch demo used. Manager-of-agents pattern is what Notion's GTM team built internally ("Token Town"). Judges ARE the customers — every Notion engineer in the room wants this.

### 🥈 BACKUP: **Triage Goblin** — Live multi-agent OSS issue-triage living inside a Notion page

If the team gets cold feet on code-gen flake risk on day 2, swap to this. Lower ceiling, much higher floor. Same Notion-as-UI + manager-of-agents pattern.

### 🥉 SECOND BACKUP: **Standby** — Live multi-agent incident room

PagerDuty/Sentry webhook → live incident room renders in Notion with comms templates + war-room agenda + impact estimator + postmortem skeleton. Vercel CTO-office bait.

## Files

- [**PLAN.md**](PLAN.md) — **production-grade detailed plan**: agent team, architecture, every `ntn` CLI surface used, sponsor mapping, data model, code-gen safety, pitch script, Q&A, prod readiness checklist
- [IDEAS.md](IDEAS.md) — full pool of 20+ candidates with status (eliminated / finalist / winner)
- [DEBATE.md](DEBATE.md) — multi-round brutal debate transcript
- [RESEARCH.md](RESEARCH.md) — raw findings: platform deep-dive, judge intel, viral SHAPES, /last30days, sharp edges

## Install

**Prerequisites**

- Node.js **20+** (`nvm use` picks up the pinned version in `.nvmrc`)
- pnpm **9+** (`corepack enable && corepack prepare pnpm@9 --activate`)
- The Notion `ntn` CLI: `curl -fsSL https://ntn.dev | bash`

**Setup**

```bash
bash scripts/setup.sh
```

`scripts/setup.sh` verifies Node + pnpm + `ntn` versions, copies `.env.example` → `.env` if missing, installs workspace dependencies, and runs `ntn doctor`.

**Fill in `.env`**, then validate it:

```bash
pnpm verify:env
```

**Run the dev stack:**

```bash
pnpm dev
```

The Next.js dashboard comes up on `http://localhost:3000`.

## Architecture

- **Tech stack + sponsor mapping** — [PLAN.md Part II](PLAN.md#part-ii--tech-stack-with-sponsor-mapping)
- **`ntn` CLI surface used by Forge** — [PLAN.md Part III](PLAN.md#part-iii--ntn-cli-deep-dive)
- **PlanetScale data model** — [PLAN.md Part V](PLAN.md#part-v--data-model-planetscale)
- **Vercel Workflow DevKit orchestration** — [PLAN.md Part VIII](PLAN.md#part-viii--workflow-orchestration-vercel-workflow-devkit)

## Rules summary (so we don't get DQ'd)

- **Fully open source**, all components, approved license — this repo is private now, **flip to public before submission**
- **New work only**, started during the hackathon
- Demo must only highlight what we built during the event
- Team max 4 — we are 3, room for one more
- **Submission deadline: Sun May 17, 12:00 PM** via [Cerebral Valley platform](https://cerebralvalley.ai/e/notion-developer-platform-hackathon/hackathon/submit)
- Must build in ≥1 of three themes: Autonomous Sidekick / Workflow Relay / Chaos Mode (Forge hits Workflow Relay primarily + light Autonomous)
- Banned: basic RAG / medical / nutrition / AI-tutor / AI-companion / personality analyzer / NSFW / **Streamlit**

## Hackathon trial + credits

All teammates need a Notion account; share workspace IDs to `lhorwitz@makenotion.com` **by Thursday May 14** to get the 4-day Business trial + credits bundle.
