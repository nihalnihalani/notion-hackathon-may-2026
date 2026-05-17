/**
 * Notion Search API.
 *
 * REST surface:
 *   POST   /v1/search
 *
 * Reference: https://developers.notion.com/reference/post-search
 *
 * Important caveats baked into this client:
 *  - Only `page` and `database` filter values are valid; we type the param
 *    accordingly so the studio cannot send an empty body that returns
 *    everything in the workspace (which would be a Bad Day).
 */

import { notionRequest } from './http.js';
import type {
  NotionClientConfig,
  NotionDatabase,
  NotionPage,
  NotionPaginated,
} from './types.js';

export interface SearchParams {
  query?: string;
  filter?: { value: 'page' | 'database'; property: 'object' };
  sort?: {
    direction: 'ascending' | 'descending';
    timestamp: 'last_edited_time';
  };
  start_cursor?: string;
  page_size?: number;
}

/** Notion can return either pages or databases in the same response. */
export type SearchResult = NotionPage | NotionDatabase;

/**
 * Search pages and databases across the workspace the integration can see.
 *
 * @param filter Optional. If omitted, both pages and databases are returned.
 *               We default the inner `property` to `'object'` (the only valid
 *               value) so callers only need to pass `{ value: 'page' }`.
 */
export function search(
  config: NotionClientConfig,
  params: {
    query?: string;
    filter?: { value: 'page' | 'database' };
    sort?: SearchParams['sort'];
    start_cursor?: string;
    page_size?: number;
  } = {},
): Promise<NotionPaginated<SearchResult>> {
  const body: Record<string, unknown> = {};
  if (params.query !== undefined) body['query'] = params.query;
  if (params.filter !== undefined) {
    body['filter'] = { property: 'object', value: params.filter.value };
  }
  if (params.sort !== undefined) body['sort'] = params.sort;
  if (params.start_cursor !== undefined) body['start_cursor'] = params.start_cursor;
  if (params.page_size !== undefined) body['page_size'] = params.page_size;
  return notionRequest<NotionPaginated<SearchResult>>(
    '/v1/search',
    { method: 'POST', body },
    config,
  );
}
