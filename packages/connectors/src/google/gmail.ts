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
import { z } from 'zod';

const DEFAULT_BASE = 'https://gmail.googleapis.com/gmail/v1';

function maybeValidate<T>(schema: z.ZodType<T>, data: unknown, validate?: boolean): T {
  return validate ? schema.parse(data) : (data as T);
}

/**
 * RFC 2822 message → base64url (the encoding Gmail wants in `raw`).
 * Works in Edge runtimes (no Node Buffer dependency).
 */
function base64UrlEncode(input: string): string {
  // TextEncoder produces a Uint8Array. We base64 it, then URL-safe transform.
  const bytes = new TextEncoder().encode(input);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64 =
    typeof btoa === 'function'
      ? btoa(bin)
      : // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (globalThis as any).Buffer.from(bin, 'binary').toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
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
