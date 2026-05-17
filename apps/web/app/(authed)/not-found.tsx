import Link from 'next/link';
import { Compass } from 'lucide-react';

import { Button } from '@/components/ui/button';

/**
 * Not-found boundary for authed routes (agent/generation IDs that don't
 * exist or don't belong to the workspace).
 */
export default function AuthedNotFound() {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-4 rounded-xl border border-border bg-card px-8 py-12 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
        <Compass className="h-6 w-6" aria-hidden="true" />
      </div>
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">Page not found.</h2>
        <p className="text-sm text-muted-foreground">
          The resource you&apos;re looking for either doesn&apos;t exist or
          belongs to another workspace.
        </p>
      </div>
      <Button asChild>
        <Link href="/dashboard">Back to overview</Link>
      </Button>
    </div>
  );
}
