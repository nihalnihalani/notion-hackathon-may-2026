'use client';

/**
 * "Describe an agent, forge it" form.
 *
 * Posts to `/api/forge/trigger` and routes the user based on the documented
 * status surface (PLAN §VI):
 *
 *   - 200 + `{ status: 'cached', agentId }` → push to /agents/:agentId
 *   - 202 + `{ status: 'queued', generationId }` → push to /generations/:id
 *   - 400 → toast `validation` issues
 *   - 401 → push to '/' (Clerk middleware also catches this)
 *   - 429 → toast retry-after seconds
 *   - 412/403 → toast the message (e.g. "finish Notion install first")
 *   - 502 / 5xx → toast a generic "couldn't enqueue" message
 *
 * The {@link VoiceInputButton} sits beside the textarea — calling it appends
 * the transcript to the current draft (so mid-sentence dictation feels
 * natural). The Force switch maps to the API's `force` flag, which bypasses
 * the 1h dedupe cache when the user wants a fresh build.
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Sparkles } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { VoiceInputButton } from '@/components/shared/voice-input-button';

const MAX_DESCRIPTION_LENGTH = 1000;

interface TriggerErrorBody {
  error?: string;
  message?: string;
  issues?: readonly { message?: string; path?: readonly (string | number)[] }[];
}

interface TriggerCachedBody {
  status: 'cached';
  generationId: string;
  agentId: string;
}

interface TriggerQueuedBody {
  status: 'queued';
  generationId: string;
}

type TriggerBody = TriggerCachedBody | TriggerQueuedBody;

export function NewAgentForm() {
  const router = useRouter();
  const [description, setDescription] = React.useState('');
  const [force, setForce] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);

  const trimmed = description.trim();
  const tooLong = trimmed.length > MAX_DESCRIPTION_LENGTH;
  const empty = trimmed.length === 0;
  const disabled = submitting || empty || tooLong;

  const onTranscribed = React.useCallback((text: string) => {
    setDescription((prev) => (prev.trim() ? `${prev.trimEnd()} ${text}` : text));
  }, []);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (disabled) return;
    setSubmitting(true);
    try {
      const res = await fetch('/api/forge/trigger', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ description: trimmed, force }),
      });

      if (res.status === 401) {
        router.push('/');
        return;
      }

      if (res.status === 429) {
        const retryAfter = res.headers.get('Retry-After');
        const seconds = retryAfter ? Number(retryAfter) : null;
        toast.error(
          seconds && Number.isFinite(seconds)
            ? `Rate limit hit. Try again in ${seconds}s.`
            : 'Rate limit hit. Try again shortly.',
        );
        return;
      }

      if (res.status === 400) {
        const body = (await safeJson<TriggerErrorBody>(res)) ?? {};
        const issues = body.issues ?? [];
        const first = issues[0]?.message;
        toast.error(first ?? body.message ?? 'Invalid description.');
        return;
      }

      if (res.status === 403 || res.status === 412) {
        const body = (await safeJson<TriggerErrorBody>(res)) ?? {};
        toast.error(body.message ?? "Can't forge yet — finish Notion install first.");
        return;
      }

      if (!res.ok) {
        const body = (await safeJson<TriggerErrorBody>(res)) ?? {};
        toast.error(body.message ?? "Couldn't enqueue your agent. Try again in a moment.");
        return;
      }

      const body = (await safeJson<TriggerBody>(res)) ?? null;
      if (!body) {
        toast.error('Forge returned an empty response. Try again.');
        return;
      }
      if (body.status === 'cached' && 'agentId' in body && body.agentId) {
        router.push(`/agents/${body.agentId}`);
        return;
      }
      if (body.status === 'queued' && body.generationId) {
        router.push(`/generations/${body.generationId}`);
        return;
      }
      toast.error('Unexpected response from Forge. Try again.');
    } catch (error) {
      toast.error(error instanceof Error ? `Couldn't forge: ${error.message}` : "Couldn't forge.");
    } finally {
      setSubmitting(false);
    }
  }

  const counterTone = tooLong ? 'text-destructive' : 'text-muted-foreground';

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      <div className="space-y-2">
        <div className="flex items-baseline justify-between">
          <Label htmlFor="new-agent-description">Describe your agent</Label>
          <span aria-live="polite" className={`text-xs tabular-nums ${counterTone}`}>
            {trimmed.length}/{MAX_DESCRIPTION_LENGTH}
          </span>
        </div>
        <div className="relative">
          <Textarea
            id="new-agent-description"
            value={description}
            onChange={(e) => {
              setDescription(e.currentTarget.value);
            }}
            placeholder="e.g. Every Monday, summarize last week's Linear bugs by severity and post into the Engineering Standup page."
            rows={6}
            maxLength={MAX_DESCRIPTION_LENGTH + 200}
            disabled={submitting}
            aria-invalid={tooLong ? true : undefined}
            aria-describedby="new-agent-description-help"
            className="pr-12"
            required
          />
          <div className="absolute right-2 top-2">
            <VoiceInputButton onTranscribed={onTranscribed} disabled={submitting} />
          </div>
        </div>
        <p id="new-agent-description-help" className="text-xs text-muted-foreground">
          Plain English. The orchestrator picks the right pattern (assistant, scheduled, webhook…)
          and connectors from your description.
        </p>
      </div>

      <div className="flex items-start justify-between gap-4 rounded-md border border-border bg-card/40 px-4 py-3">
        <div className="space-y-1">
          <Label htmlFor="new-agent-force" className="cursor-pointer">
            Force a fresh build
          </Label>
          <p className="text-xs text-muted-foreground">
            Bypass the 1-hour dedupe cache — useful when you tweaked the prompt and want a brand-new
            agent.
          </p>
        </div>
        <Switch
          id="new-agent-force"
          checked={force}
          onCheckedChange={setForce}
          disabled={submitting}
          aria-label="Force a fresh build"
        />
      </div>

      <div className="flex items-center justify-end gap-3">
        <Button
          type="submit"
          variant="forge"
          size="lg"
          disabled={disabled}
          aria-busy={submitting || undefined}
        >
          {submitting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              Forging…
            </>
          ) : (
            <>
              <Sparkles className="h-4 w-4" aria-hidden="true" />
              Forge this agent
            </>
          )}
        </Button>
      </div>
    </form>
  );
}

async function safeJson<T>(res: Response): Promise<T | null> {
  try {
    return (await res.json()) as T;
  } catch {
    return null;
  }
}
