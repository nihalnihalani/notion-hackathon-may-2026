'use client';

/**
 * Per-row actions on the agents table.
 *
 * Each action wraps the matching `/api/agents/:id/*` route in:
 *   - A confirmation step (AlertDialog for destructive, inline state for
 *     reversible pause/resume/redeploy).
 *   - A loading state on the button while in flight.
 *   - A toast for success/failure (sonner).
 *
 * On success we call `router.refresh()` so the server-rendered table
 * re-fetches and reflects the new status — keeps the UI source-of-truth on
 * the server.
 */
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { MoreHorizontal, Pause, Play, Repeat, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import type { AgentStatus } from '@forge/db';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

interface AgentActionsProps {
  agentId: string;
  agentName: string;
  status: AgentStatus;
}

type ActionKind = 'pause' | 'resume' | 'redeploy' | 'delete';

export function AgentActions({ agentId, agentName, status }: AgentActionsProps) {
  const router = useRouter();
  const [pending, setPending] = React.useState<ActionKind | null>(null);
  const [confirmDelete, setConfirmDelete] = React.useState(false);

  const run = React.useCallback(
    async (kind: Exclude<ActionKind, 'delete'>) => {
      setPending(kind);
      try {
        const res = await fetch(`/api/agents/${agentId}/${kind}`, {
          method: 'POST',
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as {
            message?: string;
          } | null;
          throw new Error(body?.message ?? `Failed to ${kind}`);
        }
        toast.success(
          kind === 'pause'
            ? `Paused ${agentName}`
            : kind === 'resume'
              ? `Resumed ${agentName}`
              : `Redeployed ${agentName}`,
        );
        router.refresh();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : `Failed to ${kind}`);
      } finally {
        setPending(null);
      }
    },
    [agentId, agentName, router],
  );

  const runDelete = React.useCallback(async () => {
    setPending('delete');
    try {
      const res = await fetch(`/api/agents/${agentId}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          message?: string;
        } | null;
        throw new Error(body?.message ?? 'Failed to delete agent');
      }
      toast.success(`Deleted ${agentName}`);
      setConfirmDelete(false);
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to delete agent');
    } finally {
      setPending(null);
    }
  }, [agentId, agentName, router]);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Actions for ${agentName}`}
            disabled={pending !== null}
          >
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>Manage</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {status === 'active' ? (
            <DropdownMenuItem
              disabled={pending !== null}
              onSelect={(e) => {
                e.preventDefault();
                void run('pause');
              }}
            >
              <Pause className="h-4 w-4" /> Pause
            </DropdownMenuItem>
          ) : status === 'paused' ? (
            <DropdownMenuItem
              disabled={pending !== null}
              onSelect={(e) => {
                e.preventDefault();
                void run('resume');
              }}
            >
              <Play className="h-4 w-4" /> Resume
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem
            disabled={pending !== null || status === 'retracted'}
            onSelect={(e) => {
              e.preventDefault();
              void run('redeploy');
            }}
          >
            <Repeat className="h-4 w-4" /> Re-deploy
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="text-destructive focus:bg-destructive/10 focus:text-destructive"
            disabled={pending !== null || status === 'retracted'}
            onSelect={(e) => {
              e.preventDefault();
              setConfirmDelete(true);
            }}
          >
            <Trash2 className="h-4 w-4" /> Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogTrigger asChild>
          {/* hidden trigger — opened via state */}
          <span hidden />
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {agentName}?</AlertDialogTitle>
            <AlertDialogDescription>
              This will retract the agent from your Notion workspace and soft-delete its record. Run
              history is preserved for audit but the agent will stop responding immediately. This
              cannot be undone from the dashboard.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending === 'delete'}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={pending === 'delete'}
              onClick={(e) => {
                e.preventDefault();
                void runDelete();
              }}
            >
              {pending === 'delete' ? 'Deleting…' : 'Delete agent'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
