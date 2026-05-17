/**
 * Gmail API client.
 *
 * Auth: OAuth access token as Bearer. (Refresh handled upstream by the
 * `ntn` OAuth manager — we just take the active token.)
 */

import { buildContext, makeRequest } from '../http.js';
import type { ConnectorConfig, RequestOptions } from '../types.js';
import {
  gmailListResponseSchema,
  gmailMessageSchema,
  gmailSendResponseSchema,
  type GmailMessage,
  type GmailMessageStub,
  type GmailSendResponse,
} from './types.js';
import type { z } from 'zod';

const DEFAULT_BASE = 'https://gmail.googleapis.com/gmail/v1';

function maybeValidate<T>(schema: z.ZodType<T>, data: unknown, validate?: boolean): T {
  return validate ? schema.parse(data) : (data as T);
}

/**
 * RFC 2822 message → base64url (the encoding Gmail wants in `raw`).
 * Works in Edge runtimes (no Node Buffer dependency).
 */
function base64UrlEncode(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const b64 = bytesToBase64(bytes);
  return b64.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
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

function buildRfc822(to: string, subject: string, body: string): string {
  const lines = [
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 7bit',
    '',
    body,
  ];
  return lines.join('\r\n');
}

export interface GmailClient {
  listMessages(query?: string, opts?: RequestOptions): Promise<GmailMessageStub[]>;
  getMessage(id: string, opts?: RequestOptions): Promise<GmailMessage>;
  sendMessage(
    to: string,
    subject: string,
    body: string,
    opts?: RequestOptions,
  ): Promise<GmailSendResponse>;
  addLabel(messageId: string, labelId: string, opts?: RequestOptions): Promise<GmailMessage>;
}

export function createGmailClient(config: ConnectorConfig): GmailClient {
  const ctx = buildContext({
    provider: 'gmail',
    authScheme: 'Bearer',
    config,
    defaultHeaders: { Accept: 'application/json' },
  });
  const fullConfig: ConnectorConfig = {
    ...config,
    baseUrl: config.baseUrl ?? DEFAULT_BASE,
  };

  return {
    async listMessages(query, opts) {
      const q: Record<string, string | number> = { maxResults: 50 };
      if (query !== undefined) q['q'] = query;
      const data = await makeRequest<unknown>(
        '/users/me/messages',
        {
          method: 'GET',
          query: q,
          ...(opts?.signal === undefined ? {} : { signal: opts.signal }),
        },
        fullConfig,
        ctx,
        opts?.retry,
      );
      const parsed = maybeValidate(gmailListResponseSchema, data, opts?.validate);
      return parsed.messages ?? [];
    },

    async getMessage(id, opts) {
      const data = await makeRequest<unknown>(
        `/users/me/messages/${encodeURIComponent(id)}`,
        {
          method: 'GET',
          query: { format: 'full' },
          ...(opts?.signal === undefined ? {} : { signal: opts.signal }),
        },
        fullConfig,
        ctx,
        opts?.retry,
      );
      return maybeValidate(gmailMessageSchema, data, opts?.validate);
    },

    async sendMessage(to, subject, body, opts) {
      const raw = base64UrlEncode(buildRfc822(to, subject, body));
      const data = await makeRequest<unknown>(
        '/users/me/messages/send',
        {
          method: 'POST',
          body: { raw },
          ...(opts?.signal === undefined ? {} : { signal: opts.signal }),
        },
        fullConfig,
        ctx,
        opts?.retry,
      );
      return maybeValidate(gmailSendResponseSchema, data, opts?.validate);
    },

    async addLabel(messageId, labelId, opts) {
      const data = await makeRequest<unknown>(
        `/users/me/messages/${encodeURIComponent(messageId)}/modify`,
        {
          method: 'POST',
          body: { addLabelIds: [labelId] },
          ...(opts?.signal === undefined ? {} : { signal: opts.signal }),
        },
        fullConfig,
        ctx,
        opts?.retry,
      );
      return maybeValidate(gmailMessageSchema, data, opts?.validate);
    },
  };
}
