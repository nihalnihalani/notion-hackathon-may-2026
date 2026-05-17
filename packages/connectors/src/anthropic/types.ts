/**
 * Anthropic Messages API types — including prompt-caching usage fields.
 */

import { z } from 'zod';

export const anthropicCacheControlSchema = z.object({
  type: z.literal('ephemeral'),
});
export type AnthropicCacheControl = z.infer<typeof anthropicCacheControlSchema>;

export const anthropicTextBlockSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
  cache_control: anthropicCacheControlSchema.optional(),
});

export const anthropicContentBlockInputSchema = z.union([
  z.string(),
  anthropicTextBlockSchema,
  // Permit forward-compat block types (tool_use, image, etc.).
  z.object({ type: z.string() }).passthrough(),
]);
export type AnthropicContentBlockInput = z.infer<typeof anthropicContentBlockInputSchema>;

export const anthropicMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.union([z.string(), z.array(anthropicContentBlockInputSchema)]),
});
export type AnthropicMessage = z.infer<typeof anthropicMessageSchema>;

export const anthropicSystemSchema = z.union([
  z.string(),
  z.array(
    z.object({
      type: z.literal('text'),
      text: z.string(),
      cache_control: anthropicCacheControlSchema.optional(),
    }),
  ),
]);
export type AnthropicSystem = z.infer<typeof anthropicSystemSchema>;

export const anthropicUsageSchema = z.object({
  input_tokens: z.number(),
  output_tokens: z.number(),
  cache_creation_input_tokens: z.number().optional(),
  cache_read_input_tokens: z.number().optional(),
});
export type AnthropicUsage = z.infer<typeof anthropicUsageSchema>;

export const anthropicResponseContentSchema = z.array(
  z.union([
    z.object({ type: z.literal('text'), text: z.string() }),
    z.object({ type: z.literal('thinking'), thinking: z.string().optional() }).passthrough(),
    z.object({ type: z.string() }).passthrough(),
  ]),
);

export const anthropicResponseSchema = z.object({
  id: z.string(),
  type: z.literal('message'),
  role: z.literal('assistant'),
  model: z.string(),
  content: anthropicResponseContentSchema,
  stop_reason: z.string().nullable().optional(),
  stop_sequence: z.string().nullable().optional(),
  usage: anthropicUsageSchema,
});
export type AnthropicResponse = z.infer<typeof anthropicResponseSchema>;
