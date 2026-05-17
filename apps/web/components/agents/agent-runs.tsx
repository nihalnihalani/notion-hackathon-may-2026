'use client';

/**
 * Client-side run history fetch for the agent detail page.
 *
 * The runs endpoint (`GET /api/agents/[id]/runs`) is owned by the Backend
 * Engineer and may not exist yet — we treat a 404 as a "not implemented"
 * empty state rather than an error so the rest of the page stays useful.
 *
 * We poll once on mount and on tab-focus; no streaming yet because the
 * underlying ntn-wrapper `listRuns` call doesn't support change streams.
 */
import * as React from 'react';
import { History, RefreshCw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/shared/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatDuration, formatRelativeDate } from '@/lib/formatters';

interface AgentRun {
  id: string;
  startedAt: string;
  durationMs: number | null;
  status: 'succeeded' | 'failed' | 'running';
  trigger: string;
}

interface AgentRunsResponse {
  runs: readonly AgentRun[];
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; runs: readonly AgentRun[] }
  | { kind: 'unsupported' }
  | { kind: 'error'; message: string };

export function AgentRuns({ agentId }: { agentId: string }) {
  const [state, setState] = React.useState<LoadState>({ kind: 'loading' });

  const load = React.useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      const res = await fetch(`/api/agents/${agentId}/runs`, {
        cache: 'no-store',
      });
      if (res.status === 404) {
        setState({ kind: 'unsupported' });
        return;
      }
      if (!res.ok) {
        throw new Error(`Failed to load runs (HTTP ${res.status})`);
      }
      const body = (await res.json()) as AgentRunsResponse;
      setState({ kind: 'ready', runs: body.runs });
    } catch (error) {
      setState({
        kind: 'error',
        message: error instanceof Error ? error.message : 'Failed to load runs',
      });
    }
  }, [agentId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  if (state.kind === 'loading') {
    return (
      <div className="space-y-2">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    );
  }

  if (state.kind === 'unsupported') {
    return (
      <EmptyState
        icon={History}
        title="Run history coming soon"
        description="Once the runs endpoint ships, the last invocations of this agent will appear here in real time."
      />
    );
  }

  if (state.kind === 'error') {
    return (
      <EmptyState
        icon={History}
        title="Couldn't load run history"
        description={state.message}
        action={
          <Button type="button" variant="outline" size="sm" onClick={() => void load()}>
            <RefreshCw className="h-3.5 w-3.5" /> Retry
          </Button>
        }
      />
    );
  }

  if (state.runs.length === 0) {
    return (
      <EmptyState
        icon={History}
        title="No runs yet"
        description="This agent hasn't been invoked. Mention it in Notion to trigger the first run."
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button type="button" variant="ghost" size="sm" onClick={() => void load()}>
          <RefreshCw className="h-3.5 w-3.5" /> Refresh
        </Button>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Started</TableHead>
            <TableHead>Trigger</TableHead>
            <TableHead className="text-right">Duration</TableHead>
            <TableHead className="text-right">Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {state.runs.map((r) => (
            <TableRow key={r.id}>
              <TableCell>{formatRelativeDate(r.startedAt)}</TableCell>
              <TableCell className="text-muted-foreground">{r.trigger}</TableCell>
              <TableCell className="text-right tabular-nums">
                {formatDuration(r.durationMs)}
              </TableCell>
              <TableCell className="text-right">
                <span
                  className={
                    r.status === 'succeeded'
                      ? 'text-success'
                      : r.status === 'failed'
                        ? 'text-destructive'
                        : 'text-muted-foreground'
                  }
                >
                  {r.status}
                </span>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
