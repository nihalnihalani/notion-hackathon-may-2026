/**
 * Empty state — single visual treatment used everywhere a list or table
 * has zero rows.
 *
 * Designed (not "no data" text): consistent icon framing + a CTA encourages
 * users to take the obvious next action.
 */
import type { LucideIcon } from 'lucide-react';

import { cn } from '@/lib/utils';

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed bg-muted/30 px-6 py-12 text-center',
        className
      )}
    >
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-background ring-1 ring-border">
        <Icon
          className="h-6 w-6 text-muted-foreground"
          aria-hidden="true"
        />
      </div>
      <div className="space-y-1">
        <p className="text-base font-medium text-foreground">{title}</p>
        {description ? (
          <p className="max-w-sm text-sm text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
