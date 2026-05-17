/**
 * Notion Comments API.
 *
 * REST surface:
 *   POST   /v1/comments              ← add a comment (page or discussion)
 *   GET    /v1/comments              ← list comments for a block
 *
 * Reference: https://developers.notion.com/reference/comment-object
 *
 * Note: Notion requires *exactly one* of `parent.page_id` or `discussion_id`
 * on create — this is enforced server-side; we surface validation errors via
 * {@link NotionValidationError}.
 */

import { notionRequest } from './http.js';
import type {
  BlockId,
  NotionClientConfig,
  NotionComment,
  NotionPaginated,
  NotionRichText,
} from './types.js';

export type AddCommentParams =
  | {
      parent: { page_id: string };
      rich_text: NotionRichText[];
      discussion_id?: never;
    }
  | {
      discussion_id: string;
      rich_text: NotionRichText[];
      parent?: never;
    };

export function addComment(
  config: NotionClientConfig,
  params: AddCommentParams,
): Promise<NotionComment> {
  return notionRequest<NotionComment>(
    '/v1/comments',
    { method: 'POST', body: params },
    config,
  );
}

export function listComments(
  config: NotionClientConfig,
  blockId: BlockId,
  opts?: { start_cursor?: string; page_size?: number },
): Promise<NotionPaginated<NotionComment>> {
  const query: Record<string, string | number | undefined> = {
    block_id: blockId,
  };
  if (opts?.start_cursor !== undefined) query['start_cursor'] = opts.start_cursor;
  if (opts?.page_size !== undefined) query['page_size'] = opts.page_size;
  return notionRequest<NotionPaginated<NotionComment>>(
    '/v1/comments',
    { method: 'GET', query },
    config,
  );
}
