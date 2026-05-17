/**
 * Skeleton — placeholder rectangle for Suspense fallbacks.
 *
 * Uses a pulsing background instead of a moving shimmer because the moving
 * gradient can be distracting when many skeletons are visible at once (and
 * fails the `prefers-reduced-motion` test more obviously).
 */
import { cn } from '@/lib/utils';

function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'animate-pulse rounded-md bg-muted motion-reduce:animate-none',
        className
      )}
      {...props}
    />
  );
}

export { Skeleton };
