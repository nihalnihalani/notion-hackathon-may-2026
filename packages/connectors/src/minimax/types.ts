/**
 * MiniMax API response types.
 *
 * MiniMax wraps every response in `{ base_resp: { status_code, status_msg } }`
 * — non-zero status_code is a logical error even when HTTP is 200.
 */

import { z } from 'zod';

export const minimaxBaseRespSchema = z.object({
  status_code: z.number(),
  status_msg: z.string(),
});

// ── Text-to-speech (T2A v2) ──────────────────────────────────────────────────

export const minimaxT2AResponseSchema = z.object({
  data: z
    .object({
      audio: z.string().optional(),
      status: z.number().optional(),
      ced: z.string().optional(),
    })
    .optional(),
  extra_info: z
    .object({
      audio_length: z.number().optional(),
      audio_size: z.number().optional(),
      bitrate: z.number().optional(),
      word_count: z.number().optional(),
    })
    .optional(),
  trace_id: z.string().optional(),
  base_resp: minimaxBaseRespSchema,
});
export type MinimaxT2AResponse = z.infer<typeof minimaxT2AResponseSchema>;

// ── Speech-to-text (transcribe) ──────────────────────────────────────────────

export const minimaxTranscribeResponseSchema = z.object({
  text: z.string().optional(),
  segments: z
    .array(
      z.object({
        text: z.string(),
        start: z.number().optional(),
        end: z.number().optional(),
      }),
    )
    .optional(),
  language: z.string().optional(),
  base_resp: minimaxBaseRespSchema,
});
export type MinimaxTranscribeResponse = z.infer<typeof minimaxTranscribeResponseSchema>;

// ── Image generation ─────────────────────────────────────────────────────────

export const minimaxImageResponseSchema = z.object({
  id: z.string().optional(),
  data: z
    .object({
      image_urls: z.array(z.string().url()).optional(),
    })
    .optional(),
  metadata: z
    .object({
      success_count: z.string().optional(),
      failed_count: z.string().optional(),
    })
    .optional(),
  base_resp: minimaxBaseRespSchema,
});
export type MinimaxImageResponse = z.infer<typeof minimaxImageResponseSchema>;
