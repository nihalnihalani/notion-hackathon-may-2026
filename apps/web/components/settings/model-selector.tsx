'use client';

/**
 * Default-model selector — posts to /api/settings/default-model.
 *
 * Optimistic update via React's `useTransition` so the dropdown stays
 * responsive; on failure we revert to the server value and toast.
 */
import * as React from 'react';
import { toast } from 'sonner';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export type DefaultModel = 'gpt-5.5' | 'gpt-5.4-mini' | 'claude-opus-4-7' | 'auto';

interface ModelSelectorProps {
  initial: DefaultModel;
}

const OPTIONS: readonly { value: DefaultModel; label: string }[] = [
  { value: 'auto', label: 'Auto (Forge picks)' },
  { value: 'gpt-5.5', label: 'GPT-5.5' },
  { value: 'gpt-5.4-mini', label: 'GPT-5.4 mini' },
  { value: 'claude-opus-4-7', label: 'Claude Opus 4.7' },
];

export function ModelSelector({ initial }: ModelSelectorProps) {
  const [value, setValue] = React.useState<DefaultModel>(initial);
  const [pending, startTransition] = React.useTransition();

  const onChange = (next: string) => {
    const prev = value;
    setValue(next as DefaultModel);
    startTransition(async () => {
      try {
        const res = await fetch('/api/settings/default-model', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: next }),
        });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        toast.success('Default model updated');
      } catch (error) {
        setValue(prev);
        toast.error(error instanceof Error ? `Couldn't save: ${error.message}` : "Couldn't save");
      }
    });
  };

  return (
    <Select value={value} onValueChange={onChange} disabled={pending}>
      <SelectTrigger className="w-72" aria-label="Default model">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {OPTIONS.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
