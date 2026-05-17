/**
 * Slack Web API response types.
 *
 * Every Slack response is `{ ok: boolean, error?: string, ... }`. We surface
 * `ok=false` as a typed error in the client so generated code can `try/catch`.
 */

import { z } from 'zod';

export const slackBaseResponseSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  warning: z.string().optional(),
});

export const slackUserSchema = z.object({
  id: z.string(),
  name: z.string(),
  real_name: z.string().optional(),
  is_bot: z.boolean().optional(),
  profile: z
    .object({
      email: z.string().email().optional(),
      display_name: z.string().optional(),
      image_72: z.string().url().optional(),
    })
    .optional(),
});
export type SlackUser = z.infer<typeof slackUserSchema>;

export const slackChannelSchema = z.object({
  id: z.string(),
  name: z.string(),
  is_channel: z.boolean().optional(),
  is_private: z.boolean().optional(),
  is_archived: z.boolean().optional(),
  num_members: z.number().optional(),
  topic: z.object({ value: z.string() }).optional(),
  purpose: z.object({ value: z.string() }).optional(),
});
export type SlackChannel = z.infer<typeof slackChannelSchema>;

export const slackMessageSchema = z.object({
  ok: z.boolean(),
  channel: z.string().optional(),
  ts: z.string().optional(),
  message: z
    .object({
      text: z.string().optional(),
      user: z.string().optional(),
      ts: z.string().optional(),
    })
    .optional(),
});
export type SlackMessage = z.infer<typeof slackMessageSchema>;

export const slackChannelsListSchema = slackBaseResponseSchema.extend({
  channels: z.array(slackChannelSchema),
  response_metadata: z.object({ next_cursor: z.string().optional() }).optional(),
});

export const slackChannelInfoSchema = slackBaseResponseSchema.extend({
  channel: slackChannelSchema,
});

export const slackUserInfoSchema = slackBaseResponseSchema.extend({
  user: slackUserSchema,
});

/** A Block-Kit block — opaque shape, generated code constructs these directly. */
export type SlackBlock = Record<string, unknown>;
