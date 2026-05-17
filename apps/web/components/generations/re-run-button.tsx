'use client';

/**
 * "Re-run with same prompt" button.
 *
 * Calls POST /api/forge/trigger with `{ generationId, force: true }`. The
 * API contract (PLAN §VI) returns the new generation id on success which
 * we route to.
 */
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { RefreshCcw } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';

interface ReRunButtonProps {
  generationId: string;
}

interface TriggerResponse {
  generationId: string;
}

export function ReRunButton({ generationId }: ReRunButtonProps) {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);

  const run = React.useCallback(async () => {
    setPending(true);
    try {
      const res = await fetch('/api/forge/trigger', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ generationId, force: true }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          message?: string;
        } | null;
        throw new Error(body?.message ?? 'Failed to re-run');
      }
      const body = (await res.json()) as TriggerResponse;
      toast.success('Re-running generation');
      router.push(`/generations/${body.generationId}`);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to re-run');
    } finally {
      setPending(false);
    }
  }, [generationId, router]);

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={pending}
      onClick={() => void run()}
    >
      <RefreshCcw className="h-3.5 w-3.5" />
      {pending ? 'Re-running…' : 'Re-run with same prompt'}
    </Button>
  );
}
