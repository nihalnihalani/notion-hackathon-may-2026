# @forge/agents

The four Forge sub-agents plus the Orchestrator. Schema Smith generates a `j` schema from a plain-English prompt; Tool Coder writes a TypeScript Worker against that schema; Inspector runs `tsc` and `ntn workers exec` inside a Vercel Sandbox and feeds failures back; Shipper deploys via `ntn workers deploy` and wires the resulting Custom Agent into the user's Notion workspace. The Orchestrator sequences these four under a Vercel Workflow DevKit DAG with retries and observable per-step state.

## Public API surface

- TBD
