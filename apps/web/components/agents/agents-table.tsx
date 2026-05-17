'use client';

/**
 * Agents table — client component that filters/searches a server-provided
 * list. Filtering is done client-side because the dataset per workspace is
 * small (hundreds at most for the foreseeable future); the round-trip cost
 * of a server filter is not worth the JS savings.
 *
 * Row data is passed in already serialized (Decimal → number, Date → string)
 * by the parent server page; see `app/(authed)/agents/page.tsx` for the
 * shape contract.
 */
import * as React from 'react';
import Link from 'next/link';
import { Bot, Search } from 'lucide-react';

import type { AgentPattern, AgentStatus } from '@forge/db';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/shared/empty-state';
import { Input } from '@/components/ui/input';
import { StatusBadge } from '@/components/shared/status-badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { AgentActions } from '@/components/agents/agent-actions';
import { AGENT_PATTERN_LABEL } from '@/lib/colors';
import {
  formatCount,
  formatRelativeDate,
  formatUsd,
} from '@/lib/formatters';
import { cn } from '@/lib/utils';

export interface AgentRow {
  id: string;
  ntnWorkerName: string;
  description: string;
  pattern: AgentPattern;
  status: AgentStatus;
  lastInvokedAt: string | null;
  totalInvocations: number;
  monthlyCostUsd: number | null;
}

interface AgentsTableProps {
  agents: ReadonlyArray<AgentRow>;
}

type Filter = 'all' | AgentStatus;

const FILTERS: ReadonlyArray<{ key: Filter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'active', label: 'Active' },
  { key: 'paused', label: 'Paused' },
  { key: 'retracted', label: 'Retracted' },
];

export function AgentsTable({ agents }: AgentsTableProps) {
  const [filter, setFilter] = React.useState<Filter>('all');
  const [search, setSearch] = React.useState('');

  const filtered = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    return agents.filter((a) => {
      if (filter !== 'all' && a.status !== filter) return false;
      if (!q) return true;
      return (
        a.ntnWorkerName.toLowerCase().includes(q) ||
        a.description.toLowerCase().includes(q)
      );
    });
  }, [agents, filter, search]);

  // Compute filter chip counts once per agents prop change.
  const counts = React.useMemo<Record<Filter, number>>(() => {
    const init: Record<Filter, number> = {
      all: agents.length,
      active: 0,
      paused: 0,
      retracted: 0,
    };
    for (const a of agents) init[a.status] += 1;
    return init;
  }, [agents]);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-2" role="tablist">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              role="tab"
              aria-selected={filter === f.key}
              onClick={() => setFilter(f.key)}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                filter === f.key
                  ? 'border-primary/40 bg-primary/10 text-primary'
                  : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground'
              )}
            >
              {f.label}
              <Badge variant="muted" className="px-1.5 py-0">
                {counts[f.key]}
              </Badge>
            </button>
          ))}
        </div>
        <div className="relative w-full sm:w-64">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.currentTarget.value)}
            placeholder="Search agents…"
            className="pl-8"
            aria-label="Search agents"
          />
        </div>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={Bot}
          title={
            agents.length === 0 ? 'No agents yet' : 'No matching agents'
          }
          description={
            agents.length === 0
              ? 'Click ⚡ Forge this Agent in your Notion workspace to create your first one.'
              : 'Try a different filter or clear your search.'
          }
          action={
            agents.length > 0 ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setFilter('all');
                  setSearch('');
                }}
              >
                Clear filters
              </Button>
            ) : null
          }
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Description</TableHead>
              <TableHead>Pattern</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Last run</TableHead>
              <TableHead className="text-right">Invocations</TableHead>
              <TableHead className="text-right">Cost / mo</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((a) => (
              <TableRow key={a.id}>
                <TableCell className="font-medium">
                  <Link
                    href={`/agents/${a.id}`}
                    className="hover:underline"
                  >
                    {a.ntnWorkerName}
                  </Link>
                </TableCell>
                <TableCell className="max-w-sm truncate text-muted-foreground">
                  {a.description}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {AGENT_PATTERN_LABEL[a.pattern]}
                </TableCell>
                <TableCell>
                  <StatusBadge kind="agent" status={a.status} />
                </TableCell>
                <TableCell className="text-right text-muted-foreground">
                  {a.lastInvokedAt
                    ? formatRelativeDate(a.lastInvokedAt)
                    : 'Never'}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatCount(a.totalInvocations)}
                </TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">
                  {formatUsd(a.monthlyCostUsd)}
                </TableCell>
                <TableCell className="text-right">
                  <AgentActions
                    agentId={a.id}
                    agentName={a.ntnWorkerName}
                    status={a.status}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
