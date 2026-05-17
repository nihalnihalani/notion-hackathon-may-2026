/**
 * Vercel REST API client.
 *
 * Auth: `Bearer <token>`. Team-scoped tokens require `?teamId=...` —
 * pass via `baseUrl` if needed (e.g. `https://api.vercel.com?teamId=team_xxx`).
 */

import { buildContext, makeRequest } from '../http.js';
import type { ConnectorConfig, RequestOptions } from '../types.js';
import {
  vercelDeploymentSchema,
  vercelDeploymentsListSchema,
  vercelProjectSchema,
  vercelProjectsListSchema,
  type VercelDeployment,
  type VercelProject,
} from './types.js';
import { z } from 'zod';

const DEFAULT_BASE = 'https://api.vercel.com';

function maybeValidate<T>(schema: z.ZodType<T>, data: unknown, validate?: boolean): T {
  return validate ? schema.parse(data) : (data as T);
}

export interface VercelClient {
  listDeployments(
    projectId: string,
    limit?: number,
    opts?: RequestOptions,
  ): Promise<VercelDeployment[]>;
  getDeployment(id: string, opts?: RequestOptions): Promise<VercelDeployment>;
  listProjects(opts?: RequestOptions): Promise<VercelProject[]>;
  getProject(id: string, opts?: RequestOptions): Promise<VercelProject>;
}

export function createVercelClient(config: ConnectorConfig): VercelClient {
  const ctx = buildContext({
    provider: 'vercel',
    authScheme: 'Bearer',
    config,
    defaultHeaders: { Accept: 'application/json' },
  });
  const fullConfig: ConnectorConfig = {
    ...config,
    baseUrl: config.baseUrl ?? DEFAULT_BASE,
  };

  return {
    async listDeployments(projectId, limit = 20, opts) {
      const data = await makeRequest<unknown>(
        '/v6/deployments',
        {
          method: 'GET',
          query: { projectId, limit },
          ...(opts?.signal === undefined ? {} : { signal: opts.signal }),
        },
        fullConfig,
        ctx,
        opts?.retry,
      );
      const parsed = maybeValidate(vercelDeploymentsListSchema, data, opts?.validate);
      return parsed.deployments;
    },

    async getDeployment(id, opts) {
      const data = await makeRequest<unknown>(
        `/v13/deployments/${encodeURIComponent(id)}`,
        { method: 'GET', ...(opts?.signal === undefined ? {} : { signal: opts.signal }) },
        fullConfig,
        ctx,
        opts?.retry,
      );
      return maybeValidate(vercelDeploymentSchema, data, opts?.validate);
    },

    async listProjects(opts) {
      const data = await makeRequest<unknown>(
        '/v10/projects',
        { method: 'GET', ...(opts?.signal === undefined ? {} : { signal: opts.signal }) },
        fullConfig,
        ctx,
        opts?.retry,
      );
      const parsed = maybeValidate(vercelProjectsListSchema, data, opts?.validate);
      return parsed.projects;
    },

    async getProject(id, opts) {
      const data = await makeRequest<unknown>(
        `/v10/projects/${encodeURIComponent(id)}`,
        { method: 'GET', ...(opts?.signal === undefined ? {} : { signal: opts.signal }) },
        fullConfig,
        ctx,
        opts?.retry,
      );
      return maybeValidate(vercelProjectSchema, data, opts?.validate);
    },
  };
}
