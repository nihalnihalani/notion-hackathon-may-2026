/**
 * POST /api/forge/voice — speech-to-text for the "describe an agent by voice"
 * input (PLAN.md Part II → MiniMax row).
 *
 * Body: `multipart/form-data` with a single `audio` file part. Accepted
 * formats are anything MiniMax accepts (`mp3`, `wav`, `m4a`, `webm`,
 * `ogg`, `flac`). The route does not transcode — it forwards the bytes.
 *
 * Response: `{ text: string, language?: string }`
 *
 * Auth: Clerk session + workspace bind. Voice transcription is paid (MiniMax
 * meter), so this is not an unauthenticated endpoint.
 *
 * Rate limit: 20/min per user. Higher than the trigger limit (5/min) because
 * users typically iterate on a description with a few re-takes before they
 * hit ⚡ Forge.
 */

import { createMinimaxClient } from '@forge/connectors';
import { NextResponse } from 'next/server';

import { requireWorkspace } from '@/lib/auth';
import { apiError } from '@/lib/errors';
import { capture } from '@/lib/posthog';
import { checkRateLimit, createRateLimiter } from '@/lib/ratelimit';
import { withSentry } from '@/lib/sentry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 4 MiB — MiniMax accepts up to ~20 MiB; we cap lower to keep latency tight. */
const MAX_AUDIO_BYTES = 4 * 1024 * 1024;

/**
 * Audio MIME prefixes accepted on inbound requests. We do not validate the
 * container vs the codec — MiniMax has the canonical opinion on that. The
 * prefix check is a guard against accidentally forwarding a 5 MiB JPEG.
 */
const ACCEPTED_MIME_PREFIXES = [
  'audio/',
  // Browser MediaRecorder defaults to `audio/webm` but some Safari builds
  // tag the blob `video/webm` even when there's no video track. Allow it.
  'video/webm',
];

/**
 * Map of common MIME types → MiniMax `format` hint. MiniMax requires the
 * format separately from the bytes; we sniff from MIME first, fall back to
 * the filename extension, and default to `mp3` (the most-likely browser
 * default after webm/ogg).
 */
function inferMinimaxFormat(mime: string, filename: string | undefined): string {
  const lowered = mime.toLowerCase();
  if (lowered.includes('webm')) return 'webm';
  if (lowered.includes('ogg')) return 'ogg';
  if (lowered.includes('wav') || lowered.includes('wave')) return 'wav';
  if (lowered.includes('mp4') || lowered.includes('m4a') || lowered.includes('aac'))
    return 'm4a';
  if (lowered.includes('flac')) return 'flac';
  if (lowered.includes('mpeg') || lowered.includes('mp3')) return 'mp3';

  const ext = filename?.split('.').pop()?.toLowerCase();
  if (ext === 'webm' || ext === 'ogg' || ext === 'wav' || ext === 'mp3' ||
      ext === 'm4a' || ext === 'flac' || ext === 'aac') {
    return ext === 'aac' ? 'm4a' : ext;
  }
  return 'mp3';
}

export const POST = withSentry(
  async (req) => {
    const r = await requireWorkspace();
    if (!r.ok) return r.response;
    const { user, workspace } = r.ctx;

    // Rate limit before reading the body so a DoS doesn't pay for parsing.
    const limiter = createRateLimiter('forge.voice', 20, '1 m');
    const rl = await checkRateLimit(limiter, user.id);
    if (!rl.success) {
      const resetSeconds = Math.max(0, Math.ceil((rl.reset - Date.now()) / 1000));
      const resp = apiError(
        'rate_limited',
        `Rate limit exceeded. Retry in ${resetSeconds}s.`,
      );
      resp.headers.set('Retry-After', String(resetSeconds));
      resp.headers.set('X-RateLimit-Limit', String(rl.limit));
      resp.headers.set('X-RateLimit-Remaining', String(rl.remaining));
      return resp;
    }

    // Voice transcription requires MiniMax credentials. Surface a clear 503
    // rather than letting `createMinimaxClient` blow up inside the handler.
    // `MINIMAX_GROUP_ID` is documented as paired with the API key for image
    // generation; the speech_to_text endpoint accepts the bare bearer token,
    // so we don't enforce the group id here.
    const minimaxKey = process.env['MINIMAX_API_KEY'];
    if (!minimaxKey) {
      return apiError(
        'upstream_failure',
        'Voice transcription is not configured on this deployment.',
        { status: 503 },
      );
    }

    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return apiError('validation', 'Body must be multipart/form-data.');
    }

    const audio = form.get('audio');
    if (!(audio instanceof Blob)) {
      return apiError('validation', 'Missing `audio` file part.');
    }
    if (audio.size === 0) {
      return apiError('validation', 'Audio payload is empty.');
    }
    if (audio.size > MAX_AUDIO_BYTES) {
      return apiError(
        'validation',
        `Audio exceeds ${MAX_AUDIO_BYTES} bytes (got ${audio.size}).`,
      );
    }

    const mime = audio.type || '';
    if (!ACCEPTED_MIME_PREFIXES.some((prefix) => mime.startsWith(prefix))) {
      // Browsers occasionally drop the MIME on Blob — treat empty as audio
      // and let MiniMax reject if it really isn't. Reject only confirmed
      // wrong types like image/png.
      if (mime.length > 0) {
        return apiError(
          'validation',
          `Unsupported audio MIME type: ${mime}.`,
        );
      }
    }
    const filename = audio instanceof File ? audio.name : undefined;
    const format = inferMinimaxFormat(mime, filename);

    const startedAt = Date.now();
    const client = createMinimaxClient({ apiKey: minimaxKey });

    let resp;
    try {
      const bytes = await audio.arrayBuffer();
      resp = await client.transcribe({ audio: bytes, format });
    } catch (err) {
      return apiError(
        'upstream_failure',
        err instanceof Error ? err.message : 'MiniMax transcription failed.',
      );
    }
    const latencyMs = Date.now() - startedAt;

    const text = (resp.text ??
      resp.segments?.map((s) => s.text).join(' ') ??
      '').trim();
    if (text.length === 0) {
      return apiError(
        'upstream_failure',
        'No speech detected. Try recording again.',
      );
    }

    await capture({
      distinctId: user.id,
      event: 'forge.voice.transcribed',
      workspaceId: workspace.id,
      properties: {
        format,
        audioBytes: audio.size,
        latencyMs,
        textLength: text.length,
        language: resp.language ?? null,
      },
    });

    return NextResponse.json(
      {
        text,
        ...(resp.language !== undefined && { language: resp.language }),
      },
      { status: 200 },
    );
  },
  { routeName: 'forge.voice' },
);
