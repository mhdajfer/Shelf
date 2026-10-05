'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FolderPlus, Pencil, Pin, PinOff, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';

import type { PromptDetailDto, ShelfSummaryDto } from '@shelf/shared';

import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogTrigger } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { api } from '@/lib/api-client';
import { errorMessage } from '@/lib/api-error';
import { routes } from '@/lib/routes';
import { SHELF_SUMMARY_KEY } from '@/lib/shelf-queries';

function CollectionsMenu({ promptId }: { promptId: string }) {
  const queryClient = useQueryClient();
  const membershipKey = ['prompt-collections', promptId];

  const summary = useQuery({
    queryKey: SHELF_SUMMARY_KEY,
    queryFn: () => api<ShelfSummaryDto>('/shelf/summary'),
  });
  const membership = useQuery({
    queryKey: membershipKey,
    queryFn: () => api<{ collectionIds: string[] }>(`/prompts/${promptId}/collections`),
  });

  const collections = summary.data?.collections ?? [];
  const memberOf = new Set(membership.data?.collectionIds ?? []);

  async function toggle(collectionId: string, checked: boolean) {
    try {
      await api(`/collections/${collectionId}/prompts/${promptId}`, {
        method: checked ? 'PUT' : 'DELETE',
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: membershipKey }),
        queryClient.invalidateQueries({ queryKey: SHELF_SUMMARY_KEY }),
      ]);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost">
          <FolderPlus />
          Collections
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {collections.length === 0 ? (
          <DropdownMenuLabel className="max-w-56">
            {summary.isPending
              ? 'Loading…'
              : 'No collections yet. Create one from the sidebar on your shelf.'}
          </DropdownMenuLabel>
        ) : (
          collections.map((collection) => (
            <DropdownMenuCheckboxItem
              key={collection.id}
              checked={memberOf.has(collection.id)}
              onCheckedChange={(checked) => void toggle(collection.id, checked)}
              // Keep the menu open: filing a prompt in two collections is common.
              onSelect={(event) => event.preventDefault()}
            >
              {collection.name}
            </DropdownMenuCheckboxItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function OwnerActions({ prompt }: { prompt: PromptDetailDto }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const isUserPrompt = prompt.author.kind === 'user';

  async function togglePin() {
    setBusy(true);
    try {
      await api(`/prompts/${prompt.id}`, { method: 'PATCH', body: { pinned: !prompt.pinned } });
      await queryClient.invalidateQueries({ queryKey: SHELF_SUMMARY_KEY });
      router.refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await api(`/prompts/${prompt.id}`, { method: 'DELETE' });
      await queryClient.invalidateQueries();
      toast.success('Prompt deleted');
      router.push(isUserPrompt ? routes.shelf : routes.home);
      router.refresh();
    } catch (error) {
      toast.error(errorMessage(error));
      setBusy(false);
    }
  }

  return (
    <>
      {prompt.viewer.canEdit && (
        <Button asChild>
          <Link href={routes.editPrompt(prompt.id)}>
            <Pencil />
            Edit
          </Link>
        </Button>
      )}

      {isUserPrompt && (
        <>
          <Button
            variant="ghost"
            onClick={() => void togglePin()}
            disabled={busy}
            aria-pressed={prompt.pinned}
          >
            {prompt.pinned ? <PinOff /> : <Pin />}
            {prompt.pinned ? 'Unpin' : 'Pin'}
          </Button>
          <CollectionsMenu promptId={prompt.id} />
        </>
      )}

      {prompt.viewer.canEdit && (
        <Dialog>
          <DialogTrigger asChild>
            <Button variant="ghost" className="text-danger hover:text-danger">
              <Trash2 />
              Delete
            </Button>
          </DialogTrigger>
          <DialogContent
            title="Delete this prompt?"
            description={`"${prompt.title}" and its ${String(prompt.versionNumber)} ${
              prompt.versionNumber === 1 ? 'version' : 'versions'
            } will be removed from your shelf${
              prompt.visibility === 'public' ? ' and from the public shelf' : ''
            }. Forks other people made are not affected.`}
          >
            <div className="flex justify-end gap-2">
              <DialogClose asChild>
                <Button variant="ghost">Keep it</Button>
              </DialogClose>
              <Button variant="danger" onClick={() => void remove()} disabled={busy}>
                {busy ? 'Deleting…' : 'Delete prompt'}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
