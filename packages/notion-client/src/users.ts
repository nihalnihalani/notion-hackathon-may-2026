/**
 * Notion Users API.
 *
 * REST surface:
 *   GET    /v1/users/me
 *   GET    /v1/users/{id}
 *   GET    /v1/users               ← list, paginated
 *
 * Reference: https://developers.notion.com/reference/user
 */

import { notionRequest } from './http.js';
import type {
  NotionClientConfig,
  NotionPaginated,
  NotionUser,
  UserId,
} from './types.js';

export function getMe(config: NotionClientConfig): Promise<NotionUser> {
  return notionRequest<NotionUser>('/v1/users/me', { method: 'GET' }, config);
}

export function getUser(
  config: NotionClientConfig,
  id: UserId,
): Promise<NotionUser> {
  return notionRequest<NotionUser>(`/v1/users/${id}`, { method: 'GET' }, config);
}

export function listUsers(
  config: NotionClientConfig,
  opts?: { start_cursor?: string; page_size?: number },
): Promise<NotionPaginated<NotionUser>> {
  const query: Record<string, string | number | undefined> = {};
  if (opts?.start_cursor !== undefined) query['start_cursor'] = opts.start_cursor;
  if (opts?.page_size !== undefined) query['page_size'] = opts.page_size;
  return notionRequest<NotionPaginated<NotionUser>>(
    '/v1/users',
    { method: 'GET', query },
    config,
  );
}
