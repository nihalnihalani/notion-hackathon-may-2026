# Forge API Documentation

> Placeholder — this file is the canonical home for Forge's external HTTP API
> surface (REST today, MCP-over-HTTP next). Each section below will be filled
> in as the corresponding route handlers land in `apps/web/app/api/**`.

## Authentication

How clients authenticate against the Forge API. Will cover:

- Clerk session cookies (browser clients)
- API keys per workspace (server-to-server / MCP clients)
- HMAC signatures (incoming Notion webhooks)
- Bearer tokens (internal admin endpoints, `FORGE_INTERNAL_TOKEN`)

## Endpoints

Versioned route inventory. Each endpoint will document path, method, auth
scheme, request schema, response schema, and rate-limit class.

- `POST /api/forge/run` — kick off the 4-agent pipeline for a Notion page
- `GET  /api/forge/run/:id` — poll pipeline status
- `GET  /api/healthz` — liveness probe
- `POST /api/mcp/*` — MCP tool calls
- (full list TBD)

## Errors

Standard error envelope shape and status code semantics. Will list every
machine-readable `code` Forge returns plus the HTTP status it pairs with.

## Webhooks

Inbound webhooks Forge accepts and outbound webhooks Forge emits.

- Inbound: `POST /api/webhooks/notion-button`, `POST /api/webhooks/notion-page-edit`,
  `POST /api/webhooks/clerk`, `POST /api/webhooks/stripe`
- Outbound: agent-run lifecycle events (delivered to user-configured URLs)
