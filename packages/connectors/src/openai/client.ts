/**
 * OpenAI client (chat completions + embeddings).
 *
 * - Direct mode: `https://api.openai.com/v1`, auth `Bearer <apiKey>`.
 * - Gateway mode: when `gatewayUrl` is provided, base URL flips. Auth
 *   stays `Bearer` so generated code is portable across providers via
 *   the Vercel AI Gateway.
 *
 * The embeddings default model is `text-embedding-3-large` as required by
 * the connector spec.
 */

import { buildContext, makeRequest } from '../http.js';
import type { ConnectorConfig, RequestOptions } from '../types.js';
import {
  openaiChatResponseSchema,
  openaiEmbeddingResponseSchema,
  type OpenaiChatMessage,
  type OpenaiChatResponse,
  type OpenaiEmbeddingResponse,
} from './types.js';
import type { z } from 'zod';

const DIRECT_BASE = 'https://api.openai.com/v1';

function maybeValidate<T>(schema: z.ZodType<T>, data: unknown, validate?: boolean): T {
  return validate ? schema.parse(data) : (data as T);
}

export interface OpenaiConfig extends ConnectorConfig {
  /** Optional org id passed via `OpenAI-Organization` header. */
  organization?: string;
  /** When provided, route through this gateway URL instead of api.openai.com. */
  gatewayUrl?: string;
}

export interface OpenaiCompleteParams {
  model: string;
  messages: OpenaiChatMessage[];
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stop?: string | string[];
  /** Forwarded as `response_format` (e.g. JSON mode). */
  responseFormat?: { type: 'json_object' | 'text' };
}

export interface OpenaiEmbedParams {
  /** Defaults to `text-embedding-3-large` if omitted. */
  model?: string;
  input: string | string[];
}

export interface OpenaiClient {
  complete(params: OpenaiCompleteParams, opts?: RequestOptions): Promise<OpenaiChatResponse>;
  embed(params: OpenaiEmbedParams, opts?: RequestOptions): Promise<number[][]>;
}

export function createOpenaiClient(config: OpenaiConfig): OpenaiClient {
  const gatewayUrl =
    typeof config.gatewayUrl === 'string' && config.gatewayUrl.length > 0
      ? config.gatewayUrl
      : undefined;
  const base = gatewayUrl ?? config.baseUrl ?? DIRECT_BASE;

  const defaultHeaders: Record<string, string> = { Accept: 'application/json' };
  if (config.organization) defaultHeaders['OpenAI-Organization'] = config.organization;

  const ctx = buildContext({
    provider: 'openai',
    authScheme: 'Bearer',
    config,
    defaultHeaders,
  });
  const fullConfig: ConnectorConfig = { ...config, baseUrl: base };

  return {
    async complete(params, opts) {
      const body: Record<string, unknown> = {
        model: params.model,
        messages: params.messages,
      };
      if (params.maxTokens !== undefined) body['max_tokens'] = params.maxTokens;
      if (params.temperature !== undefined) body['temperature'] = params.temperature;
      if (params.topP !== undefined) body['top_p'] = params.topP;
      if (params.stop !== undefined) body['stop'] = params.stop;
      if (params.responseFormat !== undefined) body['response_format'] = params.responseFormat;

      const data = await makeRequest<unknown>(
        '/chat/completions',
        {
          method: 'POST',
          body,
          ...(opts?.signal === undefined ? {} : { signal: opts.signal }),
        },
        fullConfig,
        ctx,
        opts?.retry,
      );
      return maybeValidate(openaiChatResponseSchema, data, opts?.validate);
    },

    async embed(params, opts) {
      const model = params.model ?? 'text-embedding-3-large';
      const data = await makeRequest<unknown>(
        '/embeddings',
        {
          method: 'POST',
          body: { model, input: params.input },
          ...(opts?.signal === undefined ? {} : { signal: opts.signal }),
        },
        fullConfig,
        ctx,
        opts?.retry,
      );
      const parsed: OpenaiEmbeddingResponse = maybeValidate(
        openaiEmbeddingResponseSchema,
        data,
        opts?.validate,
      );
      // Sort by index defensively — most providers return in order but the
      // OpenAI spec does not strictly guarantee it.
      return [...parsed.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
    },
  };
}
