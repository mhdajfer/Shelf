'use client';

import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { GripVertical, MoreHorizontal, Plus, Search } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { toast } from 'sonner';

import {
  LIMITS,
  type CollectionDto,
  type PromptListDto,
  type ShelfSummaryDto,
} from '@shelf/shared';

import { PromptGrid } from '@/components/prompt-card';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { describedBy, Field, Input } from '@/components/ui/field';
import { api } from '@/lib/api-client';
import { ApiError, errorMessage } from '@/lib/api-error';
import { routes } from '@/lib/routes';
import { SHELF_PROMPTS_KEY, SHELF_SUMMARY_KEY } from '@/lib/shelf-queries';
import { cn, plural } from '@/lib/utils';

/** The shelf's view lives in the URL, so a filtered shelf can be bookmarked. */
function shelfHref(params: { view?: string; collection?: string; q?: string; page?: number }) {
  const search = new URLSearchParams();
  if (params.view !== undefined) search.set('view', params.view);
  if (params.collection !== undefined) search.set('collection', params.collection);
  if (params.q !== undefined && params.q !== '') search.set('q', params.q);
  if (params.page !== undefined && params.page > 1) search.set('page', String(params.page));
  const query = search.toString();
  return query === '' ? routes.shelf : `${routes.shelf}?${query}`;
}

const navItem =
  'flex min-w-0 flex-1 items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-sm text-text-muted hover:bg-surface-sunken hover:text-text';
const navItemActive = 'bg-surface-sunken text-text font-medium';

function SidebarLink({
  href,
  active,
  count,
  children,
}: {
  href: string;
  active: boolean;
  count: number;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={cn(navItem, active && navItemActive)}
    >
      <span className="truncate">{children}</span>
      <span className="text-text-subtle tabular-nums">{count}</span>
    </Link>
  );
}

type NameDialog = { mode: 'create' } | { mode: 'rename'; collection: CollectionDto };

/** Create and rename share one dialog: the same field, the same validation. */
function CollectionNameDialog({
  state,
  onClose,
  onSaved,
}: {
  state: NameDialog;
  onClose: () => void;
  onSaved: (createdId?: string) => void;
}) {
  const [name, setName] = useState(state.mode === 'rename' ? state.collection.name : '');
  const [error, setError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(undefined);
    try {
      if (state.mode === 'create') {
        const { collection } = await api<{ collection: CollectionDto }>('/collections', {
          method: 'POST',
          body: { name },
        });
        onSaved(collection.id);
      } else {
        await api(`/collections/${state.collection.id}`, { method: 'PATCH', body: { name } });
        onSaved();
      }
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? (caught.details[0]?.message ?? caught.message)
          : errorMessage(caught),
      );
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent title={state.mode === 'create' ? 'New collection' : 'Rename collection'}>
        <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
          <Field id="collection-name" label="Name" error={error}>
            <Input
              id="collection-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={LIMITS.collectionNameMax}
              autoFocus
              required
              {...describedBy('collection-name', error)}
            />
          </Field>
          <div className="flex justify-end gap-2">
            <DialogClose asChild>
              <Button variant="ghost">Cancel</Button>
            </DialogClose>
            <Button type="submit" variant="primary" disabled={saving || name.trim() === ''}>
              {saving ? 'Saving…' : state.mode === 'create' ? 'Create' : 'Rename'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function SortableCollection({
  collection,
  active,
  onRename,
  onDelete,
}: {
  collection: CollectionDto;
  active: boolean;
  onRename: () => void;
  onDelete: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: collection.id,
  });

  return (
    <li
      ref={setNodeRef}
      style={{
        // Translation only: the rows are one height, so nothing needs scaling.
        transform:
          transform === null
            ? undefined
            : `translate3d(${String(Math.round(transform.x))}px, ${String(Math.round(transform.y))}px, 0)`,
        transition,
      }}
      className={cn('group flex items-center gap-0.5', isDragging && 'z-10 opacity-80')}
    >
      {/* The handle is the drag target, so the link beside it stays a plain link.
          dnd-kit gives it keyboard dragging: Space to lift, arrows to move. */}
      <button
        type="button"
        aria-label={`Reorder ${collection.name}`}
        className="cursor-grab touch-none rounded-sm p-0.5 text-text-subtle hover:text-text active:cursor-grabbing"
        {...attributes}
        {...listeners}
      >
        <GripVertical className="size-4" />
      </button>
      <SidebarLink
        href={shelfHref({ collection: collection.id })}
        active={active}
        count={collection.itemCount}
      >
        {collection.name}
      </SidebarLink>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`Options for ${collection.name}`}
            className="rounded-sm p-1 text-text-subtle hover:bg-surface-sunken hover:text-text"
          >
            <MoreHorizontal className="size-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem onSelect={onRename}>Rename</DropdownMenuItem>
          <DropdownMenuItem onSelect={onDelete} className="text-danger">
            Delete collection
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

export function Shelf() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();

  const view = searchParams.get('view') === 'pinned' ? 'pinned' : 'all';
  const collectionId = searchParams.get('collection') ?? undefined;
  const q = searchParams.get('q') ?? '';
  const page = Math.max(1, Number.parseInt(searchParams.get('page') ?? '1', 10) || 1);

  const summary = useQuery({
    queryKey: SHELF_SUMMARY_KEY,
    queryFn: () => api<ShelfSummaryDto>('/shelf/summary'),
  });
  const collections = summary.data?.collections ?? [];
  const counts = summary.data?.counts ?? { total: 0, pinned: 0, public: 0 };
  const activeCollection = collections.find((collection) => collection.id === collectionId);

  const listParams = new URLSearchParams({ page: String(page) });
  if (q !== '') listParams.set('q', q);
  else if (collectionId !== undefined) listParams.set('collection', collectionId);
  else if (view === 'pinned') listParams.set('pinned', 'true');

  const list = useQuery({
    queryKey: [...SHELF_PROMPTS_KEY, listParams.toString()],
    queryFn: () => api<PromptListDto>(`/shelf/prompts?${listParams.toString()}`),
    placeholderData: keepPreviousData,
  });

  // The search box is local state, pushed to the URL once typing pauses.
  const [search, setSearch] = useState(q);
  useEffect(() => {
    if (search === q) return;
    const timer = setTimeout(() => {
      router.replace(search === '' ? pathname : shelfHref({ q: search }));
    }, 250);
    return () => clearTimeout(timer);
  }, [search, q, pathname, router]);

  const [nameDialog, setNameDialog] = useState<NameDialog | null>(null);
  const [deleting, setDeleting] = useState<CollectionDto | null>(null);

  const sensors = useSensors(
    // A few pixels of travel before a drag starts, so a click is still a click.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  async function onDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (over === null || active.id === over.id || summary.data === undefined) return;

    const from = collections.findIndex((collection) => collection.id === active.id);
    const to = collections.findIndex((collection) => collection.id === over.id);
    if (from === -1 || to === -1) return;

    const reordered = arrayMove(collections, from, to);
    // Move it now; the server confirms, or the refetch puts it back.
    queryClient.setQueryData<ShelfSummaryDto>(SHELF_SUMMARY_KEY, {
      ...summary.data,
      collections: reordered,
    });
    try {
      await api('/collections/order', {
        method: 'PUT',
        body: { ids: reordered.map((collection) => collection.id) },
      });
    } catch (error) {
      toast.error(errorMessage(error));
      await queryClient.invalidateQueries({ queryKey: SHELF_SUMMARY_KEY });
    }
  }

  async function deleteCollection(collection: CollectionDto) {
    try {
      await api(`/collections/${collection.id}`, { method: 'DELETE' });
      setDeleting(null);
      await queryClient.invalidateQueries({ queryKey: ['shelf'] });
      if (collectionId === collection.id) router.replace(routes.shelf);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  const heading =
    q !== ''
      ? `Results for “${q}”`
      : activeCollection !== undefined
        ? activeCollection.name
        : view === 'pinned'
          ? 'Pinned'
          : 'All prompts';

  const items = list.data?.items ?? [];
  const hasMore = list.data?.hasMore ?? false;
  const pageHref = (next: number) =>
    shelfHref({
      ...(q !== '' ? { q } : {}),
      ...(q === '' && collectionId !== undefined ? { collection: collectionId } : {}),
      ...(q === '' && collectionId === undefined && view === 'pinned' ? { view: 'pinned' } : {}),
      page: next,
    });

  return (
    <div className="grid items-start gap-8 lg:grid-cols-[15rem_minmax(0,1fr)]">
      <nav aria-label="Shelf" className="flex flex-col gap-5">
        <div className="flex flex-col gap-0.5">
          <div className="flex">
            <SidebarLink
              href={routes.shelf}
              active={q === '' && view === 'all' && collectionId === undefined}
              count={counts.total}
            >
              All prompts
            </SidebarLink>
          </div>
          <div className="flex">
            <SidebarLink
              href={shelfHref({ view: 'pinned' })}
              active={q === '' && view === 'pinned' && collectionId === undefined}
              count={counts.pinned}
            >
              Pinned
            </SidebarLink>
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between pl-2.5">
            <h2 className="text-xs font-medium tracking-wide text-text-subtle uppercase">
              Collections
            </h2>
            <button
              type="button"
              onClick={() => setNameDialog({ mode: 'create' })}
              aria-label="New collection"
              className="rounded-sm p-1 text-text-subtle hover:bg-surface-sunken hover:text-text"
            >
              <Plus className="size-4" />
            </button>
          </div>

          {collections.length === 0 ? (
            <p className="px-2.5 text-sm text-text-subtle">
              {summary.isPending ? 'Loading…' : 'Group related prompts into a collection.'}
            </p>
          ) : (
            <DndContext
              id="shelf-collections"
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={(event) => void onDragEnd(event)}
            >
              <SortableContext
                items={collections.map((collection) => collection.id)}
                strategy={verticalListSortingStrategy}
              >
                <ul className="flex flex-col gap-0.5">
                  {collections.map((collection) => (
                    <SortableCollection
                      key={collection.id}
                      collection={collection}
                      active={q === '' && collection.id === collectionId}
                      onRename={() => setNameDialog({ mode: 'rename', collection })}
                      onDelete={() => setDeleting(collection)}
                    />
                  ))}
                </ul>
              </SortableContext>
            </DndContext>
          )}
        </div>
      </nav>

      <section aria-labelledby="shelf-heading" className="flex min-w-0 flex-col gap-4">
        <h1 id="shelf-heading" className="font-mono text-2xl tracking-tight">
          {heading}
        </h1>

        <div className="relative">
          <Search
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-text-subtle"
          />
          <Input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search your shelf"
            aria-label="Search your shelf"
            className="pl-9"
          />
        </div>

        {list.isError ? (
          <p role="alert" className="rounded-md border border-danger px-3 py-2 text-sm text-danger">
            {errorMessage(list.error)}
          </p>
        ) : list.isPending ? (
          <p className="text-sm text-text-muted">Loading your shelf…</p>
        ) : items.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border-strong p-8 text-center">
            <p className="font-medium">
              {q !== ''
                ? 'Nothing on your shelf matches that.'
                : activeCollection !== undefined
                  ? 'This collection is empty.'
                  : view === 'pinned'
                    ? 'Nothing pinned yet.'
                    : 'Your shelf is empty.'}
            </p>
            <p className="mt-1 text-sm text-text-muted">
              {q !== ''
                ? 'Search looks at titles, descriptions, tags, and the prompt text.'
                : activeCollection !== undefined
                  ? 'Open a prompt and use Collections to file it here.'
                  : view === 'pinned'
                    ? 'Open a prompt and choose Pin to keep it within reach.'
                    : 'Write your first prompt, or fork one from the public shelf.'}
            </p>
          </div>
        ) : (
          <>
            <p className="text-sm text-text-muted">
              {q === '' && view === 'all' && collectionId === undefined
                ? `${plural(counts.total, 'prompt')}, ${String(counts.public)} public`
                : plural(items.length, 'prompt')}
            </p>
            <PromptGrid prompts={items} />
          </>
        )}

        {(page > 1 || hasMore) && (
          <nav aria-label="Pages" className="flex items-center justify-between gap-4 text-sm">
            <Button asChild={page > 1} disabled={page <= 1}>
              {page > 1 ? <Link href={pageHref(page - 1)}>Previous</Link> : 'Previous'}
            </Button>
            <span className="text-text-muted tabular-nums">Page {page}</span>
            <Button asChild={hasMore} disabled={!hasMore}>
              {hasMore ? <Link href={pageHref(page + 1)}>Next</Link> : 'Next'}
            </Button>
          </nav>
        )}
      </section>

      {nameDialog !== null && (
        <CollectionNameDialog
          state={nameDialog}
          onClose={() => setNameDialog(null)}
          onSaved={(createdId) => {
            setNameDialog(null);
            void queryClient.invalidateQueries({ queryKey: SHELF_SUMMARY_KEY });
            if (createdId !== undefined) router.push(shelfHref({ collection: createdId }));
          }}
        />
      )}

      {deleting !== null && (
        <Dialog open onOpenChange={(open) => !open && setDeleting(null)}>
          <DialogContent
            title={`Delete “${deleting.name}”?`}
            description={`The collection is removed. The ${plural(deleting.itemCount, 'prompt')} in it stay on your shelf.`}
          >
            <div className="flex justify-end gap-2">
              <DialogClose asChild>
                <Button variant="ghost">Keep it</Button>
              </DialogClose>
              <Button variant="danger" onClick={() => void deleteCollection(deleting)}>
                Delete collection
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
