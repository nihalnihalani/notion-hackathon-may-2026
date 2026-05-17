/**
 * Notion Pages API.
 *
 * REST surface:
 *   POST   /v1/pages
 *   GET    /v1/pages/{id}
 *   PATCH  /v1/pages/{id}
 *   GET    /v1/pages/{id}/properties/{property_id}
 *
 * Reference: https://developers.notion.com/reference/page
 */

import { notionRequest } from './http.js';
import type {
  NotionBlock,
  NotionClientConfig,
  NotionIcon,
  NotionPage,
  NotionParent,
  NotionPropertyValue,
  PageId,
  PropertyId,
} from './types.js';

/** Properties may be passed as either the *value* shape (for update) or as
 *  the create-shape used when seeding a page in a database. We accept both
 *  through a permissive map and let Notion validate. */
export type NotionPagePropertyInput = Record<string, unknown>;

export interface CreatePageParams {
  parent: NotionParent;
  properties: NotionPagePropertyInput;
  children?: NotionBlock[];
  icon?: NotionIcon;
  cover?: NotionIcon;
}

export interface UpdatePageParams {
  properties?: NotionPagePropertyInput;
  archived?: boolean;
  in_trash?: boolean;
  icon?: NotionIcon | null;
  cover?: NotionIcon | null;
}

export interface PagePropertyItemResponse {
  object: 'property_item' | 'list';
  type?: string;
  [k: string]: unknown;
}

export function createPage(
  config: NotionClientConfig,
  params: CreatePageParams,
): Promise<NotionPage> {
  return notionRequest<NotionPage>(
    '/v1/pages',
    { method: 'POST', body: params },
    config,
  );
}

export function getPage(
  config: NotionClientConfig,
  id: PageId,
): Promise<NotionPage> {
  return notionRequest<NotionPage>(`/v1/pages/${id}`, { method: 'GET' }, config);
}

export function updatePage(
  config: NotionClientConfig,
  id: PageId,
  params: UpdatePageParams,
): Promise<NotionPage> {
  return notionRequest<NotionPage>(
    `/v1/pages/${id}`,
    { method: 'PATCH', body: params },
    config,
  );
}

/** Soft-delete: Notion treats `archived: true` as moving to trash. */
export function archivePage(
  config: NotionClientConfig,
  id: PageId,
): Promise<NotionPage> {
  return updatePage(config, id, { archived: true });
}

/**
 * Fetch a single page property. Notion returns either a single property item
 * or a paginated list (for `title`, `rich_text`, `relation`, `people`, and
 * rollup `array` types). Callers should inspect `object` to discriminate.
 *
 * The exposed return type stays permissive because the per-property shapes
 * are large and not all callers need them strictly typed — the value-shape
 * is also reachable via `getPage(...).properties[name]` if the caller wants
 * it strict.
 */
export function getPageProperty(
  config: NotionClientConfig,
  pageId: PageId,
  propertyId: PropertyId,
  opts?: { start_cursor?: string; page_size?: number },
): Promise<PagePropertyItemResponse | NotionPropertyValue> {
  const query: Record<string, string | number | undefined> = {};
  if (opts?.start_cursor !== undefined) query['start_cursor'] = opts.start_cursor;
  if (opts?.page_size !== undefined) query['page_size'] = opts.page_size;
  return notionRequest<PagePropertyItemResponse | NotionPropertyValue>(
    `/v1/pages/${pageId}/properties/${propertyId}`,
    { method: 'GET', query },
    config,
  );
}
