/**
 * MiniMax client — speech (TTS + STT) + image generation.
 *
 * Base URL: `https://api.minimax.io/v1` (global) — override via `baseUrl`
 * for the mainland-China endpoint (`https://api.minimaxi.chat/v1`).
 *
 * Auth: `Bearer <api-key>` per
 * https://platform.minimax.io/docs/api-reference/speech-t2a-http
 *
 * MiniMax returns logical errors inside `base_resp.status_code` even when
 * HTTP is 200 — we surface those as {@link ConnectorError} so generated
 * agent code can rely on the throw-on-failure contract.
 */

import { ConnectorError } from '../errors.js';
import { buildContext, makeRequest } from '../http.js';
import type { ConnectorConfig, RequestOptions } from '../types.js';
import {
  minimaxImageResponseSchema,
  minimaxT2AResponseSchema,
  minimaxTranscribeResponseSchema,
  type MinimaxImageResponse,
  type MinimaxT2AResponse,
  type MinimaxTranscribeResponse,
} from './types.js';
import type { z } from 'zod';

const DEFAULT_BASE = 'https://api.minimax.io/v1';

function maybeValidate<T>(schema: z.ZodType<T>, data: unknown, validate?: boolean): T {
  return validate ? schema.parse(data) : (data as T);
}

function checkBaseResp(
  resp: { base_resp: { status_code: number; status_msg: string } },
  body: unknown,
): void {
  if (resp.base_resp.status_code !== 0) {
    throw new ConnectorError(
      `minimax api error (${resp.base_resp.status_code}): ${resp.base_resp.status_msg}`,
      { status: 200, body, provider: 'minimax' },
    );
  }
}

/**
 * Convert binary audio input → base64 (the form MiniMax accepts when not
 * passing a URL). Works in Edge runtimes (no Node Buffer dependency).
 */
function toBase64(buf: ArrayBuffer): string {
  return bytesToBase64(new Uint8Array(buf));
}

function bytesToBase64(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;
    const triplet = (a << 16) | (b << 8) | c;
    out += alphabet[(triplet >> 18) & 63] ?? '';
    out += alphabet[(triplet >> 12) & 63] ?? '';
    out += i + 1 < bytes.length ? (alphabet[(triplet >> 6) & 63] ?? '') : '=';
    out += i + 2 < bytes.length ? (alphabet[triplet & 63] ?? '') : '=';
  }
  return out;
}

export interface TranscribeParams {
  /** Either a public URL string or raw ArrayBuffer of the audio. */
  audio: ArrayBuffer | string;
  /** Audio format hint, e.g. `mp3`, `wav`, `m4a`. */
  format: string;
  /** Model identifier — defaults to `speech-01`. */
  model?: string;
  language?: string;
}

export interface SpeakParams {
  text: string;
  /** Voice id; defaults to `male-qn-qingse` (MiniMax demo voice). */
  voice?: string;
  /** Model identifier — defaults to `speech-02-hd`. */
  model?: string;
  speed?: number;
  vol?: number;
  pitch?: number;
  format?: 'mp3' | 'wav' | 'pcm';
  sampleRate?: number;
}

export interface GenerateImageParams {
  prompt: string;
  size?: string; // e.g. "1024x1024"
  count?: number; // n images
  /** Model identifier — defaults to `image-01`. */
  model?: string;
}

export interface MinimaxClient {
  transcribe(params: TranscribeParams, opts?: RequestOptions): Promise<MinimaxTranscribeResponse>;
  speak(params: SpeakParams, opts?: RequestOptions): Promise<MinimaxT2AResponse>;
  generateImage(params: GenerateImageParams, opts?: RequestOptions): Promise<MinimaxImageResponse>;
}

export function createMinimaxClient(config: ConnectorConfig): MinimaxClient {
  const ctx = buildContext({
    provider: 'minimax',
    authScheme: 'Bearer',
    config,
    defaultHeaders: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
  });
  const fullConfig: ConnectorConfig = {
    ...config,
    baseUrl: config.baseUrl ?? DEFAULT_BASE,
  };

  return {
    async transcribe(params, opts) {
      const audio = typeof params.audio === 'string' ? params.audio : toBase64(params.audio);
      const body: Record<string, unknown> = {
        model: params.model ?? 'speech-01',
        format: params.format,
      };
      if (typeof params.audio === 'string') {
        body['audio_url'] = audio;
      } else {
        body['audio'] = audio;
      }
      if (params.language !== undefined) body['language'] = params.language;
      const data = await makeRequest<unknown>(
        '/speech_to_text',
        {
          method: 'POST',
          body,
          ...(opts?.signal === undefined ? {} : { signal: opts.signal }),
        },
        fullConfig,
        ctx,
        opts?.retry,
      );
      const parsed = maybeValidate(minimaxTranscribeResponseSchema, data, opts?.validate);
      checkBaseResp(parsed, data);
      return parsed;
    },

    async speak(params, opts) {
      const body: Record<string, unknown> = {
        model: params.model ?? 'speech-02-hd',
        text: params.text,
        voice_setting: {
          voice_id: params.voice ?? 'male-qn-qingse',
          speed: params.speed ?? 1,
          vol: params.vol ?? 1,
          pitch: params.pitch ?? 0,
        },
        audio_setting: {
          sample_rate: params.sampleRate ?? 32_000,
          bitrate: 128_000,
          format: params.format ?? 'mp3',
          channel: 1,
        },
      };
      const data = await makeRequest<unknown>(
        '/t2a_v2',
        {
          method: 'POST',
          body,
          ...(opts?.signal === undefined ? {} : { signal: opts.signal }),
        },
        fullConfig,
        ctx,
        opts?.retry,
      );
      const parsed = maybeValidate(minimaxT2AResponseSchema, data, opts?.validate);
      checkBaseResp(parsed, data);
      return parsed;
    },

    async generateImage(params, opts) {
      const body: Record<string, unknown> = {
        model: params.model ?? 'image-01',
        prompt: params.prompt,
        aspect_ratio: params.size ?? '1:1',
        n: params.count ?? 1,
        response_format: 'url',
      };
      const data = await makeRequest<unknown>(
        '/image_generation',
        {
          method: 'POST',
          body,
          ...(opts?.signal === undefined ? {} : { signal: opts.signal }),
        },
        fullConfig,
        ctx,
        opts?.retry,
      );
      const parsed = maybeValidate(minimaxImageResponseSchema, data, opts?.validate);
      checkBaseResp(parsed, data);
      return parsed;
    },
  };
}
