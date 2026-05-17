/**
 * Slack Web API client.
 *
 * Auth: `Bearer <bot-token>` (e.g. `xoxb-…`).
 * Slack returns HTTP 200 for both success and most logical errors; the
 * actual outcome lives in `ok: boolean`. We translate `ok=false` into
 * a {@link ConnectorError} so callers can rely on the throw-on-failure
 * contract that every other connector follows.
 */

import { ConnectorError } from '../errors.js';
import { buildContext, makeRequest } from '../http.js';
import type { ConnectorConfig, RequestOptions } from '../types.js';
import {
  slackChannelInfoSchema,
  slackChannelsListSchema,
  slackMessageSchema,
  slackUserInfoSchema,
  type SlackBlock,
  type SlackChannel,
  type SlackMessage,
  type SlackUser,
} from './types.js';
import { z } from 'zod';

const DEFAULT_BASE = 'https://slack.com/api';

function checkOk(res: { ok: boolean; error?: string | undefined }, body: unknown): void {
  if (!res.ok) {
    throw new ConnectorError(`slack api error: ${res.error ?? 'unknown'}`, {
      status: 200,
      body,
      provider: 'slack',
    });
  }
}

function maybeValidate<T>(schema: z.ZodType<T>, data: unknown, validate?: boolean): T {
  return validate ? schema.parse(data) : (data as T);
}

export interface PostMessageOptions {
  thread_ts?: string;
  reply_broadcast?: boolean;
  unfurl_links?: boolean;
  blocks?: SlackBlock[];
}

export interface ListChannelsOptions {
  types?: string; // e.g. 'public_channel,private_channel'
  exclude_archived?: boolean;
  limit?: number;
  cursor?: string;
}

export interface SlackClient {
  postMessage(
    channel: string,
    text: string,
    opts?: PostMessageOptions & RequestOptions,
  ): Promise<SlackMessage>;
  postBlocks(
    channel: string,
    blocks: SlackBlock[],
    opts?: RequestOptions,
  ): Promise<SlackMessage>;
  getChannel(id: string, opts?: RequestOptions): Promise<SlackChannel>;
  listChannels(
    opts?: ListChannelsOptions & RequestOptions,
  ): Promise<SlackChannel[]>;
  getUser(id: string, opts?: RequestOptions): Promise<SlackUser>;
}

export function createSlackClient(config: ConnectorConfig): SlackClient {
  const ctx = buildContext({
    provider: 'slack',
    authScheme: 'Bearer',
    config,
    defaultHeaders: {
      Accept: 'application/json',
      'Content-Type': 'application/json; charset=utf-8',
    },
  });
  const fullConfig: ConnectorConfig = {
    ...config,
    baseUrl: config.baseUrl ?? DEFAULT_BASE,
  };

  return {
    async postMessage(channel, text, opts) {
      const body: Record<string, unknown> = { channel, text };
      if (opts?.thread_ts !== undefined) body['thread_ts'] = opts.thread_ts;
      if (opts?.reply_broadcast !== undefined) body['reply_broadcast'] = opts.reply_broadcast;
      if (opts?.unfurl_links !== undefined) body['unfurl_links'] = opts.unfurl_links;
      if (opts?.blocks !== undefined) body['blocks'] = opts.blocks;
      const data = await makeRequest<unknown>(
        '/chat.postMessage',
        {
          method: 'POST',
          body,
          ...(opts?.signal === undefined ? {} : { signal: opts.signal }),
        },
        fullConfig,
        ctx,
        opts?.retry,
      );
      const parsed = maybeValidate(slackMessageSchema, data, opts?.validate);
      checkOk(parsed, data);
      return parsed;
    },

    async postBlocks(channel, blocks, opts) {
      const data = await makeRequest<unknown>(
        '/chat.postMessage',
        {
          method: 'POST',
          body: { channel, blocks, text: '' },
          ...(opts?.signal === undefined ? {} : { signal: opts.signal }),
        },
        fullConfig,
        ctx,
        opts?.retry,
      );
      const parsed = maybeValidate(slackMessageSchema, data, opts?.validate);
      checkOk(parsed, data);
      return parsed;
    },

    async getChannel(id, opts) {
      const data = await makeRequest<unknown>(
        '/conversations.info',
        {
          method: 'GET',
          query: { channel: id },
          ...(opts?.signal === undefined ? {} : { signal: opts.signal }),
        },
        fullConfig,
        ctx,
        opts?.retry,
      );
      const parsed = maybeValidate(slackChannelInfoSchema, data, opts?.validate);
      checkOk(parsed, data);
      return parsed.channel;
    },

    async listChannels(opts) {
      const query: Record<string, string | number | boolean> = {};
      if (opts?.types !== undefined) query['types'] = opts.types;
      if (opts?.exclude_archived !== undefined) query['exclude_archived'] = opts.exclude_archived;
      if (opts?.limit !== undefined) query['limit'] = opts.limit;
      if (opts?.cursor !== undefined) query['cursor'] = opts.cursor;
      const data = await makeRequest<unknown>(
        '/conversations.list',
        {
          method: 'GET',
          query,
          ...(opts?.signal === undefined ? {} : { signal: opts.signal }),
        },
        fullConfig,
        ctx,
        opts?.retry,
      );
      const parsed = maybeValidate(slackChannelsListSchema, data, opts?.validate);
      checkOk(parsed, data);
      return parsed.channels;
    },

    async getUser(id, opts) {
      const data = await makeRequest<unknown>(
        '/users.info',
        {
          method: 'GET',
          query: { user: id },
          ...(opts?.signal === undefined ? {} : { signal: opts.signal }),
        },
        fullConfig,
        ctx,
        opts?.retry,
      );
      const parsed = maybeValidate(slackUserInfoSchema, data, opts?.validate);
      checkOk(parsed, data);
      return parsed.user;
    },
  };
}
