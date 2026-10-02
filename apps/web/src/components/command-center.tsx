'use client';

import { useQuery } from '@tanstack/react-query';
import { Command } from 'cmdk';
import { useTheme } from 'next-themes';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';

import type { PromptListDto } from '@shelf/shared';

import { THEMES } from '@/components/theme-toggle';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { api } from '@/lib/api-client';
import { errorMessage } from '@/lib/api-error';
import { routes } from '@/lib/routes';
import { useSession } from '@/lib/session';

const OPEN_PALETTE = 'shelf:open-palette';

/** Lets any component (the header button, say) open the palette. */
export function openCommandPalette(): void {
  window.dispatchEvent(new Event(OPEN_PALETTE));
}

const SHORTCUTS: { keys: string[]; action: string }[] = [
  { keys: ['Ctrl', 'K'], action: 'Open the command palette' },
  { keys: ['/'], action: 'Focus the search box' },
  { keys: ['N'], action: 'New prompt' },
  { keys: ['G', 'L'], action: 'Go to the library' },
  { keys: ['G', 'S'], action: 'Go to your shelf' },
  { keys: ['Ctrl', 'S'], action: 'Save, in the editor' },
  { keys: ['?'], action: 'Show this list' },
];

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded-sm border border-border-strong bg-surface-sunken px-1.5 py-0.5 font-mono text-xs">
      {children}
    </kbd>
  );
}

/** Typing in a field must never trigger a single-key shortcut. */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) ||
    target.closest('[role="dialog"], [role="menu"], [cmdk-root]') !== null
  );
}

function useDebounced(value: string, delayMs: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

const groupHeading =
  '[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-text-subtle [&_[cmdk-group-heading]]:uppercase';
const itemClass =
  'flex cursor-default items-center justify-between gap-3 rounded-sm px-2 py-1.5 text-sm select-none data-[selected=true]:bg-surface-sunken';

/**
 * The command palette, the keyboard shortcuts, and the list that explains
 * them. Mounted once in the root layout.
 */
export function CommandCenter() {
  const router = useRouter();
  const { user, refresh } = useSession();
  const { setTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [search, setSearch] = useState('');
  const query = useDebounced(search.trim(), 200);
  const searching = query.length >= 2;

  // "g" arms a second key for a moment: g then l, g then s.
  const pendingG = useRef<ReturnType<typeof setTimeout> | null>(null);

  const go = useCallback(
    (href: string) => {
      setOpen(false);
      setSearch('');
      router.push(href);
    },
    [router],
  );

  useEffect(() => {
    const openPalette = () => setOpen(true);
    window.addEventListener(OPEN_PALETTE, openPalette);

    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((current) => !current);
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return;

      const key = event.key.toLowerCase();
      if (pendingG.current !== null) {
        clearTimeout(pendingG.current);
        pendingG.current = null;
        if (key === 'l') router.push(routes.home);
        if (key === 's') router.push(routes.shelf);
        return;
      }

      if (key === 'g') {
        pendingG.current = setTimeout(() => {
          pendingG.current = null;
        }, 800);
      } else if (key === '/') {
        const box = document.querySelector<HTMLInputElement>('input[type="search"]');
        if (box !== null) {
          event.preventDefault();
          box.focus();
        } else {
          event.preventDefault();
          setOpen(true);
        }
      } else if (key === 'n') {
        router.push(routes.newPrompt);
      } else if (event.key === '?') {
        setHelpOpen(true);
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener(OPEN_PALETTE, openPalette);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [router]);

  const mine = useQuery({
    queryKey: ['palette', 'mine', query],
    queryFn: () => api<PromptListDto>(`/shelf/prompts?q=${encodeURIComponent(query)}&limit=5`),
    enabled: open && searching && user !== null,
  });
  const library = useQuery({
    queryKey: ['palette', 'public', query],
    queryFn: () => api<PromptListDto>(`/prompts?q=${encodeURIComponent(query)}&limit=5`),
    enabled: open && searching,
  });

  async function signOut() {
    setOpen(false);
    try {
      await api('/auth/logout', { method: 'POST' });
      await refresh();
      router.push(routes.home);
      router.refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  const mineIds = new Set((mine.data?.items ?? []).map((item) => item.id));
  const publicItems = (library.data?.items ?? []).filter((item) => !mineIds.has(item.id));
  const hasResults = searching && (mineIds.size > 0 || publicItems.length > 0);

  return (
    <>
      <Command.Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setSearch('');
        }}
        label="Command palette"
        overlayClassName="fixed inset-0 z-40 bg-black/45"
        contentClassName="fixed top-[15vh] left-1/2 z-50 w-[calc(100vw-2rem)] max-w-xl -translate-x-1/2 overflow-hidden rounded-lg border border-border bg-surface-raised shadow-xl"
      >
        <Command.Input
          value={search}
          onValueChange={setSearch}
          placeholder="Search prompts, or type a command"
          className="h-12 w-full border-b border-border bg-transparent px-4 text-[0.9375rem] outline-none placeholder:text-text-subtle"
        />
        <Command.List className="max-h-[55vh] overflow-y-auto p-1.5">
          {/* cmdk counts only the items it filters itself, so its empty state
              would show above API results. It is rendered only when there are none. */}
          {!hasResults && (
            <Command.Empty className="px-2 py-6 text-center text-sm text-text-muted">
              {searching && (library.isFetching || mine.isFetching)
                ? 'Searching…'
                : 'Nothing matches that.'}
            </Command.Empty>
          )}

          {/* Search results come from the API already ranked, so they bypass
              the palette's own text filter. */}
          {searching && (mine.data?.items.length ?? 0) > 0 && (
            <Command.Group heading="Your shelf" className={groupHeading} forceMount>
              {mine.data?.items.map((prompt) => (
                <Command.Item
                  key={prompt.id}
                  value={`mine ${prompt.id}`}
                  onSelect={() => go(routes.prompt(prompt.id))}
                  className={itemClass}
                  forceMount
                >
                  <span className="truncate">{prompt.title}</span>
                  <span className="shrink-0 text-xs text-text-subtle">{prompt.visibility}</span>
                </Command.Item>
              ))}
            </Command.Group>
          )}
          {searching && publicItems.length > 0 && (
            <Command.Group heading="Public shelf" className={groupHeading} forceMount>
              {publicItems.map((prompt) => (
                <Command.Item
                  key={prompt.id}
                  value={`public ${prompt.id}`}
                  onSelect={() => go(routes.prompt(prompt.id))}
                  className={itemClass}
                  forceMount
                >
                  <span className="truncate">{prompt.title}</span>
                  <span className="shrink-0 text-xs text-text-subtle">{prompt.author.handle}</span>
                </Command.Item>
              ))}
            </Command.Group>
          )}

          <Command.Group heading="Go to" className={groupHeading}>
            <Command.Item onSelect={() => go(routes.home)} className={itemClass}>
              Library
            </Command.Item>
            {user !== null && (
              <Command.Item onSelect={() => go(routes.shelf)} className={itemClass}>
                Your shelf
              </Command.Item>
            )}
            <Command.Item onSelect={() => go(routes.newPrompt)} className={itemClass}>
              New prompt
            </Command.Item>
            {user !== null && (
              <Command.Item onSelect={() => go(routes.settings)} className={itemClass}>
                Settings
              </Command.Item>
            )}
            {user?.role === 'admin' && (
              <Command.Item onSelect={() => go(routes.admin)} className={itemClass}>
                Moderation
              </Command.Item>
            )}
          </Command.Group>

          <Command.Group heading="Theme" className={groupHeading}>
            {THEMES.map((theme) => (
              <Command.Item
                key={theme.value}
                value={`theme ${theme.label}`}
                onSelect={() => {
                  setTheme(theme.value);
                  setOpen(false);
                }}
                className={itemClass}
              >
                {theme.label} theme
              </Command.Item>
            ))}
          </Command.Group>

          <Command.Group heading="Account" className={groupHeading}>
            <Command.Item
              onSelect={() => {
                setOpen(false);
                setHelpOpen(true);
              }}
              className={itemClass}
            >
              Keyboard shortcuts
            </Command.Item>
            {user === null ? (
              <Command.Item onSelect={() => go(routes.signIn())} className={itemClass}>
                Sign in
              </Command.Item>
            ) : (
              <Command.Item onSelect={() => void signOut()} className={itemClass}>
                Sign out
              </Command.Item>
            )}
          </Command.Group>
        </Command.List>
      </Command.Dialog>

      <Dialog open={helpOpen} onOpenChange={setHelpOpen}>
        <DialogContent title="Keyboard shortcuts">
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-2 text-sm">
            {SHORTCUTS.map((shortcut) => (
              <div key={shortcut.action} className="contents">
                <dt className="flex gap-1">
                  {shortcut.keys.map((key) => (
                    <Kbd key={key}>{key}</Kbd>
                  ))}
                </dt>
                <dd className="text-text-muted">{shortcut.action}</dd>
              </div>
            ))}
          </dl>
          <p className="text-sm text-text-subtle">
            Single-key shortcuts are off while you are typing. On a Mac, Ctrl is Cmd.
          </p>
        </DialogContent>
      </Dialog>
    </>
  );
}
