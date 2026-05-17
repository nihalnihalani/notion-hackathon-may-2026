/**
 * Linear GraphQL client.
 *
 * Linear's API is GraphQL-only. We expose typed REST-shaped methods on top
 * so generated code reads like every other connector — no GraphQL query
 * strings leak into the Tool-Coder few-shot examples.
 *
 * Auth: Linear accepts the API key directly as the `Authorization` header
 * (no "Bearer" prefix) — see https://developers.linear.app/docs/graphql/working-with-the-graphql-api/authentication
 */

import { ConnectorError } from '../errors.js';
import { buildContext, makeRequest } from '../http.js';
import type { ConnectorConfig, RequestOptions } from '../types.js';
import {
  linearCommentSchema,
  linearIssueSchema,
  linearProjectSchema,
  type LinearComment,
  type LinearIssue,
  type LinearProject,
} from './types.js';
import { z } from 'zod';

const DEFAULT_BASE = 'https://api.linear.app';
const GRAPHQL_PATH = '/graphql';

const ISSUE_FIELDS = `
  id identifier title description priority url
  createdAt updatedAt
  state { id name type }
  assignee { id name email displayName }
  team { id key name }
`;

const PROJECT_FIELDS = `id name description state url`;

const COMMENT_FIELDS = `id body createdAt user { id name email displayName }`;

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string; extensions?: unknown }>;
}

function maybeValidate<T>(schema: z.ZodType<T>, data: unknown, validate?: boolean): T {
  return validate ? schema.parse(data) : (data as T);
}

export interface CreateLinearIssueParams {
  teamId: string;
  title: string;
  description?: string;
  assigneeId?: string;
  priority?: number;
  projectId?: string;
  stateId?: string;
}

export interface LinearClient {
  listMyIssues(
    state?: string,
    opts?: RequestOptions,
  ): Promise<LinearIssue[]>;
  getIssue(id: string, opts?: RequestOptions): Promise<LinearIssue>;
  createIssue(
    params: CreateLinearIssueParams,
    opts?: RequestOptions,
  ): Promise<LinearIssue>;
  addIssueComment(
    id: string,
    body: string,
    opts?: RequestOptions,
  ): Promise<LinearComment>;
  setIssueStatus(
    id: string,
    statusId: string,
    opts?: RequestOptions,
  ): Promise<LinearIssue>;
  listProjects(teamId: string, opts?: RequestOptions): Promise<LinearProject[]>;
  getProject(id: string, opts?: RequestOptions): Promise<LinearProject>;
}

export function createLinearClient(config: ConnectorConfig): LinearClient {
  const ctx = buildContext({
    provider: 'linear',
    authScheme: 'Raw', // Linear takes the key as-is in Authorization
    config,
    defaultHeaders: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
  });
  const fullConfig: ConnectorConfig = {
    ...config,
    baseUrl: config.baseUrl ?? DEFAULT_BASE,
  };

  async function gql<T>(
    query: string,
    variables: Record<string, unknown>,
    opts: RequestOptions | undefined,
  ): Promise<T> {
    const res = await makeRequest<GraphQLResponse<T>>(
      GRAPHQL_PATH,
      {
        method: 'POST',
        body: { query, variables },
        ...(opts?.signal === undefined ? {} : { signal: opts.signal }),
      },
      fullConfig,
      ctx,
      opts?.retry,
    );
    if (res.errors && res.errors.length > 0) {
      throw new ConnectorError(
        `linear graphql error: ${res.errors.map((e) => e.message).join('; ')}`,
        { status: 200, body: res, provider: 'linear' },
      );
    }
    if (res.data === undefined) {
      throw new ConnectorError('linear graphql returned no data', {
        status: 200,
        body: res,
        provider: 'linear',
      });
    }
    return res.data;
  }

  return {
    async listMyIssues(state, opts) {
      const filter: Record<string, unknown> = {
        assignee: { isMe: { eq: true } },
      };
      if (state !== undefined) filter['state'] = { name: { eq: state } };
      const query = `query($filter: IssueFilter) {
        issues(filter: $filter, first: 50) { nodes { ${ISSUE_FIELDS} } }
      }`;
      const data = await gql<{ issues: { nodes: unknown[] } }>(
        query,
        { filter },
        opts,
      );
      return maybeValidate(z.array(linearIssueSchema), data.issues.nodes, opts?.validate);
    },

    async getIssue(id, opts) {
      const query = `query($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`;
      const data = await gql<{ issue: unknown }>(query, { id }, opts);
      return maybeValidate(linearIssueSchema, data.issue, opts?.validate);
    },

    async createIssue(params, opts) {
      const mutation = `mutation($input: IssueCreateInput!) {
        issueCreate(input: $input) { success issue { ${ISSUE_FIELDS} } }
      }`;
      const input: Record<string, unknown> = {
        teamId: params.teamId,
        title: params.title,
      };
      if (params.description !== undefined) input['description'] = params.description;
      if (params.assigneeId !== undefined) input['assigneeId'] = params.assigneeId;
      if (params.priority !== undefined) input['priority'] = params.priority;
      if (params.projectId !== undefined) input['projectId'] = params.projectId;
      if (params.stateId !== undefined) input['stateId'] = params.stateId;
      const data = await gql<{ issueCreate: { success: boolean; issue: unknown } }>(
        mutation,
        { input },
        opts,
      );
      if (!data.issueCreate.success) {
        throw new ConnectorError('linear issueCreate returned success=false', {
          status: 200,
          body: data,
          provider: 'linear',
        });
      }
      return maybeValidate(linearIssueSchema, data.issueCreate.issue, opts?.validate);
    },

    async addIssueComment(id, body, opts) {
      const mutation = `mutation($input: CommentCreateInput!) {
        commentCreate(input: $input) { success comment { ${COMMENT_FIELDS} } }
      }`;
      const data = await gql<{ commentCreate: { success: boolean; comment: unknown } }>(
        mutation,
        { input: { issueId: id, body } },
        opts,
      );
      if (!data.commentCreate.success) {
        throw new ConnectorError('linear commentCreate returned success=false', {
          status: 200,
          body: data,
          provider: 'linear',
        });
      }
      return maybeValidate(linearCommentSchema, data.commentCreate.comment, opts?.validate);
    },

    async setIssueStatus(id, statusId, opts) {
      const mutation = `mutation($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) { success issue { ${ISSUE_FIELDS} } }
      }`;
      const data = await gql<{ issueUpdate: { success: boolean; issue: unknown } }>(
        mutation,
        { id, input: { stateId: statusId } },
        opts,
      );
      if (!data.issueUpdate.success) {
        throw new ConnectorError('linear issueUpdate returned success=false', {
          status: 200,
          body: data,
          provider: 'linear',
        });
      }
      return maybeValidate(linearIssueSchema, data.issueUpdate.issue, opts?.validate);
    },

    async listProjects(teamId, opts) {
      const query = `query($teamId: String!) {
        team(id: $teamId) { projects { nodes { ${PROJECT_FIELDS} } } }
      }`;
      const data = await gql<{ team: { projects: { nodes: unknown[] } } }>(
        query,
        { teamId },
        opts,
      );
      return maybeValidate(z.array(linearProjectSchema), data.team.projects.nodes, opts?.validate);
    },

    async getProject(id, opts) {
      const query = `query($id: String!) { project(id: $id) { ${PROJECT_FIELDS} } }`;
      const data = await gql<{ project: unknown }>(query, { id }, opts);
      return maybeValidate(linearProjectSchema, data.project, opts?.validate);
    },
  };
}
