# @forge/installer

Idempotently bootstraps a Forge workspace: creates the Forge page, the Forge Requests DB, the generated-agent registry DB, the Build Log block, and any required Custom Agent stubs. Re-running on an already-installed workspace is a no-op (verifies existence via `ntn pages get`).

## Public API surface

- `installForgePage(options, db, logger?)` — create or verify the Forge page,
  Requests DB, Agents DB, Build Log, button block, and workspace webhook
  secret.
- `reconcileForgePage(options, db, logger?)` — repair missing blocks/databases
  on an existing install.
- `uninstallForgePage(options, db, logger?)` — remove Forge-owned Notion
  surfaces and clear workspace install metadata.
- `InstallerError` — typed failure for Notion or DB install failures.
- Block/database builders such as `buildRootPageInitialChildren`,
  `buildForgeRequestsDbSchema`, and `forgeAgentsDbSchema` for tests and
  reconciliation.
- `generateWorkspaceWebhookSecret()` — per-workspace webhook HMAC secret.
