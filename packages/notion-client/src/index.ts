/**
 * @forge/notion-client — typed Notion REST wrapper used by the Forge studio.
 *
 * Consumed by Vercel Functions, the installer, and the Build-Log streamer.
 * NOT consumed by generated agents — those use `@forge/connectors` or the
 * `ntn` SDK shim. Keeping the two surfaces split lets the studio cover the
 * full Notion REST while connectors stay minimal.
 *
 * Quickstart:
 *
 *   import {
 *     createPage, queryDatabase, appendBuildLogEntry,
 *     verifyNotionWebhookSignature, DEFAULT_NOTION_VERSION,
 *   } from '@forge/notion-client';
 *
 *   const config = {
 *     token: env.NOTION_TOKEN,
 *     pacer: createPacer({ allowedRequests: 3, intervalMs: 1000 }),
 *   };
 *
 *   const page = await createPage(config, {...});
 */

// ── Types ────────────────────────────────────────────────────────────────────
export type {
  NotionClientConfig,
  FetchLike,
  Logger,
  Pacer,
  RetryOptions,
  PageId,
  BlockId,
  DatabaseId,
  UserId,
  WorkspaceId,
  CommentId,
  PropertyId,
  NotionPage,
  NotionDatabase,
  NotionDatabasePropertySchema,
  NotionBlock,
  NotionBlockBase,
  NotionBlockType,
  NotionUser,
  NotionComment,
  NotionPropertyValue,
  NotionFormulaValue,
  NotionRichText,
  NotionTextContent,
  NotionAnnotations,
  NotionColor,
  NotionIcon,
  NotionParent,
  NotionPaginated,
} from './types.js';
export {
  DEFAULT_RETRY,
  DEFAULT_NOTION_VERSION,
  DEFAULT_BASE_URL,
  asPageId,
  asBlockId,
  asDatabaseId,
  asUserId,
  asWorkspaceId,
  asCommentId,
  asPropertyId,
} from './types.js';

// ── Errors ───────────────────────────────────────────────────────────────────
export {
  NotionError,
  NotionRateLimitError,
  NotionAuthError,
  NotionNotFoundError,
  NotionValidationError,
  NOTION_PROVIDER,
  errorFromNotionStatus,
} from './errors.js';

// ── HTTP transport (exposed for advanced callers / framework hooks) ──────────
export { notionRequest } from './http.js';
export type { NotionRequestInit } from './http.js';

// ── Pacer ────────────────────────────────────────────────────────────────────
export { createPacer } from './pacer.js';
export type { PacerOptions } from './pacer.js';

// ── Pages ────────────────────────────────────────────────────────────────────
export {
  createPage,
  getPage,
  updatePage,
  archivePage,
  getPageProperty,
} from './pages.js';
export type {
  CreatePageParams,
  UpdatePageParams,
  NotionPagePropertyInput,
  PagePropertyItemResponse,
} from './pages.js';

// ── Blocks ───────────────────────────────────────────────────────────────────
export {
  appendBlocks,
  getBlockChildren,
  getBlock,
  updateBlock,
  deleteBlock,
} from './blocks.js';
export type {
  AppendBlocksResponse,
  ListBlockChildrenOpts,
  NotionBlockInput,
} from './blocks.js';

// ── Databases ────────────────────────────────────────────────────────────────
export {
  createDatabase,
  getDatabase,
  updateDatabase,
  queryDatabase,
} from './databases.js';
export type {
  CreateDatabaseParams,
  UpdateDatabaseParams,
  QueryDatabaseOpts,
  NotionFilter,
  NotionSort,
} from './databases.js';

// ── Users ────────────────────────────────────────────────────────────────────
export { getMe, getUser, listUsers } from './users.js';

// ── Comments ─────────────────────────────────────────────────────────────────
export { addComment, listComments } from './comments.js';
export type { AddCommentParams } from './comments.js';

// ── Search ───────────────────────────────────────────────────────────────────
export { search } from './search.js';
export type { SearchParams, SearchResult } from './search.js';

// ── Webhooks ─────────────────────────────────────────────────────────────────
export { verifyNotionWebhookSignature } from './webhooks.js';
export type {
  VerifyWebhookInput,
  VerifyWebhookResult,
} from './webhooks.js';

// ── Build Log helpers ────────────────────────────────────────────────────────
export {
  appendBuildLogEntry,
  clearBuildLog,
  keepRecentBuildLogEntries,
  buildLogBlock,
  buildLogRichText,
} from './build-log.js';
export type { BuildLogEntry, BuildLogStatus } from './build-log.js';

// ── Rich-text / block helpers ────────────────────────────────────────────────
export {
  plainText,
  paragraph,
  heading,
  code,
  callout,
  divider,
  bulletedListItem,
  numberedListItem,
  toDo,
  toggle,
} from './rich-text.js';
