/**
 * GitHub REST v3 response types — only the fields generated agents actually use.
 *
 * Schemas defined in zod; TS types inferred via `z.infer`. This keeps the
 * type and the (opt-in) runtime validator in lockstep.
 */

import { z } from 'zod';

export const githubUserSchema = z.object({
  id: z.number(),
  login: z.string(),
  avatar_url: z.string().url().optional(),
  html_url: z.string().url().optional(),
});
export type GithubUser = z.infer<typeof githubUserSchema>;

export const githubLabelSchema = z.object({
  id: z.number(),
  name: z.string(),
  color: z.string().optional(),
  description: z.string().nullable().optional(),
});
export type GithubLabel = z.infer<typeof githubLabelSchema>;

export const githubRepoSchema = z.object({
  id: z.number(),
  name: z.string(),
  full_name: z.string(),
  private: z.boolean(),
  html_url: z.string().url(),
  description: z.string().nullable().optional(),
  default_branch: z.string(),
  owner: githubUserSchema,
});
export type GithubRepo = z.infer<typeof githubRepoSchema>;

export const githubIssueSchema = z.object({
  id: z.number(),
  number: z.number(),
  title: z.string(),
  state: z.enum(['open', 'closed']),
  body: z.string().nullable().optional(),
  user: githubUserSchema.nullable().optional(),
  labels: z.array(githubLabelSchema).optional(),
  html_url: z.string().url(),
  created_at: z.string(),
  updated_at: z.string(),
  closed_at: z.string().nullable().optional(),
});
export type GithubIssue = z.infer<typeof githubIssueSchema>;

export const githubPRSchema = githubIssueSchema.extend({
  merged: z.boolean().optional(),
  mergeable: z.boolean().nullable().optional(),
  draft: z.boolean().optional(),
  head: z
    .object({
      ref: z.string(),
      sha: z.string(),
    })
    .optional(),
  base: z
    .object({
      ref: z.string(),
      sha: z.string(),
    })
    .optional(),
});
export type GithubPR = z.infer<typeof githubPRSchema>;

export const githubMergeResultSchema = z.object({
  sha: z.string(),
  merged: z.boolean(),
  message: z.string(),
});
export type GithubMergeResult = z.infer<typeof githubMergeResultSchema>;

export const githubCommentSchema = z.object({
  id: z.number(),
  body: z.string(),
  user: githubUserSchema.nullable().optional(),
  html_url: z.string().url(),
  created_at: z.string(),
});
export type GithubComment = z.infer<typeof githubCommentSchema>;
