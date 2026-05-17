/**
 * Status badge — typed wrapper around `<Badge>` that maps a Generation /
 * Step / Agent status enum to the correct variant + label.
 *
 * Server-component safe (no client hooks). Keeps every status pill on the
 * dashboard visually consistent.
 */
import type {
  AgentStatus,
  GenerationStatus,
  StepStatus,
} from '@forge/db';

import { Badge } from '@/components/ui/badge';
import {
  AGENT_STATUS_LABEL,
  AGENT_STATUS_VARIANT,
  GENERATION_STATUS_LABEL,
  GENERATION_STATUS_VARIANT,
  STEP_STATUS_LABEL,
  STEP_STATUS_VARIANT,
} from '@/lib/colors';

type Kind = 'generation' | 'step' | 'agent';

type StatusOf<K extends Kind> = K extends 'generation'
  ? GenerationStatus
  : K extends 'step'
    ? StepStatus
    : AgentStatus;

interface StatusBadgeProps<K extends Kind> {
  kind: K;
  status: StatusOf<K>;
  className?: string;
}

export function StatusBadge<K extends Kind>({
  kind,
  status,
  className,
}: StatusBadgeProps<K>) {
  if (kind === 'generation') {
    const s = status as GenerationStatus;
    return (
      <Badge variant={GENERATION_STATUS_VARIANT[s]} className={className}>
        {GENERATION_STATUS_LABEL[s]}
      </Badge>
    );
  }
  if (kind === 'step') {
    const s = status as StepStatus;
    return (
      <Badge variant={STEP_STATUS_VARIANT[s]} className={className}>
        {STEP_STATUS_LABEL[s]}
      </Badge>
    );
  }
  const s = status as AgentStatus;
  return (
    <Badge variant={AGENT_STATUS_VARIANT[s]} className={className}>
      {AGENT_STATUS_LABEL[s]}
    </Badge>
  );
}
