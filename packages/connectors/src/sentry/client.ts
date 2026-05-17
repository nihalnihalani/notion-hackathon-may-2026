/**
 * Sentry REST client.
 *
 * Project identifiers are passed as `"organization-slug/project-slug"`
 * which matches Sentry's URL convention and keeps Tool-Coder code terse.
 * Auth: `Bearer <auth-token>`.
 */

import { buildContext, makeRequest } from '../http.js';
import type { ConnectorConfig, RequestOptions } from '../types.js';
import {
  sentryEventSchema,
  sentryIssueSchema,
  type SentryEvent,
  type SentryIssue,
} from './types.js';
import { z } from 'zod';

const DEFAULT_BASE = 'https://sentry.io/api/0';

function splitProject(id: string): { org: string; project: string } {
  const idx = id.indexOf('/');
  if (idx <= 0 || idx === id.length - 1) {
    throw new Error(
      `Invalid sentry project identifier "${id}" — expected "org-slug/project-slug"`,
    );
  }
  return { org: id.slice(0, idx), project: id.slice(idx + 1) };
}

function maybeValidate<T>(schema: z.ZodType<T>, data: unknown, validate?: boolean): T {
  return validate ? schema.parse(data) : (data as T);
}

export interface SentryClient {
  listIssues(
    project: string,
    query?: string,
    opts?: RequestOptions,
  ): Promise<SentryIssue[]>;
  getIssue(id: string, opts?: RequestOptions): Promise<SentryIssue>;
  getIssueEvents(
    id: string,
    limit?: number,
    opts?: RequestOptions,
  ): Promise<SentryEvent[]>;
  resolveIssue(id: string, opts?: RequestOptions): Promise<SentryIssue>;
}

export function createSentryClient(config: ConnectorConfig): SentryClient {
  const ctx = buildContext({
    provider: 'sentry',
    authScheme: 'Bearer',
    config,
    defaultHeaders: { Accept: 'application/json' },
  });
  const fullConfig: ConnectorConfig = {
    ...config,
    baseUrl: config.baseUrl ?? DEFAULT_BASE,
  };

  return {
    async listIssues(project, query, opts) {
      const { org, project: proj } = splitProject(project);
      const q: Record<string, string | number> = { limit: 100 };
      if (query !== undefined) q['query'] = query;
      const data = await makeRequest<unknown>(
        `/projects/${org}/${proj}/issues/`,
        {
          method: 'GET',
          query: q,
          ...(opts?.signal === undefined ? {} : { signal: opts.signal }),
        },
        fullConfig,
        ctx,
        opts?.retry,
      );
      return maybeValidate(z.array(sentryIssueSchema), data, opts?.validate);
    },

    async getIssue(id, opts) {
      const data = await makeRequest<unknown>(
        `/issues/${encodeURIComponent(id)}/`,
        { method: 'GET', ...(opts?.signal === undefined ? {} : { signal: opts.signal }) },
        fullConfig,
        ctx,
        opts?.retry,
      );
      return maybeValidate(sentryIssueSchema, data, opts?.validate);
    },

    async getIssueEvents(id, limit = 50, opts) {
      const data = await makeRequest<unknown>(
        `/issues/${encodeURIComponent(id)}/events/`,
        {
          method: 'GET',
          query: { limit },
          ...(opts?.signal === undefined ? {} : { signal: opts.signal }),
        },
        fullConfig,
        ctx,
        opts?.retry,
      );
      return maybeValidate(z.array(sentryEventSchema), data, opts?.validate);
    },

    async resolveIssue(id, opts) {
      const data = await makeRequest<unknown>(
        `/issues/${encodeURIComponent(id)}/`,
        {
          method: 'PUT',
          body: { status: 'resolved' },
          ...(opts?.signal === undefined ? {} : { signal: opts.signal }),
        },
        fullConfig,
        ctx,
        opts?.retry,
      );
      return maybeValidate(sentryIssueSchema, data, opts?.validate);
    },
  };
}
