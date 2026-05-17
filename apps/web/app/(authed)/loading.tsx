import { Skeleton } from '@/components/ui/skeleton';

/**
 * Default loading state for any authed route that doesn't define its own.
 * Renders a generic page-shell skeleton that matches the visual rhythm of
 * the real pages (header + 4-up metric row + table).
 */
export default function AuthedLoading() {
  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <Skeleton className="h-7 w-44" />
        <Skeleton className="h-4 w-72" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-28 w-full rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-72 w-full rounded-xl" />
      <Skeleton className="h-64 w-full rounded-xl" />
    </div>
  );
}
