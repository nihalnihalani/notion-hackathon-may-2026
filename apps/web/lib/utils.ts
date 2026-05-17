/**
 * Tailwind class-name merger used by every primitive in `components/ui`.
 *
 * `clsx` collapses falsy entries; `twMerge` resolves Tailwind conflicts (e.g.
 * `px-2 px-4` → `px-4`). The shadcn convention exposes the result under the
 * single short name `cn`.
 */
import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
