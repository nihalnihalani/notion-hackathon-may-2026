'use client';

/**
 * Expandable row inside the failures table — opens to show the diff JSON.
 */
import * as React from 'react';
import { ChevronDown, XCircle } from 'lucide-react';

import { TableCell, TableRow } from '@/components/ui/table';
import { AGENT_NAME_LABEL } from '@/lib/colors';
import type { AgentName } from '@forge/db';
import { formatAbsoluteDate, formatRelativeDate } from '@/lib/formatters';
import { cn } from '@/lib/utils';

export interface FailureRowData {
  id: string;
  agent: AgentName;
  modelUsed: string;
  goldenInputHash: string;
  diffJson: unknown;
  runAt: string;
}

export function FailureRow({ row }: { row: FailureRowData }) {
  const [open, setOpen] = React.useState(false);

  return (
    <>
      <TableRow>
        <TableCell>
          <button
            type="button"
            onClick={() => {
              setOpen((o) => !o);
            }}
            aria-expanded={open}
            className="flex items-center gap-1 text-sm font-medium hover:underline"
          >
            <ChevronDown
              className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')}
              aria-hidden="true"
            />
            <XCircle className="h-3.5 w-3.5 text-destructive" aria-hidden="true" />
            {AGENT_NAME_LABEL[row.agent]}
          </button>
        </TableCell>
        <TableCell className="text-muted-foreground">
          <code className="font-mono text-xs">{row.goldenInputHash.slice(0, 10)}…</code>
        </TableCell>
        <TableCell className="text-muted-foreground">{row.modelUsed}</TableCell>
        <TableCell
          className="text-right text-muted-foreground"
          title={formatAbsoluteDate(row.runAt)}
        >
          {formatRelativeDate(row.runAt)}
        </TableCell>
      </TableRow>
      {open ? (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={4} className="bg-muted/30">
            <pre className="max-h-72 overflow-auto rounded border border-border bg-background p-3 font-mono text-[11px] leading-relaxed">
              {row.diffJson === null || row.diffJson === undefined
                ? '(no diff captured)'
                : JSON.stringify(row.diffJson, null, 2)}
            </pre>
          </TableCell>
        </TableRow>
      ) : null}
    </>
  );
}
