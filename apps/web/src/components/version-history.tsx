'use client';

import { diffLines } from 'diff';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';

import type { PromptVersionDto } from '@shelf/shared';

import { PromptBody } from '@/components/prompt-body';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api-client';
import { errorMessage } from '@/lib/api-error';
import { cn, formatDateTime } from '@/lib/utils';

interface DiffRow {
  kind: 'added' | 'removed' | 'same';
  text: string;
}

/** One row per line, so each carries its own +/- marker and background. */
function toRows(from: string, to: string): DiffRow[] {
  // A last line with no trailing newline differs, to a line diff, from the same
  // line followed by one. Appending a line would then show the line above it as
  // removed and re-added, so both sides are terminated first.
  const terminated = (text: string) => (text === '' || text.endsWith('\n') ? text : `${text}\n`);

  return diffLines(terminated(from), terminated(to)).flatMap((change) => {
    const kind: DiffRow['kind'] = change.added ? 'added' : change.removed ? 'removed' : 'same';
    const lines = change.value.split('\n');
    // diffLines keeps the trailing newline on each chunk; drop the empty tail.
    if (lines.at(-1) === '') lines.pop();
    return lines.map((text) => ({ kind, text }));
  });
}

function Diff({ from, to }: { from: PromptVersionDto; to: PromptVersionDto }) {
  const rows = useMemo(() => toRows(from.body, to.body), [from.body, to.body]);
  const added = rows.filter((row) => row.kind === 'added').length;
  const removed = rows.filter((row) => row.kind === 'removed').length;

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-text-muted">
        {added === 0 && removed === 0 ? (
          'These versions are identical.'
        ) : (
          <>
            <span className="text-success">
              {added} {added === 1 ? 'line' : 'lines'} added
            </span>
            {', '}
            <span className="text-danger">{removed} removed</span>
          </>
        )}
      </p>
      <div className="overflow-x-auto rounded-md border border-border bg-surface-sunken font-mono text-[0.8125rem] leading-[1.45rem]">
        {rows.map((row, index) => (
          <div
            key={index}
            className={cn(
              'flex min-w-max gap-2 px-3 whitespace-pre',
              row.kind === 'added' && 'bg-success/15',
              row.kind === 'removed' && 'bg-danger/15',
            )}
          >
            {/* The marker is text, so the change is readable without colour. */}
            <span
              className={cn(
                'w-3 shrink-0 select-none',
                row.kind === 'added' && 'text-success',
                row.kind === 'removed' && 'text-danger',
              )}
            >
              {row.kind === 'added' ? '+' : row.kind === 'removed' ? '-' : ' '}
              <span className="sr-only">
                {row.kind === 'added' ? 'added: ' : row.kind === 'removed' ? 'removed: ' : ''}
              </span>
            </span>
            <span>{row.text === '' ? ' ' : row.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

const selectClass =
  'h-8 rounded-md border border-border-strong bg-surface-raised px-2 text-sm text-text';

export function VersionHistory({
  promptId,
  versions,
  canRestore,
}: {
  promptId: string;
  /** Newest first, as the API returns them. */
  versions: PromptVersionDto[];
  canRestore: boolean;
}) {
  const router = useRouter();
  const current = versions[0];
  const [selectedId, setSelectedId] = useState(current?.id ?? '');
  const selected = versions.find((version) => version.id === selectedId) ?? current;

  // "What did this version change?" is the default question, so compare with
  // the one before it unless the reader picks another.
  const previous = versions.find((version) => version.number === (selected?.number ?? 0) - 1);
  const [compareId, setCompareId] = useState<string | null>(null);
  const compare = versions.find((version) => version.id === compareId) ?? previous;

  const [restoring, setRestoring] = useState(false);

  if (current === undefined || selected === undefined) return null;

  async function restore(version: PromptVersionDto) {
    setRestoring(true);
    try {
      await api(`/prompts/${promptId}/versions/${version.id}/restore`, { method: 'POST' });
      toast.success(`Version ${String(version.number)} restored`, {
        description: 'It was saved as a new version, so nothing was lost.',
      });
      // The page re-keys this component on the newest version, which resets
      // the selection to it.
      router.refresh();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setRestoring(false);
    }
  }

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[16rem_minmax(0,1fr)]">
      <ol aria-label="Versions" className="flex flex-col gap-1">
        {versions.map((version) => {
          const active = version.id === selected.id;
          return (
            <li key={version.id}>
              <button
                type="button"
                onClick={() => {
                  setSelectedId(version.id);
                  setCompareId(null);
                }}
                aria-current={active ? 'true' : undefined}
                className={cn(
                  'flex w-full flex-col gap-0.5 rounded-md border border-transparent px-3 py-2 text-left text-sm hover:bg-surface-sunken',
                  active && 'border-border bg-surface-raised',
                )}
              >
                <span className="font-medium">
                  Version {version.number}
                  {version.id === current.id && (
                    <span className="ml-2 font-normal text-text-subtle">current</span>
                  )}
                </span>
                {version.note !== null && <span className="text-text-muted">{version.note}</span>}
                <span className="text-text-subtle">{formatDateTime(version.createdAt)}</span>
              </button>
            </li>
          );
        })}
      </ol>

      <div className="flex min-w-0 flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="font-medium">Version {selected.number}</h2>
          {versions.length > 1 && (
            <label className="flex items-center gap-2 text-sm text-text-muted">
              compared with
              <select
                value={compare?.id ?? ''}
                onChange={(event) => setCompareId(event.target.value)}
                className={selectClass}
              >
                {versions
                  .filter((version) => version.id !== selected.id)
                  .map((version) => (
                    <option key={version.id} value={version.id}>
                      Version {version.number}
                    </option>
                  ))}
              </select>
            </label>
          )}
          {canRestore && selected.id !== current.id && (
            <Button
              size="sm"
              className="ml-auto"
              disabled={restoring}
              onClick={() => void restore(selected)}
            >
              {restoring ? 'Restoring…' : `Restore version ${String(selected.number)}`}
            </Button>
          )}
        </div>

        {compare === undefined ? (
          <>
            <p className="text-sm text-text-muted">
              This is the first version, so there is nothing to compare it with.
            </p>
            <PromptBody body={selected.body} />
          </>
        ) : (
          // Older on the left of the comparison, whichever way the reader chose.
          <Diff
            from={compare.number < selected.number ? compare : selected}
            to={compare.number < selected.number ? selected : compare}
          />
        )}
      </div>
    </div>
  );
}
