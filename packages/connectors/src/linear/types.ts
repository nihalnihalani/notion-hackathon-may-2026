/**
 * Linear GraphQL response types — minimal field set used by generated agents.
 */

import { z } from 'zod';

export const linearUserSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().email().optional(),
  displayName: z.string().optional(),
});
export type LinearUser = z.infer<typeof linearUserSchema>;

export const linearTeamSchema = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string(),
});
export type LinearTeam = z.infer<typeof linearTeamSchema>;

export const linearWorkflowStateSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
});
export type LinearWorkflowState = z.infer<typeof linearWorkflowStateSchema>;

export const linearProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable().optional(),
  state: z.string(),
  url: z.string().url().optional(),
});
export type LinearProject = z.infer<typeof linearProjectSchema>;

export const linearIssueSchema = z.object({
  id: z.string(),
  identifier: z.string(),
  title: z.string(),
  description: z.string().nullable().optional(),
  priority: z.number().optional(),
  url: z.string().url(),
  state: linearWorkflowStateSchema.optional(),
  assignee: linearUserSchema.nullable().optional(),
  team: linearTeamSchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type LinearIssue = z.infer<typeof linearIssueSchema>;

export const linearCommentSchema = z.object({
  id: z.string(),
  body: z.string(),
  createdAt: z.string(),
  user: linearUserSchema.nullable().optional(),
});
export type LinearComment = z.infer<typeof linearCommentSchema>;
