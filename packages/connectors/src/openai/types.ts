/**
 * OpenAI Chat Completions + Embeddings response types.
 */

import { z } from 'zod';

export const openaiChatMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string().nullable(),
  name: z.string().optional(),
});
export type OpenaiChatMessage = z.infer<typeof openaiChatMessageSchema>;

export const openaiUsageSchema = z.object({
  prompt_tokens: z.number(),
  completion_tokens: z.number().optional(),
  total_tokens: z.number(),
});
export type OpenaiUsage = z.infer<typeof openaiUsageSchema>;

export const openaiChatChoiceSchema = z.object({
  index: z.number(),
  message: openaiChatMessageSchema,
  finish_reason: z.string().nullable().optional(),
});

export const openaiChatResponseSchema = z.object({
  id: z.string(),
  object: z.literal('chat.completion'),
  created: z.number(),
  model: z.string(),
  choices: z.array(openaiChatChoiceSchema),
  usage: openaiUsageSchema,
});
export type OpenaiChatResponse = z.infer<typeof openaiChatResponseSchema>;

export const openaiEmbeddingSchema = z.object({
  object: z.literal('embedding'),
  index: z.number(),
  embedding: z.array(z.number()),
});

export const openaiEmbeddingResponseSchema = z.object({
  object: z.literal('list'),
  data: z.array(openaiEmbeddingSchema),
  model: z.string(),
  usage: z
    .object({
      prompt_tokens: z.number(),
      total_tokens: z.number(),
    })
    .optional(),
});
export type OpenaiEmbeddingResponse = z.infer<typeof openaiEmbeddingResponseSchema>;
