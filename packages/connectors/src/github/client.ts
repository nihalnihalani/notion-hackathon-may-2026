/**
 * GitHub REST v3 client.
 *
 * Repo identifiers may be passed as `"owner/name"` strings — this is the
 * format Tool-Coder-generated code uses most often and matches the GitHub
 * URL convention.
 */

import { buildContext, makeRequest } from '../http.js';
import type { ConnectorConfig, RequestOptions } from '../types.js';
import {
  githubCommentSchema,
  githubIssueSchema,
  githubMergeResultSchema,
  githubPRSchema,
  githubRepoSchema,
  type GithubComment,
  type GithubIssue,
  type GithubMergeResult,
  type GithubPR,
  type GithubRepo,
} from './types.js';
import { z } from 'zod';

const DEFAULT_BASE = 'https://api.github.com';

function splitRepo(repo: string): { owner: string; name: string } {
  const idx = repo.indexOf('/');
  if (idx <= 0 || idx === repo.length - 1) {
    throw new Error(`Invalid repo identifier "${repo}" — expected "owner/name"`);
  }
  return { owner: repo.slice(0, idx), name: repo.slice(idx + 1) };
}

function maybeValidate<T>(schema: z.ZodType<T>, data: unknown, validate?: boolean): T {
  return validate ? schema.parse(data) : (data as T);
}

export interface CreateIssueParams {
  title: string;
  body?: string;
  labels?: string[];
  assignees?: string[];
}

export interface GithubClient {
  listOpenPRs(repo: string, opts?: RequestOptions): Promise<GithubPR[]>;
  getPR(repo: string, number: number, opts?: RequestOptions): Promise<GithubPR>;
  mergePR(
    repo: string,
    number: number,
    opts?: RequestOptions & { commitTitle?: string; mergeMethod?: 'merge' | 'squash' | 'rebase' },
  ): Promise<GithubMergeResult>;
  addPRComment(
    repo: string,
    number: number,
    body: string,
    opts?: RequestOptions,
  ): Promise<GithubComment>;
  createIssue(
    repo: string,
    params: CreateIssueParams,
    opts?: RequestOptions,
  ): Promise<GithubIssue>;
  addIssueComment(
    repo: string,
    number: number,
    body: string,
    opts?: RequestOptions,
  ): Promise<GithubComment>;
  closeIssue(
    repo: string,
    number: number,
    opts?: RequestOptions,
  ): Promise<GithubIssue>;
  getRepo(owner: string, name: string, opts?: RequestOptions): Promise<GithubRepo>;
  listIssuesByLabel(
    repo: string,
    label: string,
    state?: 'open' | 'closed' | 'all',
    opts?: RequestOptions,
  ): Promise<GithubIssue[]>;
}

export function createGithubClient(config: ConnectorConfig): GithubClient {
  const ctx = buildContext({
    provider: 'github',
    authScheme: 'Bearer',
    config,
    defaultHeaders: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'forge-connectors/0.1',
    },
  });
  const fullConfig: ConnectorConfig = {
    ...config,
    baseUrl: config.baseUrl ?? DEFAULT_BASE,
  };

  return {
    async listOpenPRs(repo, opts) {
      const { owner, name } = splitRepo(repo);
      const data = await makeRequest<unknown>(
        `/repos/${owner}/${name}/pulls`,
        {
          method: 'GET',
          query: { state: 'open', per_page: 100 },
          ...(opts?.signal === undefined ? {} : { signal: opts.signal }),
        },
        fullConfig,
        ctx,
        opts?.retry,
      );
      return maybeValidate(z.array(githubPRSchema), data, opts?.validate);
    },

    async getPR(repo, number, opts) {
      const { owner, name } = splitRepo(repo);
      const data = await makeRequest<unknown>(
        `/repos/${owner}/${name}/pulls/${number}`,
        { method: 'GET', ...(opts?.signal === undefined ? {} : { signal: opts.signal }) },
        fullConfig,
        ctx,
        opts?.retry,
      );
      return maybeValidate(githubPRSchema, data, opts?.validate);
    },

    async mergePR(repo, number, opts) {
      const { owner, name } = splitRepo(repo);
      const body: Record<string, unknown> = {};
      if (opts?.commitTitle !== undefined) body['commit_title'] = opts.commitTitle;
      if (opts?.mergeMethod !== undefined) body['merge_method'] = opts.mergeMethod;
      const data = await makeRequest<unknown>(
        `/repos/${owner}/${name}/pulls/${number}/merge`,
        {
          method: 'PUT',
          body,
          ...(opts?.signal === undefined ? {} : { signal: opts.signal }),
        },
        fullConfig,
        ctx,
        opts?.retry,
      );
      return maybeValidate(githubMergeResultSchema, data, opts?.validate);
    },

    async addPRComment(repo, number, body, opts) {
      // PR review comments live under the issues endpoint for plain conversation comments.
      const { owner, name } = splitRepo(repo);
      const data = await makeRequest<unknown>(
        `/repos/${owner}/${name}/issues/${number}/comments`,
        {
          method: 'POST',
          body: { body },
          ...(opts?.signal === undefined ? {} : { signal: opts.signal }),
        },
        fullConfig,
        ctx,
        opts?.retry,
      );
      return maybeValidate(githubCommentSchema, data, opts?.validate);
    },

    async createIssue(repo, params, opts) {
      const { owner, name } = splitRepo(repo);
      const data = await makeRequest<unknown>(
        `/repos/${owner}/${name}/issues`,
        {
          method: 'POST',
          body: params,
          ...(opts?.signal === undefined ? {} : { signal: opts.signal }),
        },
        fullConfig,
        ctx,
        opts?.retry,
      );
      return maybeValidate(githubIssueSchema, data, opts?.validate);
    },

    async addIssueComment(repo, number, body, opts) {
      const { owner, name } = splitRepo(repo);
      const data = await makeRequest<unknown>(
        `/repos/${owner}/${name}/issues/${number}/comments`,
        {
          method: 'POST',
          body: { body },
          ...(opts?.signal === undefined ? {} : { signal: opts.signal }),
        },
        fullConfig,
        ctx,
        opts?.retry,
      );
      return maybeValidate(githubCommentSchema, data, opts?.validate);
    },

    async closeIssue(repo, number, opts) {
      const { owner, name } = splitRepo(repo);
      const data = await makeRequest<unknown>(
        `/repos/${owner}/${name}/issues/${number}`,
        {
          method: 'PATCH',
          body: { state: 'closed' },
          ...(opts?.signal === undefined ? {} : { signal: opts.signal }),
        },
        fullConfig,
        ctx,
        opts?.retry,
      );
      return maybeValidate(githubIssueSchema, data, opts?.validate);
    },

    async getRepo(owner, name, opts) {
      const data = await makeRequest<unknown>(
        `/repos/${owner}/${name}`,
        { method: 'GET', ...(opts?.signal === undefined ? {} : { signal: opts.signal }) },
        fullConfig,
        ctx,
        opts?.retry,
      );
      return maybeValidate(githubRepoSchema, data, opts?.validate);
    },

    async listIssuesByLabel(repo, label, state = 'open', opts) {
      const { owner, name } = splitRepo(repo);
      const data = await makeRequest<unknown>(
        `/repos/${owner}/${name}/issues`,
        {
          method: 'GET',
          query: { labels: label, state, per_page: 100 },
          ...(opts?.signal === undefined ? {} : { signal: opts.signal }),
        },
        fullConfig,
        ctx,
        opts?.retry,
      );
      return maybeValidate(z.array(githubIssueSchema), data, opts?.validate);
    },
  };
}
