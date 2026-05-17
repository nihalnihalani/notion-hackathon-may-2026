'use client';

/**
 * Client-side run history and log fetch for the agent detail page.
 *
 * We poll once on mount and let the user refresh manually. NTN's listRuns
 * call does not expose change streams, so there is no live subscription here.
 */
import * as React from 'react';
import { FileText, History, Loader2, RefreshCw } from 'lucide-react';

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
  runId: string;
  startedAt: string | null;
  durationMs: number | null;
  status: string | null;
  exitCode: number | null;
  trigger: string;
}

interface AgentRunsResponse {
  runs: readonly AgentRun[];
  nextCursor: string | null;
}

interface AgentRunLogResponse {
  runId: string;
  logs: string;
  lines: readonly string[];
  exitCode: number | null;
  startedAt: string | null;
  durationMs: number | null;
  status: string | null;
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; runs: readonly AgentRun[]; nextCursor: string | null }
  | { kind: 'error'; message: string };

type LogState =
  | { kind: 'idle' }
  | { kind: 'loading'; runId: string }
  | { kind: 'ready'; runId: string; logs: string }
  | { kind: 'error'; runId: string; message: string };

export function AgentRuns({ agentId }: { agentId: string }) {
  const [state, setState] = React.useState<LoadState>({ kind: 'loading' });
  const [logState, setLogState] = React.useState<LogState>({ kind: 'idle' });

  const load = React.useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      const res = await fetch(`/api/agents/${agentId}/runs`, {
        cache: 'no-store',
      });
      if (!res.ok) {
        throw new Error(`Failed to load runs (HTTP ${res.status})`);
      }
      const body = (await res.json()) as AgentRunsResponse;
      setState({ kind: 'ready', runs: body.runs, nextCursor: body.nextCursor });
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

  const loadLogs = React.useCallback(
    async (runId: string) => {
      setLogState({ kind: 'loading', runId });
      try {
        const res = await fetch(`/api/agents/${agentId}/runs/${runId}`, {
          cache: 'no-store',
        });
        if (!res.ok) {
          throw new Error(`Failed to load logs (HTTP ${res.status})`);
        }
        const body = (await res.json()) as AgentRunLogResponse;
        setLogState({ kind: 'ready', runId, logs: body.logs });
      } catch (error) {
        setLogState({
          kind: 'error',
          runId,
          message: error instanceof Error ? error.message : 'Failed to load logs',
        });
      }
    },
    [agentId],
  );

  if (state.kind === 'loading') {
    return (
      <div className="space-y-2">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
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
            <TableHead>Exit</TableHead>
            <TableHead className="text-right">Duration</TableHead>
            <TableHead className="text-right">Status</TableHead>
            <TableHead className="text-right">Logs</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {state.runs.map((r) => (
            <TableRow key={r.id}>
              <TableCell>{formatRelativeDate(r.startedAt)}</TableCell>
              <TableCell className="text-muted-foreground">{r.trigger}</TableCell>
              <TableCell className="tabular-nums text-muted-foreground">
                {r.exitCode ?? '—'}
              </TableCell>
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
                  {r.status ?? 'unknown'}
                </span>
              </TableCell>
              <TableCell className="text-right">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => void loadLogs(r.runId)}
                  aria-label={`View logs for run ${r.runId}`}
                >
                  {logState.kind === 'loading' && logState.runId === r.runId ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <FileText className="h-3.5 w-3.5" />
                  )}
                  Logs
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {logState.kind === 'ready' ? (
        <div className="rounded-md border bg-muted/30 p-3">
          <div className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <FileText className="h-3.5 w-3.5" /> {logState.runId}
          </div>
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap font-mono text-xs leading-5">
            {logState.logs || 'No logs returned for this run.'}
          </pre>
        </div>
      ) : null}
      {logState.kind === 'error' ? (
        <EmptyState
          icon={FileText}
          title="Couldn't load run logs"
          description={logState.message}
          action={
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void loadLogs(logState.runId)}
            >
              <RefreshCw className="h-3.5 w-3.5" /> Retry
            </Button>
          }
        />
      ) : null}
    </div>
  );
}
