'use client';

/**
 * API keys card. Renders the existing keys (label + prefix only — full
 * value is hidden) and a button that opens a Dialog to mint a new key.
 *
 * The freshly created key is shown ONCE inside the Dialog with a Copy
 * button; on close it's gone from memory.
 */
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { KeyRound, Plus, Trash2 } from 'lucide-react';
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
import { CopyButton } from '@/components/shared/copy-button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { EmptyState } from '@/components/shared/empty-state';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { formatRelativeDate } from '@/lib/formatters';

export interface ApiKeyRow {
  id: string;
  label: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
}

interface ApiKeysCardProps {
  keys: readonly ApiKeyRow[];
}

export function ApiKeysCard({ keys }: ApiKeysCardProps) {
  const router = useRouter();
  const [createOpen, setCreateOpen] = React.useState(false);
  const [label, setLabel] = React.useState('');
  const [creating, setCreating] = React.useState(false);
  const [secret, setSecret] = React.useState<string | null>(null);
  const [revokingId, setRevokingId] = React.useState<string | null>(null);

  const onCreate = async () => {
    if (!label.trim()) return;
    setCreating(true);
    try {
      const res = await fetch('/api/settings/api-keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label: label.trim() }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          message?: string;
        } | null;
        throw new Error(body?.message ?? `HTTP ${res.status}`);
      }
      const body = (await res.json()) as { key: string };
      setSecret(body.key);
      setLabel('');
      router.refresh();
    } catch (error) {
      toast.error(
        error instanceof Error ? `Couldn't create key: ${error.message}` : "Couldn't create key",
      );
    } finally {
      setCreating(false);
    }
  };

  const onRevoke = async (id: string) => {
    setRevokingId(id);
    try {
      const res = await fetch(`/api/settings/api-keys/${id}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast.success('Key revoked');
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? `Couldn't revoke: ${error.message}` : "Couldn't revoke");
    } finally {
      setRevokingId(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Keys grant MCP access so Claude Code or Cursor can drive Forge.
        </p>
        <Dialog
          open={createOpen}
          onOpenChange={(o) => {
            setCreateOpen(o);
            if (!o) setSecret(null);
          }}
        >
          <DialogTrigger asChild>
            <Button size="sm">
              <Plus className="h-3.5 w-3.5" /> New API key
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{secret ? 'API key created' : 'Create API key'}</DialogTitle>
              <DialogDescription>
                {secret
                  ? "Copy this key now — it won't be shown again."
                  : 'Give your key a label so you can recognize it later.'}
              </DialogDescription>
            </DialogHeader>

            {secret ? (
              <div className="space-y-3">
                <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2">
                  <code className="flex-1 overflow-auto font-mono text-xs">{secret}</code>
                  <CopyButton value={secret} label="Copy" size="sm" />
                </div>
                <DialogFooter>
                  <Button
                    onClick={() => {
                      setSecret(null);
                      setCreateOpen(false);
                    }}
                  >
                    Done
                  </Button>
                </DialogFooter>
              </div>
            ) : (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void onCreate();
                }}
                className="space-y-3"
              >
                <div className="space-y-1.5">
                  <Label htmlFor="api-key-label">Label</Label>
                  <Input
                    id="api-key-label"
                    value={label}
                    onChange={(e) => {
                      setLabel(e.currentTarget.value);
                    }}
                    placeholder="e.g. Claude Code laptop"
                    autoFocus
                    required
                  />
                </div>
                <DialogFooter>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setCreateOpen(false);
                    }}
                    disabled={creating}
                  >
                    Cancel
                  </Button>
                  <Button type="submit" disabled={creating || !label.trim()}>
                    {creating ? 'Creating…' : 'Create key'}
                  </Button>
                </DialogFooter>
              </form>
            )}
          </DialogContent>
        </Dialog>
      </div>

      {keys.length === 0 ? (
        <EmptyState
          icon={KeyRound}
          title="No API keys yet"
          description="Mint a key to drive Forge from Claude Code, Cursor, or any MCP client."
        />
      ) : (
        <ul className="space-y-2">
          {keys.map((k) => (
            <li
              key={k.id}
              className="flex items-center justify-between rounded-md border border-border bg-card px-4 py-3"
            >
              <div className="space-y-0.5">
                <p className="font-medium">{k.label}</p>
                <p className="font-mono text-xs text-muted-foreground">{k.prefix}…</p>
                <p className="text-xs text-muted-foreground">
                  Created {formatRelativeDate(k.createdAt)}
                  {k.lastUsedAt
                    ? ` · last used ${formatRelativeDate(k.lastUsedAt)}`
                    : ' · never used'}
                </p>
              </div>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={revokingId === k.id}
                    className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                  >
                    <Trash2 className="h-3.5 w-3.5" /> Revoke
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Revoke this key?</AlertDialogTitle>
                    <AlertDialogDescription>
                      Any client using {k.label} will lose access immediately. This can&apos;t be
                      undone.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                      onClick={(e) => {
                        e.preventDefault();
                        void onRevoke(k.id);
                      }}
                    >
                      Revoke
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
