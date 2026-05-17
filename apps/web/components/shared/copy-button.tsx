'use client';

/**
 * Copy-to-clipboard button.
 *
 * Behavior:
 *   - Single click copies the `value` to the clipboard.
 *   - Switches the icon to a check for 1.5s as visual confirmation, then
 *     reverts. Avoids `toast()` for this because a copy is the textbook case
 *     where inline feedback is faster + less noisy than a global toast.
 *   - Falls back to `document.execCommand('copy')` on the rare browser where
 *     `navigator.clipboard.writeText` is unavailable (Safari iframe, very
 *     old Chrome). Failure surfaces via `aria-live`.
 */
import * as React from 'react';
import { Check, Copy } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface CopyButtonProps {
  value: string;
  label?: string;
  className?: string;
  size?: React.ComponentProps<typeof Button>['size'];
  variant?: React.ComponentProps<typeof Button>['variant'];
}

export function CopyButton({
  value,
  label = 'Copy',
  className,
  size = 'sm',
  variant = 'outline',
}: CopyButtonProps) {
  const [state, setState] = React.useState<'idle' | 'copied' | 'error'>(
    'idle'
  );
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cancel pending timer on unmount so we don't `setState` after teardown.
  React.useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const copy = React.useCallback(async () => {
    try {
      if (
        typeof navigator !== 'undefined' &&
        navigator.clipboard?.writeText
      ) {
        await navigator.clipboard.writeText(value);
      } else if (typeof document !== 'undefined') {
        // Fallback for browsers without Async Clipboard API.
        const ta = document.createElement('textarea');
        ta.value = value;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      } else {
        throw new Error('Clipboard API unavailable.');
      }
      setState('copied');
    } catch {
      setState('error');
    } finally {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setState('idle'), 1500);
    }
  }, [value]);

  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      onClick={copy}
      aria-label={
        state === 'copied'
          ? 'Copied to clipboard'
          : state === 'error'
            ? 'Copy failed'
            : label
      }
      className={cn('gap-1.5', className)}
    >
      {state === 'copied' ? (
        <Check className="h-3.5 w-3.5" aria-hidden="true" />
      ) : (
        <Copy className="h-3.5 w-3.5" aria-hidden="true" />
      )}
      <span>{state === 'copied' ? 'Copied' : label}</span>
    </Button>
  );
}
