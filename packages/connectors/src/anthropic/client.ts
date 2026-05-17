/**
 * Anthropic Messages API client.
 *
 * - Direct mode: hits `https://api.anthropic.com` with `x-api-key` auth.
 * - Gateway mode: when `gatewayUrl` is provided, routes through it (e.g.
 *   Vercel AI Gateway). Gateway calls use `Authorization: Bearer <apiKey>`
 *   so generated agent code can swap providers without rewrites.
 *
 * Supports `cache_control: { type: 'ephemeral' }` on system blocks and
 * message content blocks — required for the Tool Coder prompt-cache hits
 * called out in PLAN.md §III.
 */

import { buildContext, makeRequest } from '../http.js';
import type { ConnectorConfig, RequestOptions } from '../types.js';
import {
  anthropicResponseSchema,
  type AnthropicContentBlockInput,
  type AnthropicMessage,
  type AnthropicResponse,
  type AnthropicSystem,
} from './types.js';
import type { z } from 'zod';

const DIRECT_BASE = 'https://api.anthropic.com';
const MESSAGES_PATH = '/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

function maybeValidate<T>(schema: z.ZodType<T>, data: unknown, validate?: boolean): T {
  return validate ? schema.parse(data) : (data as T);
}

export interface AnthropicConfig extends ConnectorConfig {
  /** When provided, route through this gateway URL instead of api.anthropic.com. */
  gatewayUrl?: string;
}

export interface CompleteParams {
  model: string;
  messages: AnthropicMessage[];
  system?: AnthropicSystem;
  maxTokens: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  stopSequences?: string[];
  /**
   * Convenience flag: when `true` and `system` is a string, the system
   * block is wrapped in a single ephemeral cache_control block. For
   * fine-grained control pass `system` as an explicit array.
   */
  cacheControl?: boolean;
}

export interface AnthropicClient {
  complete(params: CompleteParams, opts?: RequestOptions): Promise<AnthropicResponse>;
}

export function createAnthropicClient(config: AnthropicConfig): AnthropicClient {
  const gatewayUrl =
    typeof config.gatewayUrl === 'string' && config.gatewayUrl.length > 0
      ? config.gatewayUrl
      : undefined;
  const useGateway = gatewayUrl !== undefined;
  const base = gatewayUrl ?? config.baseUrl ?? DIRECT_BASE;

  // Direct API uses x-api-key (not Bearer). Gateway uses Bearer.
  const ctx = useGateway
    ? buildContext({
        provider: 'anthropic',
        authScheme: 'Bearer',
        config,
        defaultHeaders: {
          Accept: 'application/json',
          'anthropic-version': ANTHROPIC_VERSION,
        },
      })
    : buildContext({
        provider: 'anthropic',
        authHeaderName: 'x-api-key',
        authScheme: 'Raw',
        config,
        defaultHeaders: {
          Accept: 'application/json',
          'anthropic-version': ANTHROPIC_VERSION,
        },
      });

  const fullConfig: ConnectorConfig = { ...config, baseUrl: base };

  return {
    async complete(params, opts) {
      let system = params.system;
      if (params.cacheControl && typeof system === 'string') {
        system = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
      }
      const body: Record<string, unknown> = {
        model: params.model,
        messages: params.messages as {
          role: 'user' | 'assistant';
          content: string | AnthropicContentBlockInput[];
        }[],
        max_tokens: params.maxTokens,
      };
      if (system !== undefined) body['system'] = system;
      if (params.temperature !== undefined) body['temperature'] = params.temperature;
      if (params.topP !== undefined) body['top_p'] = params.topP;
      if (params.topK !== undefined) body['top_k'] = params.topK;
      if (params.stopSequences !== undefined) body['stop_sequences'] = params.stopSequences;

      const data = await makeRequest<unknown>(
        MESSAGES_PATH,
        {
          method: 'POST',
          body,
          ...(opts?.signal === undefined ? {} : { signal: opts.signal }),
        },
        fullConfig,
        ctx,
        opts?.retry,
      );
      return maybeValidate(anthropicResponseSchema, data, opts?.validate);
    },
  };
}
