/**
 * Typed wrapper for creating Notion comments via the generic API escape hatch.
 *
 * The `ntn` CLI does not currently expose a dedicated `ntn comments create`
 * subcommand, so per `.agents/skills/notion-cli/SKILL.md` we shell out to:
 *
 *     ntn api v1/comments -d '{"parent":{"page_id":"…"},"markdown":"…"}'
 *
 * Two parent shapes are supported, mirroring the public API:
 *   - `{ parent: { page_id } }`        — top-level comment on a page
 *   - `{ parent: { discussion_id } }`  — reply inside an existing thread
 *
 * Anything more exotic (markdown attachments, rich_text fallback, batch
 * comment creation) should go through `callNotionApi('v1/comments', …)`
 * directly; this wrapper keeps the common case typed and validated.
 */

import { callNotionApi } from './api';
import { NtnInvalidArgumentError } from './errors';
import type { NtnRunOptions, PageId } from './types';

export interface CreateCommentInput {
  /** Page to attach a top-level comment to. Mutually exclusive with `discussionId`. */
  pageId?: PageId;
  /** Existing discussion thread to reply into. Mutually exclusive with `pageId`. */
  discussionId?: string;
  /** Comment body in Markdown. Must be non-empty. */
  markdown: string;
}

interface PageParentBody {
  parent: { page_id: string };
  markdown: string;
}

interface DiscussionParentBody {
  parent: { discussion_id: string };
  markdown: string;
}

type CommentBody = PageParentBody | DiscussionParentBody;

/**
 * Create a Notion comment via `ntn api v1/comments`.
 *
 * Validation rules (all surface as {@link NtnInvalidArgumentError}):
 *   - exactly one of `pageId` / `discussionId` must be provided
 *   - `markdown` must be a non-empty string
 *
 * The generic `T` is the parsed response shape; defaults to `unknown` so the
 * caller is forced to validate. `callNotionApi` returns `T | string`, but
 * with the default `parseJson: true` path the runtime value is always `T`,
 * so we narrow.
 */
export async function createComment<T = unknown>(
  input: CreateCommentInput,
  opts: NtnRunOptions = {},
): Promise<T> {
  const hasPage = typeof input.pageId === 'string' && input.pageId.trim().length > 0;
  const hasDiscussion =
    typeof input.discussionId === 'string' && input.discussionId.trim().length > 0;

  if (hasPage === hasDiscussion) {
    throw new NtnInvalidArgumentError(
      'createComment: exactly one of `pageId` or `discussionId` must be provided.',
    );
  }
  if (typeof input.markdown !== 'string' || input.markdown.trim().length === 0) {
    throw new NtnInvalidArgumentError(
      'createComment: `markdown` must be a non-empty string.',
    );
  }

  const body: CommentBody = hasPage
    ? { parent: { page_id: input.pageId as string }, markdown: input.markdown }
    : { parent: { discussion_id: input.discussionId as string }, markdown: input.markdown };

  const result = await callNotionApi<T>('v1/comments', {
    ...opts,
    data: body,
    parseJson: true,
  });
  return result as T;
}
