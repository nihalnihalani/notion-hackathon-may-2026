'use client';

/**
 * Build log — per-step trail with expandable JSON for debugging.
 *
 * Mirrors the Notion-side Build Log but adds raw inputJson/outputJson/
 * errorJson blocks the dashboard user can crack open. Designed for the
 * "why did my generation fail?" case.
 *
 * Step rows are click-to-expand (no nested scroll regions — keeps mobile
 * usable). Errors auto-expand on first render so users land on the failure
 * without an extra click.
 */
import * as React from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Clock,
  Loader2,
  XCircle,
} from 'lucide-react';

import type { AgentName, StepStatus } from '@forge/db';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { AGENT_NAME_LABEL } from '@/lib/colors';
import {
  formatAbsoluteDate,
  formatDuration,
  formatRelativeDate,
  formatUsd,
} from '@/lib/formatters';

export interface BuildLogStep {
  id: string;
  agent: AgentName;
  attempt: number;
  status: StepStatus;
  modelUsed: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  costUsd: number | null;
  latencyMs: number | null;
  startedAt: string;
  completedAt: string | null;
  inputJson: unknown;
  outputJson: unknown;
  errorJson: unknown;
}

interface BuildLogProps {
  steps: ReadonlyArray<BuildLogStep>;
}

export function BuildLog({ steps }: BuildLogProps) {
  if (steps.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-border bg-muted/30 px-4 py-8 text-center text-sm text-muted-foreground">
        No steps recorded yet. The orchestrator may be queued — refresh in a
        few seconds.
      </p>
    );
  }

  return (
    <ol className="space-y-2">
      {steps.map((step) => (
        <BuildLogRow key={step.id} step={step} />
      ))}
    </ol>
  );
}

function BuildLogRow({ step }: { step: BuildLogStep }) {
  const [open, setOpen] = React.useState(step.status === 'failed');

  const tokens =
    (step.promptTokens ?? 0) + (step.completionTokens ?? 0) || null;

  return (
    <li className="overflow-hidden rounded-lg border border-border bg-card">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/40"
      >
        <StatusIcon status={step.status} />
        <div className="flex-1 space-y-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">
              {AGENT_NAME_LABEL[step.agent]}
            </span>
            {step.attempt > 1 ? (
              <Badge variant="warning">attempt {step.attempt}</Badge>
            ) : null}
            {step.modelUsed ? (
              <Badge variant="muted">{step.modelUsed}</Badge>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">
            <time
              dateTime={step.startedAt}
              title={formatAbsoluteDate(step.startedAt)}
            >
              {formatRelativeDate(step.startedAt)}
            </time>
            {step.latencyMs !== null
              ? ` · ${formatDuration(step.latencyMs)}`
              : ''}
            {tokens !== null
              ? ` · ${tokens.toLocaleString()} tokens`
              : ''}
            {step.costUsd !== null
              ? ` · ${formatUsd(step.costUsd)}`
              : ''}
          </p>
        </div>
        <ChevronDown
          className={cn(
            'h-4 w-4 text-muted-foreground transition-transform',
            open && 'rotate-180'
          )}
          aria-hidden="true"
        />
      </button>

      {open ? (
        <div className="space-y-3 border-t border-border bg-muted/30 px-4 py-3 text-xs">
          <JsonBlock label="Input" value={step.inputJson} />
          <JsonBlock label="Output" value={step.outputJson} />
          {step.errorJson ? (
            <JsonBlock label="Error" value={step.errorJson} tone="error" />
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function StatusIcon({ status }: { status: StepStatus }) {
  if (status === 'succeeded') {
    return (
      <CheckCircle2
        className="h-5 w-5 shrink-0 text-success"
        aria-label="Succeeded"
      />
    );
  }
  if (status === 'failed') {
    return (
      <XCircle
        className="h-5 w-5 shrink-0 text-destructive"
        aria-label="Failed"
      />
    );
  }
  if (status === 'retrying') {
    return (
      <AlertTriangle
        className="h-5 w-5 shrink-0 text-warning"
        aria-label="Retrying"
      />
    );
  }
  if (status === 'running') {
    return (
      <Loader2
        className="h-5 w-5 shrink-0 animate-spin text-primary"
        aria-label="Running"
      />
    );
  }
  return (
    <Clock
      className="h-5 w-5 shrink-0 text-muted-foreground"
      aria-label={status}
    />
  );
}

function JsonBlock({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: unknown;
  tone?: 'default' | 'error';
}) {
  if (value === null || value === undefined) {
    return null;
  }
  const json = (() => {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  })();

  return (
    <div className="space-y-1">
      <p
        className={cn(
          'text-[10px] font-medium uppercase tracking-widest',
          tone === 'error'
            ? 'text-destructive'
            : 'text-muted-foreground'
        )}
      >
        {label}
      </p>
      <pre
        className={cn(
          'max-h-72 overflow-auto rounded border border-border bg-background p-3 font-mono text-[11px] leading-relaxed',
          tone === 'error' && 'border-destructive/40'
        )}
      >
        {json}
      </pre>
    </div>
  );
}
