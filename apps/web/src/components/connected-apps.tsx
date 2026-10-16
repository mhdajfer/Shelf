'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';

import type { ConnectedAppDto } from '@shelf/shared';

import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogTrigger } from '@/components/ui/dialog';
import { api } from '@/lib/api-client';
import { errorMessage } from '@/lib/api-error';
import { routes } from '@/lib/routes';
import { formatDate } from '@/lib/utils';

const APPS_KEY = ['access', 'apps'] as const;

function describeSet(app: ConnectedAppDto): string {
  if (app.promptSet === 'pinned') return 'Pinned prompts';
  if (app.promptSet === 'collection') return `Collection: ${app.collection?.name ?? '—'}`;
  return 'All prompts';
}

const describeScopes = (app: ConnectedAppDto): string =>
  app.scopes.includes('prompts:write') ? 'Read and save' : 'Read only';

function Disconnect({ app }: { app: ConnectedAppDto }) {
  const queryClient = useQueryClient();
  const [revoking, setRevoking] = useState(false);

  async function revoke() {
    setRevoking(true);
    try {
      await api(`/access/apps/${app.id}`, { method: 'DELETE' });
      await queryClient.invalidateQueries({ queryKey: APPS_KEY });
      toast.success(`Disconnected “${app.name}”`);
    } catch (error) {
      toast.error(errorMessage(error));
      setRevoking(false);
    }
  }

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost">
          Disconnect
        </Button>
      </DialogTrigger>
      <DialogContent
        title={`Disconnect “${app.name}”?`}
        description="It loses access to your shelf on its next request, and has to ask you again to reconnect."
      >
        <div className="flex justify-end gap-2">
          <DialogClose asChild>
            <Button variant="ghost">Keep it</Button>
          </DialogClose>
          <Button variant="danger" disabled={revoking} onClick={() => void revoke()}>
            {revoking ? 'Disconnecting…' : 'Disconnect'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * MCP clients the user approved through the consent page. Each holds tokens
 * that refresh themselves, so an app stays listed until it goes unused for 30
 * days or is disconnected here.
 */
export function ConnectedApps() {
  const apps = useQuery({
    queryKey: APPS_KEY,
    queryFn: () => api<{ apps: ConnectedAppDto[] }>('/access/apps'),
  });

  if (apps.isError) {
    return (
      <p role="alert" className="text-sm text-danger">
        {errorMessage(apps.error)}
      </p>
    );
  }
  if (!apps.isSuccess) return null;

  if (apps.data.apps.length === 0) {
    return (
      <p className="text-sm text-text-muted">
        No apps yet. Add Shelf to Claude Code or another client and approve it when your browser
        opens.{' '}
        <Link href={routes.mcpDocs} className="text-accent underline">
          How to connect a client
        </Link>
      </p>
    );
  }

  return (
    <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
      {apps.data.apps.map((app) => (
        <li key={app.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2.5">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="font-medium">
              {app.name}
              {app.publishedBy !== null && (
                <span className="font-normal text-text-muted"> · {app.publishedBy}</span>
              )}
            </span>
            <span className="text-sm text-text-muted">
              {describeScopes(app)} · {describeSet(app)}
            </span>
            <span className="text-sm text-text-subtle">
              Connected {formatDate(app.createdAt)} ·{' '}
              {app.lastUsedAt === null ? 'Never used' : `Last used ${formatDate(app.lastUsedAt)}`}
            </span>
          </div>
          <Disconnect app={app} />
        </li>
      ))}
    </ul>
  );
}
