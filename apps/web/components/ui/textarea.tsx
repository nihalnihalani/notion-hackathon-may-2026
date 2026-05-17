/**
 * Textarea primitive — ported verbatim from the canonical shadcn/ui source so
 * it stays bug-compatible with the upstream library. Visual treatment mirrors
 * the {@link Input} primitive (same border, padding, focus ring) so they sit
 * cleanly next to each other in forms.
 *
 * No external runtime deps beyond `cn` (clsx + tailwind-merge) — this is a
 * thin styled wrapper around the native `<textarea>` element.
 */
import * as React from 'react';

import { cn } from '@/lib/utils';

const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => {
  return (
    <textarea
      className={cn(
        'flex min-h-[80px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      ref={ref}
      {...props}
    />
  );
});
Textarea.displayName = 'Textarea';

export { Textarea };
