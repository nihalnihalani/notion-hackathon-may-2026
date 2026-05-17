# @forge/ntn-wrapper

Typed, audit-logged wrapper around the `ntn` CLI. Covers `workers` (new/deploy/exec/list/get/delete/env/capabilities/runs/sync), `oauth` (start/token/show-redirect-url), `pages` (create/update/trash/get), `webhooks` (list), `datasources` (query/resolve), `files` (create/get/list), `doctor`, and `runs`. Every call goes through a single `execNtn` primitive that streams stdout/stderr, parses structured output, and surfaces non-zero exits as typed errors.

## Public API surface

- TBD
