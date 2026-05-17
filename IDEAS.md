# All Candidates — 20+ Ideas, Statuses, One-Liners

> Status legend: 🏆 winner • 🥈 backup • ❌ eliminated • 💤 lower-priority

| ID | Name | One-liner | Theme | Status | Why (short) |
|---|---|---|---|---|---|
| **F** | **Forge** | Describe an agent in English in a Notion page → manager + 4 sub-agents (schema-writer / tool-coder / evaluator / deployer) ship a real Custom Agent in 90s | Relay + Autonomous (meta) | 🏆 | Hits 5/7 final judges, Notion-as-UI matches their launch shape, manager-of-agents matches "Token Town," judges-are-customers |
| **C** | **Triage Goblin** | GitHub issue webhook → live multi-agent collab inside a Notion page (router + root-causer + fixer + communicator) → drafts response + opens fix-PR + updates public roadmap | Relay + Autonomous | 🥈 | Notion's launch-demo shape, real pain (OSS), high floor, lower ceiling vs Forge |
| **C4** | **Standby (Live Incident Room)** | PagerDuty/Sentry webhook → spawns live incident room in Notion: comms templates, war-room agenda, impact estimator, status-page draft, autopostmortem skeleton | Relay + Autonomous | 🥉 | Same Notion-as-UI shape, SRE-flavored, hits Vercel CTO judge (Lakshmi, Andrew Qu) |
| A | Founder's War Room | Solo-founder Chief of Staff ingesting Stripe/GitHub/Linear/Sentry/email/Slack, drafts daily "what needs you" with approval gates | Relay | ❌ R1 | Literally the brief's example. 30 teams will pitch this. Brian Lovin already built it. |
| B | Postmortem Daemon | CI/Sentry webhook → multi-agent investigation → drafts postmortem + fix-PR | Relay + Autonomous | ❌ R1 | Demo is 3min of watching text appear. Boring TV. |
| D | Migration Buddy | Big red button: "Migrate me off Trello/Asana to Notion." Worker dumps source → rebuilds Notion DBs → verification sync | Chaos | ❌ R1 | Scope death (1 source done badly), no agent depth, GTM gift not Grand-Prize |
| E | Customer Signal Pipeline | Gong/Fathom webhook → pain-extractor + ticket-matcher → drafts follow-up email | Relay | ❌ R1 | Crowded space (Cresta, Gong itself), hard to demo without real Gong data |
| **A1** | Deploy the Butler | "Jeeves" persona maintains workspace hygiene — fixes broken links, archives stale pages, writes passive-aggressive concerns in Edwardian English | Chaos + Autonomous | ❌ R2 | Funny once, audience-favorite ceiling, persona writing is hard to demo in 3min |
| **A2** | Roast My Repo | "ROAST" button → Claude-as-comedian roasts your commit history in Notion + opens 3 real refactor PRs on GitHub | Chaos + Relay | ❌ R2 | "Claude as comedian" is 2024-vintage. Funny once. PR quality will be mid. Anthony Morris laughs politely then moves on. |
| **A3** | Therapy for Sentry | Stack traces routed to a "Therapy Session" Notion page → Claude-as-therapist gently asks the error about its childhood → real RCA + Linear ticket at the end | Chaos + Relay + Multimodal | ❌ R2 | Cute, two-tone risk (must be funny AND ship real artifact), niche |
| **A4** | The Oracle | Red button on any decision in a "Decisions" DB → Oracle persona consults workspace + Slack/Linear/Docs → returns prophetic verdict with citations | Chaos + Autonomous | 💤 | Demoable in 30s, real institutional-memory utility — kept as future-rollout extension of Forge |
| **A5** | Night Mode | At 11pm "Night Shift" persona takes over — closes stale tasks, drafts tomorrow's standup, files weekend bugs as Monday tickets, leaves coffee-shop-jazz briefing | Chaos + Autonomous | ❌ R2 | Requires clock-spoofing for demo (looks staged), trust risk if it reorganizes wrong |
| **B1** | Discovery Docket (lawyers) | Sync from Everlaw/Relativity → Notion DB with privilege flags, Bates ranges, witness mentions → on-demand chronologies | Relay + Autonomous | ❌ R2 | Real $$ pain, narrow audience — judges aren't litigators, hard to convey in 3min, legal accuracy disclaimer eats credibility |
| **B2** | Cut List (video editors) | Premiere/DaVinci XML or Frame.io → Notion DB of clips with shot type, transcripts → "build 60s cut" returns EDL | Multimodal + Relay | ❌ R2 | Video processing > 30s Worker timeout. Beautiful idea, wrong platform. |
| **B3** | Bookings (podcasters) | "Be on my podcast" form webhook → enriches guest from Twitter/LinkedIn/past appearances → pre-interview brief + 12 questions + scheduled in Calendar | Relay + Autonomous | 💤 | Real pain for podcast-host audience, but judges aren't podcasters |
| **B4** | Spawn Point (indie game devs) | Steam reviews + Discord bugs + crashes → Notion DB triaged "Skill issue / Real bug / Feature / Cope" → weekly patch-notes draft | Autonomous + Chaos | ❌ R2 | Funny ("Cope" category), niche, Steam likely not on outbound allowlist (kills it) |
| **C1** | Changelog Concierge | Merged PR → drafts user-facing changelog in product's voice → "Releases" Notion DB + screenshot diff → on approval, ships to changelog site + Slack + email | Relay (human approval) + Autonomous | ❌ R2 | Useful but boring demo. Linear ships this in a future release. Mike Vernal yawns. |
| **C2** | Brief.fm | Calendar sync → 30min before each meeting, generates one-page brief: attendee context, last interaction, open threads, suggested agenda | Autonomous | ❌ R2 | Borderline "meeting prep" — judges have seen 50 of these |
| **C3** | Receipts | Outbound webhook on "Done" → captures PR link + screenshot + metric delta → weekly "what I actually shipped" doc you can send your manager | Autonomous | 💤 | Real perf-review pain, evidence-capture must be visual — kept as future product, not the hackathon swing |
| **D1** | Voice → Ticket | Hold spacebar in any Notion page, ramble for 30s → fully-scoped Linear ticket appears with repro/severity/assignee guess | Multimodal + Relay | ❌ R2 | "Voice to structured X" is 2024 trope (Granola, Otter, Wispr). Single moment but genre-fatigued. |
| **D2** | Whiteboard → Schema | Photo of a whiteboard with boxes/arrows → Notion DB with relations pre-wired, sample rows, views | Multimodal + Chaos | ❌ R2 | Killer demo IF it works — but vision-on-marker-scrawl is brittle, weak product story (set up DB once, then what?) |
| **D3** | Screen Recording → Bug Report | Drop a Loom → Claude transcribes narration + extracts repro steps + captures UI screenshots → bug filed | Multimodal + Relay | ❌ R2 | Beats voice-to-ticket on input format but >30s Worker timeout on video frame analysis |
| **F2** | The Self-Healing OSS Project | CI fails on main → autonomous investigator + fixer + writer + announcer agents → fix-PR + changelog + roadmap update | Relay + Autonomous | ❌ R2 | Strong shape but cannibalizes Triage Goblin and is roughly Postmortem Daemon's twin; pick Triage Goblin as the cleaner OSS swing |
| **F3** | Manager-of-Agents (literal copy) | Replicate Notion's internal "Token Town" pattern — 30+ specialist agents managed by one supervisor that collapses to 5 daily notifications | Autonomous | ❌ R2 | Notion built this themselves. If you replicate, judges think "they already did this." If you extend, must pick a domain — Forge IS the extension. |

---

## Pool composition by theme

| Theme | Count | Notes |
|---|---|---|
| Autonomous Sidekick | 9 | Strong genre but easy to fall into "writes my standup" cliché |
| Workflow Relay | 11 | Best fit for Notion primitives (sync + webhook + tool) |
| Chaos Mode | 8 | High creativity-score upside, persona risk |
| Multimodal | 4 | 30s Worker timeout kills most video/photo plays |

## Pool composition by primitive coverage

| Primitive | Used in finalists |
|---|---|
| Workers runtime | F, C, C4 (all) |
| Custom Agent tools | F (heavily — it BUILDS them), C, C4 (light) |
| Webhooks (inbound) | C (GitHub), C4 (PagerDuty), F (deploy-success hooks) |
| Database sync | F (example generated) |
| ntn CLI | F (deploys via it) |
| Notion as UI surface | F, C, C4 (all — matches Notion's launch shape) |
