# @forge/notion-client

Typed Notion REST wrapper for Forge studio use cases that the `ntn` CLI does not cover ergonomically: reading the live Forge page state, streaming Build Log block updates, mutating DB rows for the generated-agent registry, and posting comments on the Forge page (e.g., for sync-state reset confirmations).

## Public API surface

- Branded ids and API types: `PageId`, `BlockId`, `DatabaseId`,
  `WorkspaceId`, `NotionPage`, `NotionDatabase`, `NotionBlock`, and related
  rich-text/property types.
- Transport and pacing: `notionRequest`, `createPacer`, `DEFAULT_RETRY`,
  `DEFAULT_NOTION_VERSION`.
- Page/block/database operations: `createPage`, `getPage`, `updatePage`,
  `archivePage`, `appendBlocks`, `getBlockChildren`, `createDatabase`,
  `queryDatabase`, and related helpers.
- Comments/search/users: `addComment`, `listComments`, `search`, `getMe`,
  `getUser`, `listUsers`.
- Webhooks: `verifyNotionWebhookSignature`.
- Build Log helpers: `appendBuildLogEntry`, `clearBuildLog`,
  `keepRecentBuildLogEntries`, `buildLogBlock`, `buildLogRichText`.
- Rich-text builders: `plainText`, `paragraph`, `heading`, `code`, `callout`,
  `divider`, `bulletedListItem`, `numberedListItem`, `toDo`, `toggle`.
