/**
 * Sentry API response types — issue + event minimal shapes.
 */

import { z } from 'zod';

export const sentryProjectStubSchema = z.object({
  id: z.string().optional(),
  slug: z.string(),
  name: z.string().optional(),
});

export const sentryIssueSchema = z.object({
  id: z.string(),
  shortId: z.string().optional(),
  title: z.string(),
  culprit: z.string().nullable().optional(),
  level: z.string().optional(),
  status: z.string(),
  permalink: z.string().url().optional(),
  count: z.union([z.string(), z.number()]).optional(),
  userCount: z.number().optional(),
  firstSeen: z.string().optional(),
  lastSeen: z.string().optional(),
  project: sentryProjectStubSchema.optional(),
});
export type SentryIssue = z.infer<typeof sentryIssueSchema>;

export const sentryEventSchema = z.object({
  id: z.string(),
  eventID: z.string().optional(),
  groupID: z.string().optional(),
  message: z.string().optional(),
  title: z.string().optional(),
  platform: z.string().optional(),
  dateCreated: z.string().optional(),
  tags: z
    .array(z.object({ key: z.string(), value: z.string() }))
    .optional(),
});
export type SentryEvent = z.infer<typeof sentryEventSchema>;
