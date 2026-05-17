'use client';

/**
 * Danger-zone card. Single action today: uninstall Forge from the workspace.
 * Requires the user to type the workspace name to confirm — guards against
 * autopilot clicks.
 */
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';

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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface DangerZoneProps {
  workspaceName: string;
}

export function DangerZone({ workspaceName }: DangerZoneProps) {
  const router = useRouter();
  const [confirmText, setConfirmText] = React.useState('');
  const [pending, setPending] = React.useState(false);

  const canConfirm = confirmText.trim() === workspaceName;

  const onUninstall = async () => {
    setPending(true);
    try {
      const res = await fetch('/api/settings/uninstall', {
        method: 'POST',
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          message?: string;
        } | null;
        throw new Error(body?.message ?? `HTTP ${res.status}`);
      }
      toast.success('Forge uninstalled.');
      router.push('/');
    } catch (error) {
      toast.error(
        error instanceof Error ? `Uninstall failed: ${error.message}` : 'Uninstall failed',
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="space-y-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4">
      <div className="flex items-start gap-3">
        <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-destructive" aria-hidden="true" />
        <div className="space-y-1">
          <p className="text-sm font-medium text-foreground">
            Uninstall Forge from {workspaceName}
          </p>
          <p className="text-sm text-muted-foreground">
            Removes the Forge page + databases from your Notion workspace and retracts every
            deployed agent. Generation history is preserved for audit.
          </p>
        </div>
      </div>
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button variant="destructive" size="sm">
            Uninstall Forge
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Uninstall Forge from this workspace?</AlertDialogTitle>
            <AlertDialogDescription>
              Type <span className="font-medium text-foreground">{workspaceName}</span> to confirm.
              Every active agent will stop responding immediately.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="uninstall-confirm">Workspace name</Label>
            <Input
              id="uninstall-confirm"
              value={confirmText}
              onChange={(e) => {
                setConfirmText(e.currentTarget.value);
              }}
              placeholder={workspaceName}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={!canConfirm || pending}
              onClick={(e) => {
                e.preventDefault();
                if (canConfirm) void onUninstall();
              }}
            >
              {pending ? 'Uninstalling…' : 'I understand — uninstall'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
