/**
 * Notion Databases API.
 *
 * REST surface:
 *   POST   /v1/databases
 *   GET    /v1/databases/{id}
 *   PATCH  /v1/databases/{id}
 *   POST   /v1/databases/{id}/query
 *
 * Reference: https://developers.notion.com/reference/database
 */

import { notionRequest } from './http.js';
import type {
  DatabaseId,
  NotionClientConfig,
  NotionDatabase,
  NotionDatabasePropertySchema,
  NotionIcon,
  NotionPage,
  NotionPaginated,
  NotionParent,
  NotionRichText,
} from './types.js';

export interface CreateDatabaseParams {
  parent: NotionParent;
  title: NotionRichText[];
  description?: NotionRichText[];
  /** Property schema keyed by property name. Each value is a property-config
   *  object (e.g. `{ select: { options: [...] } }`). */
  properties: Record<string, Record<string, unknown>>;
  icon?: NotionIcon;
  cover?: NotionIcon;
  is_inline?: boolean;
}

export interface UpdateDatabaseParams {
  title?: NotionRichText[];
  description?: NotionRichText[];
  /** Pass `null` for a key to **remove** that property; pass a partial config
   *  to mutate it. Notion never deletes data — only schema. */
  properties?: Record<
    string,
    Partial<NotionDatabasePropertySchema> | Record<string, unknown> | null
  >;
  archived?: boolean;
  in_trash?: boolean;
  icon?: NotionIcon | null;
  cover?: NotionIcon | null;
  is_inline?: boolean;
}

/** Notion query filter — the surface is huge & schema-dependent; accept any. */
export type NotionFilter = Record<string, unknown>;

export interface NotionSort {
  property?: string;
  timestamp?: 'created_time' | 'last_edited_time';
  direction: 'ascending' | 'descending';
}

export interface QueryDatabaseOpts {
  filter?: NotionFilter;
  sorts?: NotionSort[];
  start_cursor?: string;
  page_size?: number;
}

export function createDatabase(
  config: NotionClientConfig,
  params: CreateDatabaseParams,
): Promise<NotionDatabase> {
  return notionRequest<NotionDatabase>(
    '/v1/databases',
    { method: 'POST', body: params },
    config,
  );
}

export function getDatabase(
  config: NotionClientConfig,
  id: DatabaseId,
): Promise<NotionDatabase> {
  return notionRequest<NotionDatabase>(
    `/v1/databases/${id}`,
    { method: 'GET' },
    config,
  );
}

export function updateDatabase(
  config: NotionClientConfig,
  id: DatabaseId,
  params: UpdateDatabaseParams,
): Promise<NotionDatabase> {
  return notionRequest<NotionDatabase>(
    `/v1/databases/${id}`,
    { method: 'PATCH', body: params },
    config,
  );
}

export function queryDatabase(
  config: NotionClientConfig,
  id: DatabaseId,
  opts: QueryDatabaseOpts = {},
): Promise<NotionPaginated<NotionPage>> {
  const body: Record<string, unknown> = {};
  if (opts.filter !== undefined) body['filter'] = opts.filter;
  if (opts.sorts !== undefined) body['sorts'] = opts.sorts;
  if (opts.start_cursor !== undefined) body['start_cursor'] = opts.start_cursor;
  if (opts.page_size !== undefined) body['page_size'] = opts.page_size;
  return notionRequest<NotionPaginated<NotionPage>>(
    `/v1/databases/${id}/query`,
    { method: 'POST', body },
    config,
  );
}
