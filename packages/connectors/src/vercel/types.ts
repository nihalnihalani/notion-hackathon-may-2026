/**
 * Vercel REST API response types.
 */

import { z } from 'zod';

export const vercelDeploymentSchema = z.object({
  uid: z.string(),
  name: z.string().optional(),
  url: z.string().optional(),
  state: z.string().optional(),
  readyState: z.string().optional(),
  type: z.string().optional(),
  created: z.number().optional(),
  createdAt: z.number().optional(),
  buildingAt: z.number().optional(),
  ready: z.number().optional(),
  target: z.string().nullable().optional(),
  inspectorUrl: z.string().url().optional(),
});
export type VercelDeployment = z.infer<typeof vercelDeploymentSchema>;

export const vercelDeploymentsListSchema = z.object({
  deployments: z.array(vercelDeploymentSchema),
  pagination: z
    .object({
      count: z.number().optional(),
      next: z.number().nullable().optional(),
      prev: z.number().nullable().optional(),
    })
    .optional(),
});

export const vercelProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  accountId: z.string().optional(),
  framework: z.string().nullable().optional(),
  createdAt: z.number().optional(),
  updatedAt: z.number().optional(),
  link: z
    .object({
      type: z.string().optional(),
      repo: z.string().optional(),
      org: z.string().optional(),
    })
    .optional(),
});
export type VercelProject = z.infer<typeof vercelProjectSchema>;

export const vercelProjectsListSchema = z.object({
  projects: z.array(vercelProjectSchema),
  pagination: z
    .object({ count: z.number().optional() })
    .optional(),
});
