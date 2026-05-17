'use client';

/**
 * Error boundary for the authed route group.
 *
 * Receives `(error, reset)` from Next. We render a friendly message and a
 * "Retry" button that invokes `reset()` so the segment re-renders without
 * a full reload. The raw error message is shown in dev only — production
 * routes leak too much when the message comes from Prisma or Notion API.
 */
import * as React from 'react';
import { AlertOctagon } from 'lucide-react';

import { Button } from '@/components/ui/button';

export default function AuthedError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  React.useEffect(() => {
    // Sentry capture happens automatically via `@sentry/nextjs`; this is a
    // defensive console line for dev visibility.
    if (process.env.NODE_ENV !== 'production') {
      console.error('[authed/error]', error);
    }
  }, [error]);

  const showDetail = process.env.NODE_ENV !== 'production';

  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-4 rounded-xl border border-destructive/30 bg-destructive/5 px-8 py-12 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
        <AlertOctagon className="h-6 w-6" aria-hidden="true" />
      </div>
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">Something broke.</h2>
        <p className="text-sm text-muted-foreground">
          We&apos;ve been notified. Try again in a moment — if it keeps failing, ping the Forge
          team.
        </p>
        {showDetail ? (
          <pre className="mt-3 max-h-40 overflow-auto rounded border border-border bg-background p-3 text-left font-mono text-xs">
            {error.message}
            {error.digest ? `\n\ndigest: ${error.digest}` : ''}
          </pre>
        ) : null}
      </div>
      <Button onClick={reset} size="sm">
        Retry
      </Button>
    </div>
  );
}
