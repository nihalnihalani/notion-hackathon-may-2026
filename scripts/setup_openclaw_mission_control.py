#!/usr/bin/env python3
"""Replicate the OpenClaw Mission Control structure in Notion.

Source of truth: `OpenClaw Prompts.pdf` (Lonely Octopus), specifically the
"Mission Control Builder" prompt which defines a 7-screen Mission Control
app. We materialize that spec as a Notion page tree, plus a reference
library of the other 8 prompts from the same PDF.

Tree created (under the existing 🪖 Mission Control parent page):

    🪖 Mission Control                 (existing)
    ├─ 🎯 Mission Control Screens      (NEW sub-parent)
    │  ├─ 📋 Tasks
    │  ├─ 📅 Calendar
    │  ├─ 🚀 Projects
    │  ├─ 🧠 Memory
    │  ├─ 📄 Docs
    │  ├─ 👥 Team
    │  └─ 🏢 Visual Office
    └─ 📜 OpenClaw Prompts Library     (NEW sub-parent)
       ├─ 🖥 Hardware Selector
       ├─ 🧙 Setup Wizard
       ├─ 👤 About Me
       ├─ 🎨 Mission Control Builder
       ├─ 📝 Project Brief
       ├─ 🤖 Multi-Agent Framework
       ├─ 📔 Note Taking
       ├─ 📚 Karpathy LLM Wiki
       └─ 🔒 Security Audit

Each page is pre-populated. Page bodies use `markdown_to_blocks` so they
render as native Notion content (headings, lists, code blocks) rather
than monospace dumps. All created page ids are persisted in
`.notion_bridge_state.json` under `openclaw_pages` so the script is
re-run-safe.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Optional

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from src.config import build_client, load_config  # noqa: E402
from src.markdown_to_notion import chunk_blocks, markdown_to_blocks  # noqa: E402
from src.openclaw_screens_sync import (  # noqa: E402
    link_tasks_page_to_command_center,
    sync_openclaw_screens,
)
from src.state_store import StateStore  # noqa: E402


# ---- Screen specs (from the PDF Mission Control Builder prompt) -----------

SCREENS: list[tuple[str, str, str]] = [
    (
        "tasks",
        "📋 Tasks",
        """# Tasks

Task board for me and my agent. The agent picks up assigned tasks on
every heartbeat. I see backlog / in-progress / done so I always know
what my agent is actually doing.

## Source data
- `~/WarRoom/HANDOFFS.md` (live, mirrored from the Notion Command Center DB)
- `~/.openclaw/workspace/` task files
- The bridge state file's `pages` map

## Columns
- **Backlog** — Notion `Pending` / War Room `PENDING`
- **In progress** — Notion `In Progress` / War Room `IN PROGRESS`
- **Blocked** — Notion `Blocked` / War Room `BLOCKED`
- **Done** — Notion `Completed` / War Room `COMPLETED`

## Acceptance
- Adding a card in Notion appears in the backlog within one bridge tick.
- Marking a War Room handoff `COMPLETED` moves the card to Done with
  the result summary populated.
""",
    ),
    (
        "calendar",
        "📅 Calendar",
        """# Calendar

Every cron job and scheduled task the agent has set up. Proves
proactivity, catches the cases where the agent said it scheduled
something but didn't.

## Source data
- Local crontab (`crontab -l`) and systemd timers
- `~/.openclaw/workspace/cron.json` or equivalent agent scheduling file
- Agent-emitted "scheduled X for Y" events in `~/WarRoom/HANDOFFS.md`

## Display
- Daily / weekly / monthly views
- One row per recurring task with next-fire timestamp
- Flag drift: schedule promised vs. cron actually installed
""",
    ),
    (
        "projects",
        "🚀 Projects",
        """# Projects

Every project I'm working on, with progress. Hooks tasks, memories,
and docs to each project so I can ask "what moves Project X forward
today?"

## Source data
- Notion Command Center DB rows grouped by `Parent Task` relation
- `~/WarRoom/KnowledgeBase/` directories per project
- `MEMORY.md` entries tagged with project name

## Acceptance
- Each project page shows its open tasks, recent memories, and linked docs.
- "What moves Project X forward today?" returns a short list pulled
  from the current backlog + agent suggestions.
""",
    ),
    (
        "memory",
        "🧠 Memory",
        """# Memory

Journal-style view of daily memory files plus long-term memory.
Searchable.

## Source data
- `~/.claude/projects/.../memory/MEMORY.md` and daily entries
- `~/WarRoom/SHARED_MEMORY.md`
- Per-agent USER.md / SOUL.md / AGENTS.md

## Display
- Timeline (newest first) for daily memory
- Tag/topic facets for long-term entries
- Full-text search
""",
    ),
    (
        "docs",
        "📄 Docs",
        """# Docs

Every doc the agent has written (newsletters, content briefs,
research summaries), indexed and searchable.

## Source data
- `~/WarRoom/KnowledgeBase/**/*.md`
- Per-agent output directories
- The bridge's `kb_pages` state for what's already published to Notion

## Acceptance
- A new markdown file dropped into KnowledgeBase appears here
  automatically.
- Search hits link directly to the local file AND the Notion mirror.
""",
    ),
    (
        "team",
        "👥 Team",
        """# Team

Agents, subagents, roles, org structure, mission statement.

## Source data
- `~/WarRoom/AGENT_ROLES.md`
- `~/WarRoom/PROTOCOL.md`
- `AGENTS.md` per project workspace

## Display
- Org chart (chief of staff routes work to specialists)
- Per-agent profile card: role, model tier (flagship / mid / lightweight),
  local-vs-cloud, monthly cost estimate, privacy posture
- Mission statement at the top, always visible
""",
    ),
    (
        "visual_office",
        "🏢 Visual Office",
        """# Visual Office

2D pixel-art office showing agents at their desks when working, away
when idle. The "delight" screen — the one a judge remembers.

## Source data
- Live `last_synced_at` timestamps per agent in the bridge state
- Currently-running handoffs (status = IN PROGRESS) per Owner
- An idle-decay timer for agents that haven't acted in N minutes

## Display
- Top-down pixel grid: one desk per agent
- Agent sprite at desk when their last activity is within N minutes
- Agent leaves the office when idle; returns on the next action
- Optional chat-bubble showing the current task title for active agents
""",
    ),
]


# ---- OpenClaw Prompts Library (from the PDF) ------------------------------

PROMPTS: list[tuple[str, str, str]] = [
    (
        "hardware_selector",
        "🖥 Hardware Selector",
        """# Hardware Selector Prompt

> Paste to AI chatbot then feed results to OpenClaw.

I want help figuring out which hardware to use for running OpenClaw
(a local AI agent system that runs 24/7 and lets you build personal
agents that talk to you on Discord, iMessage, etc.).

## HARD RULES — never violate

1. The host machine must be a DEDICATED, ALWAYS-ON machine, separate
   from my daily driver. A daily-driver MacBook, work laptop, or main
   desktop does NOT count, no matter how powerful.
2. For new purchases: 32GB RAM minimum, always. OpenClaw runs an agent
   loop with context windows, MCP servers, and long-running processes —
   16GB ages badly and forecloses local models. Spare hardware with
   <32GB is fine to repurpose (don't waste what you own — it can still
   run a hybrid cloud + small local model setup).
3. Ask first, recommend second. Once you give a verdict, the question
   phase is over. No follow-up multiple-choice questions after
   recommending.
4. Don't push spending. If they have spare hardware that fits, that's
   the answer. If they don't, default to the cheapest viable option.

Ask questions ONE AT A TIME, wait for each answer. Use multiple choice.
Don't ask about budget if Q1 makes it irrelevant.

## Questions

**Q1 (always): Spare hardware.** Do I have a SECOND machine I can leave
running 24/7 as a dedicated agent host?
- A) Yes, **<32GB RAM** (any form factor — fine for cloud APIs + small
  local models for lightweight tasks)
- B) Yes, **32GB+ RAM** (works for mid-size local models too)
- C) Yes, a spare **Apple Silicon Mac** (unified memory punches above
  its weight — even 16GB runs small local models alongside cloud APIs)
- D) No

→ If A, B, or C: skip to Q4. Don't ask about budget. The answer is
"use what you have." → If D: continue to Q2.

**Q2 (only if Q1 = D): Spending preference.** Pay-as-you-go monthly,
or one-time hardware spend?
- A) Pay-as-you-go — $5–20/mo VPS, no commitment
- B) One-time spend — ~$800–1,400 for a 32GB Mac Mini, minimize
  monthly costs forever
- C) Power user — $2,000–4,000+ for Mac Studio or DGX Spark,
  frontier-class local models
- D) Not sure — recommend based on the rest of my answers

**Q3 (only if Q1 = D AND Q2 = A or D): Local vs. cloud.**
- A) Cloud APIs are fine
- B) Local only (full privacy)
- C) Hybrid — local for sensitive, cloud for heavy lifting

If Q3 = B and Q2 = A, FLAG THE CONFLICT: local-only needs hardware
capable of running models, which is incompatible with pay-as-you-go.

**Q4 (always): Technical comfort.**
- A) Very comfortable — terminal is home turf
- B) Comfortable enough — can follow guides
- C) Simplest path — plug-and-play

## RECOMMENDATION FORMAT

1. **One-line verdict** ("Use your spare Mac. $0 upfront." / "Buy a
   32GB Mac Mini.")
2. **2-3 sentences max on why** — tied to my specific answers.
3. **If buying:** include RAM tier (32GB+ minimum) and local-vs-cloud
   strategy as one short paragraph or 3-line bullet block.
4. **One sentence acknowledging the alternative** if there's a
   legitimate case (e.g., spare Mac owner who's excited about local
   frontier models). Skip if not relevant.
5. **End with an open question handing control back to me** — "Want
   me to walk through setup, or think through [alternative] first?"
   NOT a new survey question.

## DO NOT

- Recommend a new purchase with <32GB RAM. Hard rule.
- Frame <32GB spare hardware as "cloud-API only" — it supports hybrid
  (cloud APIs + small local models like Llama 3.2 3B, Phi-3, Qwen 2.5
  7B quantized).
- Include RAM tiers or local-vs-cloud strategy when the recommendation
  is "use your spare hardware" — that's a downstream conversation.
- Add diagnostic commands, install commands, or setup steps. Wait
  until I confirm and ask.
- Add "while you wait, install Homebrew/Ollama" — don't seed work I
  didn't ask for.
- Ask additional multiple-choice questions after the verdict.
- Mention SSH unless the path is VPS (Mac/laptop users can just open
  Terminal locally).

## THE FOUR OPTIONS

- **Repurpose spare hardware** ($0) — Q1 = A/B/C. No RAM floor for
  spare; even <32GB supports hybrid.
- **VPS** ($5–20/mo, Hetzner/DigitalOcean) — Q1 = D + Q2 = A. Needs
  Q4 = A or B. If Q4 = C, push to Mac Mini.
- **Mac Mini, 32GB+** (~$800–1,400) — Q1 = D + Q2 = B (or Q4 = C).
  Never the 16GB base model.
- **Mac Studio or DGX Spark** ($2,000–4,000+) — Q1 = D + Q2 = C.

## NEW-HARDWARE PERMISSION

If the user has spare hardware but their answers suggest genuine
enthusiasm for buying new (e.g., they bring up Mac Studio/DGX
themselves, or want frontier local models), don't dismiss that.
Default to "use the spare," but the alternative-acknowledgment
sentence should validate that buying new is also reasonable — they're
not wrong to want it, the spare is just the financially conservative
call.

Be opinionated. Don't hedge.
""",
    ),
    (
        "setup_wizard",
        "🧙 Setup Wizard",
        """# OpenClaw Setup Wizard Prompt

> Paste to AI chatbot then feed results to guide your openclaw setup.

I'm about to run `openclaw onboard` to set up OpenClaw. Help me figure
out the right answer for each question the wizard asks.

Ask me 4-6 questions, ONE AT A TIME, then give me a complete cheat
sheet of answers in the exact order the wizard asks them.

## CRITICAL CONTEXT

OpenClaw runs 24/7 as a background service. The machine running
OpenClaw must be a DEDICATED, ALWAYS-ON machine — not a daily-driver
laptop that gets closed, carried around, or restarted. If I mention
running this on my main laptop, push back and recommend I either
(a) leave it permanently plugged in and never close the lid, or (b)
use a Mac Mini, Mac Studio, dedicated mini PC, or VPS instead.

## Questions to ask me (one at a time)

1. **Are you in a region where Anthropic or OpenAI APIs are blocked or
   unavailable?** (e.g., mainland China, Russia, Iran, North Korea,
   Cuba, Syria) — Yes / No / Not sure
2. **Do you already have an active ChatGPT Plus / Pro / Team
   subscription you'd like to use via OpenAI Codex OAuth?** (Yes — use
   my OpenAI sub / No — I'll use Anthropic API / No — I'll use
   something else) *Skip this question if Q1 = Yes.*
3. **(Only if Q1 = Yes)** How much RAM does your always-on machine
   have? (32GB+ / Less than 32GB / Not sure)
4. **Where do you want your agent to talk to you?** (Telegram —
   easiest / Discord / WhatsApp / Slack / iMessage / Signal / I'll
   set it up later)
5. **Do you want web search enabled, and are you willing to grab a
   free Brave API key (2 minutes)?** (Yes, I'll grab a Brave key for
   best quality / No, give me a key-free option / Skip web search for
   now)
6. **Are there any specific integrations you know you want from day
   one?** (Apple Notes / Obsidian / 1Password / Notion / Voice
   transcription / None — keep it minimal)

## CHEAT SHEET ORDER

1. **"I understand this is personal-by-default and shared/multi-user
   use requires lock-down. Continue?"** → Yes.
2. **QuickStart vs Advanced** → ALWAYS QuickStart. The defaults are
   correct for ~99% of users, including power users. Advanced just
   adds extra prompts (bind address variants, auth mode tweaks,
   runtime selection) that don't change the outcome for most people.
3. **Model/auth provider** — Decide based on Q1, Q2, Q3:
   - If Q1 = No AND Q2 = Yes (has OpenAI sub): Pick OpenAI Codex
     (OAuth in browser). Uses their existing subscription, no extra
     cost.
   - If Q1 = No AND Q2 = No: Pick Anthropic (Claude CLI + API key).
     Set this up now to get running fast.
   - If Q1 = Yes AND Q3 = 32GB+: Pick Ollama (local). No
     API-blocked-region issues.
   - If Q1 = Yes AND Q3 = <32GB or unsure: Pick OpenRouter or direct
     MiniMax — MiniMax API works from blocked regions and is cheap
     ($10–30/mo).
4. **Filter models by provider** — Accept default "All providers"
   unless they want to lock in to a specific provider's models only.
5. **Default model** — Match the provider:
   - Anthropic: Claude Opus primary, Sonnet backup. ⚠️ Be very clear
     this is the API, expensive ($50–1,000+/month). Set up now,
     switch to local/MiniMax later.
   - OpenAI Codex: Accept default (GPT-5 / latest).
   - Ollama: Qwen Coder 32B if 32GB+ RAM, GLM Flash if less.
   - MiniMax/OpenRouter: MiniMax primary, Qwen Coder backup.
6. **Paste API key (or OAuth)** — Anthropic: console.anthropic.com.
   OpenAI Codex: OAuth in browser. MiniMax: their developer console.
7. **Select channel (QuickStart)** — Match Q4. Telegram is marked
   recommended/newcomer-friendly — easiest to set up. If "I'll set it
   up later," pick "Skip for now."
8. **Channel credentials** — Telegram: bot token from @BotFather.
   Discord: bot token from discord.com/developers. Wizard walks you
   through.
9. **Web search provider** — Brave if they have/will grab a Brave key.
   Existing key (Tavily, Serper, etc.) works. Otherwise DuckDuckGo —
   fastest key-free. Fall back to Ollama Web Search only if DuckDuckGo
   isn't in the wizard list (requires Ollama signin).
10. **Enable hooks?** — Turn ON `session-memory` AND `command-logger`.
    Skip `boot-md` and `bootstrap-extra-files` unless you know what
    they're for.
    - `session-memory` ON: Saves context to memory on /new or /reset.
      What makes a 24/7 agent actually feel 24/7.
    - `command-logger` ON: Logs every command. Critical for debugging
      — paste the log into Claude/ChatGPT/Cursor and ask "why did this
      fail?"
11. **Install missing skill dependencies** — Match Q6. If specific
    integrations, select only those. If "None — keep it minimal," pick
    `Skip for now`. Add later.
12. **Per-skill API keys** (Google Places, Notion, Whisper, ElevenLabs)
    — Say `No` to all on first run unless 100% sure. Add later via
    `openclaw configure`.
13. **Shell completion** — Accept the default. Run `source ~/.zshrc`
    after the wizard finishes if prompted.
14. **Daemon install (--install-daemon)** — YES, ALWAYS YES. Most
    critical decision. Without this, the agent stops when you close
    the terminal.

After the cheat sheet, end with: "Run `openclaw onboard` now and
follow this list. If anything doesn't match what's on your screen,
paste the question back to me and I'll help."

Be opinionated. Don't list options without picking one. For the model
recommendation: don't bury the lede on cost. Anthropic API
(Opus + Sonnet) is the best agentic experience but it's expensive —
make the path clear: **start here now, switch to cheaper later.**

REMINDER ON ALWAYS-ON: If they're running this on a laptop they use
day-to-day, the agent will not be reliably available. Mention this
once near the start and move on — don't lecture.
""",
    ),
    (
        "about_me",
        "👤 About Me",
        """# About Me Prompt

> Paste to AI chatbot then feed results to OpenClaw.

Give me a detailed description about me, my preferences, and my
working style.
""",
    ),
    (
        "mission_control_builder",
        "🎨 Mission Control Builder",
        """# Mission Control Builder

> Paste to AI chatbot then feed results to OpenClaw.

I want to build my own Mission Control dashboard for my OpenClaw
agent — a single web interface that lets me see and control everything
my agent is doing. Help me create a project brief.

I'm going to paste reference screenshots showing the visual style I'm
inspired by. Look at them carefully — the brief you write should
reference what you actually see (colors, layout, type treatment, agent
character design, status indicator patterns) rather than my secondhand
description of them.

Ask me 5 questions, ONE AT A TIME, and wait for my answer before
asking the next. After my answers, generate a project brief I'll paste
to my OpenClaw agent (or to Claude Code / Cursor / another coding
tool).

## The Mission Control is a Next.js app on localhost. It can include up to 7 screens:

1. **Tasks** — Task board for me and my agent. Agent picks up assigned
   tasks on every heartbeat. I see backlog / in-progress / done so I
   always know what my agent is actually doing.
2. **Calendar** — Every cron job and scheduled task the agent has set
   up. Proves proactivity, catches the cases where it said it
   scheduled something but didn't.
3. **Projects** — Every project I'm working on, with progress. Hooks
   tasks, memories, and docs to each project so I can ask "what moves
   Project X forward today?"
4. **Memory** — Journal-style view of daily memory files plus
   long-term memory. Searchable.
5. **Docs** — Every doc the agent has written (newsletters, content,
   briefs), indexed and searchable.
6. **Team** — Agents, subagents, roles, org structure, mission
   statement.
7. **Visual Office** — 2D pixel-art office showing agents at their
   desks when working, away when idle.

## The 5 questions to ask me

1. **Which screens matter most to me right now?** Pick top 3-5 to
   build first.
2. **What does my agent crew look like?** How many agents, names,
   roles, and is there a "chief of staff" routing work?
3. **What's my mission statement?** One or two sentences on what the
   whole system is FOR. If I'm not sure, ask me 3 follow-ups and
   synthesize one.
4. **Visual style — match the inspiration screenshots or go custom?**
   - Match the screenshots I pasted (you should describe back what
     you actually see so I can confirm)
   - Match the vibe but with my own color palette / motif (specify)
   - Different style entirely (Linear / Notion / brutalist /
     glassmorphism / specify)
5. **Which integrations do I need on day one?** Discord webhook,
   Obsidian sync, Google Calendar, GitHub, file system watcher for
   docs, or none — keep it self-contained.

## After my answers, write a project brief for the agent

Treat it as a brief for a smart collaborator, not a spec for a junior
dev. Format:

- **Project name** (short, evocative)
- **What we're building** (3-5 sentences on the intent — what this is
  for and what it should feel like to use)
- **Why it matters** (1-2 sentences on the human problem — so the
  agent has context for tradeoffs)
- **Screens to build first** (the ones I picked, with one sentence per
  screen on what each should accomplish — NOT a feature list)
- **Agent crew + mission statement** (from my Q2 and Q3 answers)
- **Visual direction** (from Q4 — describe the vibe and key reference
  details from the actual screenshots, leave the rest open to the
  agent's design judgment)
- **Integrations** (from Q5)
- **Use REAL OpenClaw data from day one** — explicitly tell the
  agent: do not build with mock data. The dashboard should pull from
  the actual OpenClaw workspace files (`~/.openclaw/workspace/`,
  `memory/YYYY-MM-DD.md` daily logs, `MEMORY.md`, `USER.md`,
  `AGENTS.md`, the `openclaw.json` config for cron jobs, the agent's
  actual task and doc files). The whole point of Mission Control is
  that it reflects the live state of the agent. Mock data defeats
  the purpose. Discover what data exists in the workspace first, then
  build the screens around what's actually there.
- **Tech stack** — Next.js (App Router) + Tailwind + shadcn/ui as the
  base; runs on localhost; SQLite or filesystem-only state (whichever
  the agent thinks is right); reads/writes to the same workspace as
  OpenClaw.
- **What I'm NOT going to specify** — One short paragraph telling the
  agent that the data model, component structure, exact visual
  treatment, file organization, and screen layouts are its call. It
  should make smart decisions and ask me about anything genuinely
  ambiguous.
- **Process I want** — 1. First, explore the OpenClaw workspace and
  tell me what real data is available for each screen I picked. 2.
  Ask any clarifying questions. 3. Propose a phased build plan and
  wait for approval. 4. Build phase 1 wired to real data. 5. Show me,
  get feedback, iterate. 6. Move to phase 2.

End with: "Paste this brief to your agent along with the inspiration
screenshots. The first reply should be (a) a description of what the
agent found in your workspace, and (b) clarifying questions or a
phased plan — not finished code."

Be opinionated about the recommendation. Don't make me pick from a
menu of stack options. But the brief itself should leave room for the
agent to design.
""",
    ),
    (
        "project_brief",
        "📝 Project Brief",
        """# Project Brief Prompt

> Paste to AI chatbot then feed results to OpenClaw.

I want to figure out my first OpenClaw project — something my agent
can start building that will actually make my daily life better. Help
me decide what to build, then write a project brief I'll hand to my
agent.

Ask me 4 questions, ONE AT A TIME, and wait for my answer before
asking the next. After my answers, do TWO things:

1. Recommend ONE specific project for me, with a clear reason why it
   fits my life right now.
2. Write a project brief I'll paste to my OpenClaw agent so it can
   build it.

## The 4 questions

1. **What's the most annoying recurring task or moment in my week
   right now?** Examples:
   - Inbox is overwhelming every morning
   - WhatsApp messages pile up and I forget to reply
   - I keep missing or being unprepared for meetings
   - I never know where my money is going
   - I lose track of comments/replies on my content
   - My calendar is chaos
   - Something else (describe in my own words)

2. **What does my morning look like, and what would I love to wake up
   to?**
   - I want a brief that catches me up on overnight stuff
   - I want a clear "here's what to do today" plan
   - I want my inbox/messages already triaged
   - I want something delightful that's not work-related
   - I want progress on a personal goal (learning, fitness, money)

3. **What data does my agent already have access to?** (Pick all that
   apply)
   - Email (Gmail, Outlook)
   - Calendar (Google Calendar, etc.)
   - Messaging (WhatsApp, Telegram, Discord, iMessage)
   - Financial accounts (bank, brokerage)
   - Content platforms (YouTube, Substack, social)
   - Health/fitness apps
   - Notes/docs (Notion, Obsidian, Apple Notes)
   - None of these yet — I need to set things up first

4. **How ambitious should this first build be? Small, medium, or
   large?**
   - Small — one daily message that surfaces something useful
   - Medium — a small dashboard or multi-step daily ritual
   - Large — a full mini-app with multiple integrations

## 9 proven starter project shapes

If I'm stuck:
- **Investor brief** — Scan overnight news affecting top 10 holdings,
  summarize, flag earnings/events in next 7 days.
- **WhatsApp triage** — Read unread WhatsApp, draft replies in my
  voice, group by urgency for one-tap morning send.
- **Calendar defender** — Look at tomorrow's calendar, flag
  conflicts/double-bookings/unprepped meetings, suggest reschedules.
- **Appointment scheduler** — Anyone emailing to schedule, propose 3
  time slots based on calendar/energy patterns, draft the reply.
- **Founder dashboard** — Yesterday vs. today on key metrics, surface
  one anomaly worth attention.
- **Inbox executor** — Read overnight emails, auto-archive
  newsletters, draft replies for important threads, flag what needs me
  to think.
- **Budget pulse** — Track spending across categories over 30/60/90
  days, surface trends I haven't noticed, suggest one habit worth
  changing.
- **Comment radar** — Cluster every comment on my last 5 videos into
  buckets, surface the one most worth replying to.
- **Learning loop** — Daily language practice using vocab from
  yesterday's mistakes, with audio. I reply with translations to grade
  myself.

## After my answers

**Step 1 — Recommend one project.** Pick the single best fit based on:
- The annoyance I named (Q1) — directly addresses it
- The morning experience I want (Q2) — delivers it
- The data I actually have (Q3) — uses what's already connected
- The ambition I want (Q4) — small / medium / large

If my Q1 answer doesn't map to any of the 9 starter shapes, propose a
custom one. Don't force-fit.

**Step 2 — Write the project brief.** Treat it as a *brief for a smart
collaborator*. Format:

- **Project name** (short, evocative)
- **What it should do** (2-4 sentences describing in plain English —
  the *intent*, not the implementation)
- **Why it matters to me** (one or two sentences on the human problem
  this solves)
- **Where it should show up in my life** (which channel/surface,
  roughly when — but leave format and structure open for the agent to
  design)
- **Data it should draw on** (the integrations from Q3 that are
  relevant)
- **Build size** (small / medium / large — based on Q4)
- **Constraints** (under $5/month to run, must run autonomously,
  internal only)
- **What I'm NOT going to specify** (one short paragraph telling the
  agent that the exact format, schedule, edge cases, and visual
  treatment are its call — it should make the smart decisions and ask
  me about anything genuinely ambiguous)
- **Process I want** (1. ask me any clarifying questions before
  starting, 2. propose your plan and I'll approve, 3. build it,
  4. test once before scheduling, 5. log what you did to memory)

Be opinionated about the recommendation. Don't make me pick between
three options — pick ONE and own the call.

End with: "Paste the brief to your OpenClaw agent. Let it ask its
questions and propose a plan before it builds anything. The first
reply should be questions or a plan, not finished code."
""",
    ),
    (
        "multi_agent_framework",
        "🤖 Multi-Agent Framework",
        """# Multi Agent Framework

> Paste directly to openclaw.

Design and build a multi-agent crew.

You already know me — my work, projects, recurring patterns, and
what's automated. Use what's in MEMORY.md, USER.md, daily memory
files, and the workspace.

## Steps

1. Audit the workspace. Tell me what you found.
2. Ask me only what you can't figure out (likely hardware, budget,
   naming preferences). Max 3-5 questions, one at a time.
3. Propose a crew of 3-7 specialists. For each: name, role, model
   tier (flagship / mid / lightweight), specific model recommendation
   (e.g. Claude Opus, Sonnet, Haiku, Qwen Coder, GLM Flash, local
   Gemma), local or cloud, cadence. Estimate monthly cost. Flag what
   stays local for privacy.
4. Wait for my approval.
5. Build ONE agent end-to-end. Prove it works. Then come back.
6. Repeat for the next.

## Principles

- Match model to job difficulty (don't waste flagship on routine work).
- Push lightweight tier to local where hardware allows.
- Privacy-sensitive work stays local.
- Coordinate through workspace files — no exotic protocols.

Start with the audit. No code yet.
""",
    ),
    (
        "note_taking",
        "📔 Note Taking",
        """# Note Taking To Improve Memory

> Paste directly to openclaw.

Update your SOUL.md and AGENTS.md so obsessive documentation is part
of your identity: log everything you do, and save every document,
report, or artifact you produce so it can be revisited later.
""",
    ),
    (
        "karpathy_llm_wiki",
        "📚 Karpathy LLM Wiki",
        """# Karpathy LLM Wiki To Improve Memory

> Paste directly to openclaw.

Create an implementation plan of Karpathy's LLM Wiki idea to improve
your memory.

Reference: https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f
""",
    ),
    (
        "security_audit",
        "🔒 Security Audit",
        """# Security Audit

> Paste directly to openclaw.

Use <INSERT AGENT NAME> to run a security audit based on this
documentation: https://docs.openclaw.ai/gateway/security

Run it at 11pm everyday and report back to #alerts channel.
""",
    ),
]


# ---- Page-tree helpers ----------------------------------------------------


def _ensure_sub_parent(client, parent_id: str, key: str, title: str, intro: str, store: StateStore) -> str:
    state = store.load()
    pages = state.setdefault("openclaw_pages", {})
    existing = pages.get(key, {}).get("page_id") if isinstance(pages.get(key), dict) else None
    if existing:
        print(f"[skip] {title}: {existing}")
        return existing

    print(f"[create] {title} ...")
    response = client.create_page(
        parent_page_id=parent_id,
        title=title,
        children=[
            {
                "type": "paragraph",
                "paragraph": {"rich_text": [{"type": "text", "text": {"content": intro}}]},
            }
        ],
    )
    page_id = response.get("id")
    if not page_id:
        raise RuntimeError(f"create_page returned no id for {key}")
    state = store.load()
    state.setdefault("openclaw_pages", {})[key] = {"page_id": page_id}
    store.save(state)
    print(f"[ok]   {title}: {page_id}")
    return page_id


def _ensure_content_page(
    client,
    parent_id: str,
    key: str,
    title: str,
    body_markdown: str,
    store: StateStore,
) -> Optional[str]:
    state = store.load()
    existing = state.get("openclaw_pages", {}).get(key, {}).get("page_id")
    if existing:
        print(f"[skip] {title}: {existing}")
        return existing

    print(f"[create] {title} ...")
    response = client.create_page(parent_page_id=parent_id, title=title)
    page_id = response.get("id")
    if not page_id:
        raise RuntimeError(f"create_page returned no id for {key}")

    blocks = markdown_to_blocks(body_markdown)
    for chunk in chunk_blocks(blocks, chunk_size=100):
        client.append_block_children(page_id, chunk)

    state = store.load()
    state.setdefault("openclaw_pages", {})[key] = {"page_id": page_id}
    store.save(state)
    print(f"[ok]   {title}: {page_id} ({len(blocks)} blocks)")
    return page_id


def main() -> int:
    env_file = REPO_ROOT / ".env"
    config = load_config(env_file=env_file if env_file.exists() else None)
    client = build_client(config)
    store = StateStore(config.warroom_path)

    mc_parent_id = store.load().get("mission_control_parent_id")
    if not mc_parent_id:
        print(
            "error: no mission_control_parent_id in state. "
            "Run scripts/setup_mission_control.py first."
        )
        return 1

    print("--- OpenClaw Mission Control replication ---")
    print(f"Parent: {mc_parent_id}\n")

    screens_parent = _ensure_sub_parent(
        client,
        mc_parent_id,
        "_screens_parent",
        "🎯 Mission Control Screens",
        "Seven Next.js screens defined by the OpenClaw Mission Control Builder "
        "prompt. Each child page below is the spec for one screen — describing "
        "the source data, display, and acceptance criteria.",
        store,
    )
    print()

    for key, title, body in SCREENS:
        _ensure_content_page(client, screens_parent, f"screen_{key}", title, body, store)
    print()

    prompts_parent = _ensure_sub_parent(
        client,
        mc_parent_id,
        "_prompts_parent",
        "📜 OpenClaw Prompts Library",
        "Reference library mirroring OpenClaw Prompts.pdf (Lonely Octopus). "
        "Each child page contains one ready-to-paste prompt.",
        store,
    )
    print()

    for key, title, body in PROMPTS:
        _ensure_content_page(client, prompts_parent, f"prompt_{key}", title, body, store)

    # Wire the Tasks page to the live Command Center database.
    db_id = (
        config.notion_command_center_database_id
        or config.notion_command_center_data_source_id
    )
    if db_id:
        if link_tasks_page_to_command_center(client, db_id, store):
            print("\n[ok]   Tasks page linked to Command Center database")
        else:
            print("\n[skip] Tasks page already linked to Command Center database")

    # Seed the 4 live screens with their first live snapshot.
    print("\nSeeding live data on Memory / Docs / Team / Calendar screens...")
    n = sync_openclaw_screens(client, config.warroom_path, store)
    print(f"[ok]   {n} screen(s) populated with live data")

    print("\n--- Done ---")
    print(f"Mission Control root: {mc_parent_id}")
    print(f"Screens parent:       {screens_parent}")
    print(f"Prompts parent:       {prompts_parent}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
