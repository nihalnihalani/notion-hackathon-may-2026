/**
 * Notion Blocks API.
 *
 * REST surface:
 *   PATCH  /v1/blocks/{id}/children   ← append children
 *   GET    /v1/blocks/{id}/children   ← list children (paginated)
 *   GET    /v1/blocks/{id}
 *   PATCH  /v1/blocks/{id}
 *   DELETE /v1/blocks/{id}
 *
 * Reference: https://developers.notion.com/reference/block
 */

import { notionRequest } from './http.js';
import type {
  BlockId,
  NotionBlock,
  NotionClientConfig,
  NotionPaginated,
} from './types.js';

export interface AppendBlocksResponse {
  object: 'list';
  results: NotionBlock[];
  next_cursor: string | null;
  has_more: boolean;
}

export interface ListBlockChildrenOpts {
  start_cursor?: string;
  page_size?: number;
}

/**
 * Block children sent to `append` are usually *creation* objects, not the
 * full {@link NotionBlock} shape we receive back. We accept both — Notion
 * ignores read-only fields on input — but document the relaxed type so
 * callers can pass `{ type: 'paragraph', paragraph: { rich_text: [...] } }`
 * without the read-only `id`/`created_time` etc.
 */
export type NotionBlockInput = Partial<NotionBlock> & { type: NotionBlock['type'] };

export function appendBlocks(
  config: NotionClientConfig,
  blockId: BlockId,
  children: NotionBlockInput[],
  opts?: { after?: BlockId },
): Promise<AppendBlocksResponse> {
  const body: Record<string, unknown> = { children };
  if (opts?.after !== undefined) body['after'] = opts.after;
  return notionRequest<AppendBlocksResponse>(
    `/v1/blocks/${blockId}/children`,
    { method: 'PATCH', body },
    config,
  );
}

export function getBlockChildren(
  config: NotionClientConfig,
  blockId: BlockId,
  opts?: ListBlockChildrenOpts,
): Promise<NotionPaginated<NotionBlock>> {
  const query: Record<string, string | number | undefined> = {};
  if (opts?.start_cursor !== undefined) query['start_cursor'] = opts.start_cursor;
  if (opts?.page_size !== undefined) query['page_size'] = opts.page_size;
  return notionRequest<NotionPaginated<NotionBlock>>(
    `/v1/blocks/${blockId}/children`,
    { method: 'GET', query },
    config,
  );
}

export function getBlock(
  config: NotionClientConfig,
  blockId: BlockId,
): Promise<NotionBlock> {
  return notionRequest<NotionBlock>(
    `/v1/blocks/${blockId}`,
    { method: 'GET' },
    config,
  );
}

/**
 * Patch a block. Body shape is the partial block — e.g. for a paragraph
 *   { paragraph: { rich_text: [...] } }
 * Notion enforces that only the matching `<type>` key may be present.
 */
export function updateBlock(
  config: NotionClientConfig,
  blockId: BlockId,
  patch: Partial<NotionBlock> | Record<string, unknown>,
): Promise<NotionBlock> {
  return notionRequest<NotionBlock>(
    `/v1/blocks/${blockId}`,
    { method: 'PATCH', body: patch },
    config,
  );
}

/** Notion's "delete" is a soft delete — the returned block has `in_trash: true`. */
export function deleteBlock(
  config: NotionClientConfig,
  blockId: BlockId,
): Promise<NotionBlock> {
  return notionRequest<NotionBlock>(
    `/v1/blocks/${blockId}`,
    { method: 'DELETE' },
    config,
  );
}
