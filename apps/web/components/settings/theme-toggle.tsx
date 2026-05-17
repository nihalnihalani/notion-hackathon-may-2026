'use client';

/**
 * Theme toggle for Settings — three-way (System / Light / Dark) using
 * `next-themes`. Renders a Select so the choice is explicit.
 */
import { Monitor, Moon, Sun } from 'lucide-react';
import { useTheme } from 'next-themes';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();

  return (
    <Select value={theme ?? 'system'} onValueChange={setTheme}>
      <SelectTrigger className="w-48" aria-label="Theme">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="system">
          <span className="inline-flex items-center gap-2">
            <Monitor className="h-3.5 w-3.5" /> System
          </span>
        </SelectItem>
        <SelectItem value="light">
          <span className="inline-flex items-center gap-2">
            <Sun className="h-3.5 w-3.5" /> Light
          </span>
        </SelectItem>
        <SelectItem value="dark">
          <span className="inline-flex items-center gap-2">
            <Moon className="h-3.5 w-3.5" /> Dark
          </span>
        </SelectItem>
      </SelectContent>
    </Select>
  );
}
