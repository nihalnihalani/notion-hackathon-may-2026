# Forge API Documentation

Forge exposes browser-authenticated REST routes for the dashboard, signed
webhooks for Notion-originated events, and stateless MCP-over-HTTP for
server-to-server agent creation.

## Authentication

- Clerk session cookies: dashboard pages and browser-originated REST calls.
- Workspace API keys: `Authorization: Bearer <key>` on `POST /api/mcp`.
- Notion webhook signatures: `POST /api/webhooks/notion-button` and
  `POST /api/webhooks/notion-page-edit`.
- Internal bearer token: `FORGE_INTERNAL_TOKEN` for private operational
  endpoints.

## Core Endpoints

| Method | Path                         | Auth           | Purpose                                                                                   |
| ------ | ---------------------------- | -------------- | ----------------------------------------------------------------------------------------- |
| `POST` | `/api/forge/trigger`         | Clerk session  | Queue a new generation from the dashboard. Body: `{ description, force?, notionRowId? }`. |
| `GET`  | `/api/forge/generations/:id` | Clerk session  | Read generation status, step trail, cost, latency, and errors.                            |
| `POST` | `/api/forge/cancel/:id`      | Clerk session  | Cancel an in-flight generation.                                                           |
| `POST` | `/api/forge/voice`           | Clerk session  | Convert voice input into a generation description.                                        |
| `POST` | `/api/forge/log`             | Internal token | Append an internal build-log/event entry.                                                 |
| `GET`  | `/api/healthz`               | Public         | Liveness and dependency summary for deploy smoke checks.                                  |

## Agent Endpoints

| Method   | Path                          | Auth          | Purpose                                                         |
| -------- | ----------------------------- | ------------- | --------------------------------------------------------------- |
| `GET`    | `/api/agents`                 | Clerk session | List active/paused agents for the workspace.                    |
| `GET`    | `/api/agents/:id`             | Clerk session | Read one generated agent.                                       |
| `DELETE` | `/api/agents/:id`             | Clerk session | Retract an agent.                                               |
| `POST`   | `/api/agents/:id/pause`       | Clerk session | Pause an agent.                                                 |
| `POST`   | `/api/agents/:id/resume`      | Clerk session | Resume a paused agent.                                          |
| `POST`   | `/api/agents/:id/redeploy`    | Clerk session | Queue a fresh generation from the agent's original description. |
| `GET`    | `/api/agents/:id/runs`        | Clerk session | List recent NTN worker runs.                                    |
| `GET`    | `/api/agents/:id/runs/:runId` | Clerk session | Fetch logs and metadata for a single NTN worker run.            |

## Settings And Billing

| Method         | Path                          | Auth          | Purpose                                                                                  |
| -------------- | ----------------------------- | ------------- | ---------------------------------------------------------------------------------------- |
| `PATCH`/`POST` | `/api/settings/default-model` | Clerk session | Persist `Workspace.defaultModel` (`auto`, `gpt-5.5`, `gpt-5.4-mini`, `claude-opus-4-7`). |
| `GET`/`POST`   | `/api/settings/api-keys`      | Clerk session | List or create MCP API keys.                                                             |
| `DELETE`       | `/api/settings/api-keys/:id`  | Clerk session | Revoke an MCP API key.                                                                   |
| `POST`         | `/api/settings/uninstall`     | Clerk session | Disconnect the workspace.                                                                |
| `GET`          | `/api/billing/usage`          | Clerk session | Read workspace usage-meter aggregates.                                                   |

## Webhooks

| Method | Path                             | Auth                 | Purpose                                                           |
| ------ | -------------------------------- | -------------------- | ----------------------------------------------------------------- |
| `POST` | `/api/webhooks/notion-button`    | Notion HMAC          | Queue a generation from the Forge button on a Notion request row. |
| `POST` | `/api/webhooks/notion-page-edit` | Notion HMAC          | Handle Notion page-edit events.                                   |
| `GET`  | `/api/auth/notion/callback`      | Clerk + Notion OAuth | Complete Notion OAuth and bind the workspace.                     |

## MCP

`POST /api/mcp` accepts stateless JSON-RPC requests authenticated with a
workspace API key. The server exposes:

- `forge_agent` — create a new Forge generation.
- `get_generation_status` — read generation status and step history.
- `list_my_agents` — list generated agents in the workspace.

## Error Envelope

REST routes return the shared shape:

```json
{
  "error": "validation",
  "message": "Invalid request body.",
  "details": {}
}
```

Common machine-readable errors are `unauthenticated`, `forbidden`,
`not_found`, `validation`, `rate_limited`, `upstream_failure`, and
`internal`.
