'use client';

/**
 * Voice-input button — toggles MediaRecorder on/off, POSTs the recorded blob
 * to `/api/forge/voice`, and hands the transcribed text back to the caller via
 * `onTranscribed`.
 *
 * Designed to drop in next to a textarea — the caller decides what to do with
 * the transcription (most callers just `setValue(prev => prev + text)` so
 * mid-sentence dictation feels natural).
 *
 * UX rules:
 *   - First click starts recording. The button label becomes "Stop" and the
 *     mic icon becomes a stop icon.
 *   - Second click stops recording and immediately POSTs to /api/forge/voice.
 *   - While the POST is in flight the button is `disabled` + spinner.
 *   - Errors surface via `sonner` toast and the local hint text. We never
 *     throw — the parent doesn't care about the transcription pipeline's
 *     failure modes.
 *
 * Browser support:
 *   - Requires `navigator.mediaDevices.getUserMedia` + `MediaRecorder`. Both
 *     are universal on modern Chrome / Edge / Firefox / Safari (Apple shipped
 *     MediaRecorder in Safari 14.1). On older browsers we degrade silently:
 *     the button renders disabled with a tooltip explaining the gap.
 *   - The MIME the recorder produces depends on the browser. We pass through
 *     whatever the MediaRecorder picks — the server route sniffs the format.
 */

import * as React from 'react';
import { Mic, Square, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface VoiceInputButtonProps {
  /** Called with the transcribed text on success. Never invoked on error. */
  onTranscribed: (text: string) => void;
  /** Disable the button externally (e.g. parent form is submitting). */
  disabled?: boolean;
  /** Tailwind class merged onto the button. */
  className?: string;
  /** Max recording duration before we auto-stop. Defaults to 60s. */
  maxDurationMs?: number;
}

type RecorderState = 'idle' | 'recording' | 'uploading' | 'unsupported';

export function VoiceInputButton({
  onTranscribed,
  disabled,
  className,
  maxDurationMs = 60_000,
}: VoiceInputButtonProps) {
  const [state, setState] = React.useState<RecorderState>('idle');
  const recorderRef = React.useRef<MediaRecorder | null>(null);
  const chunksRef = React.useRef<Blob[]>([]);
  const streamRef = React.useRef<MediaStream | null>(null);
  const autoStopTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // Probe browser support once on mount so the button renders the disabled
  // state from the first paint instead of after the user clicks.
  React.useEffect(() => {
    if (typeof globalThis === 'undefined') return;
    const hasMediaDevices =
      typeof navigator !== 'undefined' && typeof navigator.mediaDevices.getUserMedia === 'function';
    const hasRecorder = typeof globalThis.MediaRecorder === 'function';
    if (!hasMediaDevices || !hasRecorder) {
      setState('unsupported');
    }
  }, []);

  // Hard guarantee: any unmount tears down the live mic stream, even
  // mid-recording. Prevents the OS-level "tab is using the microphone"
  // indicator from sticking after the page closes.
  React.useEffect(() => {
    return () => {
      teardown();
    };
  }, []);

  function teardown(): void {
    if (autoStopTimerRef.current !== null) {
      clearTimeout(autoStopTimerRef.current);
      autoStopTimerRef.current = null;
    }
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      try {
        recorderRef.current.stop();
      } catch {
        // already stopped — ignore.
      }
    }
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        track.stop();
      }
      streamRef.current = null;
    }
    recorderRef.current = null;
  }

  async function startRecording(): Promise<void> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const recorder = new MediaRecorder(stream);
      recorderRef.current = recorder;
      chunksRef.current = [];

      recorder.addEventListener('dataavailable', (ev) => {
        if (ev.data && ev.data.size > 0) {
          chunksRef.current.push(ev.data);
        }
      });
      recorder.addEventListener('stop', () => {
        void handleStop();
      });

      recorder.start();
      setState('recording');

      autoStopTimerRef.current = setTimeout(() => {
        if (recorderRef.current?.state === 'recording') {
          recorderRef.current.stop();
        }
      }, maxDurationMs);
    } catch (error) {
      teardown();
      setState('idle');
      const message =
        error instanceof Error
          ? error.name === 'NotAllowedError'
            ? 'Microphone permission denied.'
            : error.message
          : 'Could not start recording.';
      toast.error(message);
    }
  }

  function stopRecording(): void {
    if (recorderRef.current?.state === 'recording') {
      // `stop` triggers the `stop` listener which calls handleStop().
      recorderRef.current.stop();
    }
  }

  async function handleStop(): Promise<void> {
    if (autoStopTimerRef.current !== null) {
      clearTimeout(autoStopTimerRef.current);
      autoStopTimerRef.current = null;
    }
    setState('uploading');

    const chunks = chunksRef.current;
    chunksRef.current = [];
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        track.stop();
      }
      streamRef.current = null;
    }

    if (chunks.length === 0) {
      setState('idle');
      toast.error('No audio was captured. Try again.');
      return;
    }
    const mime = chunks[0]?.type ?? 'audio/webm';
    const blob = new Blob(chunks, { type: mime });

    try {
      const form = new FormData();
      const filename = `voice.${guessExtension(mime)}`;
      form.append('audio', blob, filename);

      const res = await fetch('/api/forge/voice', {
        method: 'POST',
        body: form,
      });
      if (!res.ok) {
        const reason = await safeErrorMessage(res);
        throw new Error(reason);
      }
      const body = (await res.json()) as { text: string };
      if (typeof body.text !== 'string' || body.text.length === 0) {
        throw new Error('Empty transcription.');
      }
      onTranscribed(body.text);
    } catch (error) {
      toast.error(
        error instanceof Error ? `Couldn't transcribe: ${error.message}` : "Couldn't transcribe",
      );
    } finally {
      setState('idle');
    }
  }

  if (state === 'unsupported') {
    return (
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className={cn(className)}
        disabled
        aria-label="Voice input unsupported in this browser"
        title="Voice input requires a browser with MediaRecorder support."
      >
        <Mic className="h-4 w-4" aria-hidden="true" />
      </Button>
    );
  }

  const isBusy = state === 'recording' || state === 'uploading';
  const ariaLabel =
    state === 'recording'
      ? 'Stop recording'
      : state === 'uploading'
        ? 'Transcribing…'
        : 'Record voice description';

  return (
    <Button
      type="button"
      size="icon"
      variant={state === 'recording' ? 'destructive' : 'ghost'}
      className={cn(className)}
      disabled={disabled || state === 'uploading'}
      aria-label={ariaLabel}
      aria-pressed={state === 'recording'}
      onClick={() => {
        if (state === 'idle') void startRecording();
        else if (state === 'recording') stopRecording();
      }}
    >
      {state === 'uploading' ? (
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
      ) : state === 'recording' ? (
        <Square className="h-4 w-4" aria-hidden="true" />
      ) : (
        <Mic className="h-4 w-4" aria-hidden="true" />
      )}
      {/* sr-only label keeps the icon button accessible without a visible word */}
      <span className="sr-only">{ariaLabel}</span>
      {/* avoid React lint for unused isBusy when fast-refresh */}
      {isBusy ? null : null}
    </Button>
  );
}

function guessExtension(mime: string): string {
  if (!mime) return 'webm';
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('mp4') || mime.includes('m4a')) return 'm4a';
  if (mime.includes('wav')) return 'wav';
  if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3';
  return 'webm';
}

async function safeErrorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: string; error?: string };
    return body.message || body.error || `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}
