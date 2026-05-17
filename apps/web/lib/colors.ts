/**
 * Status → presentation-token mappings.
 *
 * Pure, dependency-free maps so they're usable from both Server and Client
 * components. Each map intentionally enumerates every union member — adding
 * a new enum member will fail TypeScript here, forcing the call sites to
 * pick a color/label before the new status reaches the UI.
 *
 * The strings returned are NOT Tailwind classes — they're our `Badge`
 * primitive's `variant` prop (see `components/ui/badge.tsx`). Going through
 * the variant indirection means dark mode just works (the badge tokens are
 * theme-aware) and a future color refresh is a one-file change.
 */
import type {
  AgentName,
  AgentPattern,
  AgentStatus,
  GenerationStatus,
  StepStatus,
} from '@forge/db';

import type { BadgeProps } from '@/components/ui/badge';

type BadgeVariant = NonNullable<BadgeProps['variant']>;

export const GENERATION_STATUS_VARIANT: Readonly<
  Record<GenerationStatus, BadgeVariant>
> = {
  queued: 'muted',
  running: 'accent',
  succeeded: 'success',
  failed: 'destructive',
  cancelled: 'warning',
};

export const GENERATION_STATUS_LABEL: Readonly<
  Record<GenerationStatus, string>
> = {
  queued: 'Queued',
  running: 'Running',
  succeeded: 'Succeeded',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export const STEP_STATUS_VARIANT: Readonly<Record<StepStatus, BadgeVariant>> =
  {
    running: 'accent',
    succeeded: 'success',
    failed: 'destructive',
    retrying: 'warning',
  };

export const STEP_STATUS_LABEL: Readonly<Record<StepStatus, string>> = {
  running: 'Running',
  succeeded: 'OK',
  failed: 'Failed',
  retrying: 'Retrying',
};

export const AGENT_STATUS_VARIANT: Readonly<Record<AgentStatus, BadgeVariant>> =
  {
    active: 'success',
    paused: 'warning',
    retracted: 'muted',
  };

export const AGENT_STATUS_LABEL: Readonly<Record<AgentStatus, string>> = {
  active: 'Active',
  paused: 'Paused',
  retracted: 'Retracted',
};

export const AGENT_PATTERN_LABEL: Readonly<Record<AgentPattern, string>> = {
  database_query: 'Database query',
  webhook_trigger: 'Webhook trigger',
  sync_source: 'Sync source',
  external_api_call: 'External API',
  multi_step: 'Multi-step',
};

export const AGENT_NAME_LABEL: Readonly<Record<AgentName, string>> = {
  schema_smith: 'Schema Smith',
  tool_coder: 'Tool Coder',
  inspector: 'Inspector',
  shipper: 'Shipper',
};
