'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import type { OAuthDecisionDto, OAuthRequestDto, ShelfSummaryDto } from '@shelf/shared';

import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { api } from '@/lib/api-client';
import { errorMessage } from '@/lib/api-error';
import { SHELF_SUMMARY_KEY } from '@/lib/shelf-queries';

const selectClass =
  'h-9 w-full rounded-md border border-border-strong bg-surface-raised px-2.5 text-sm text-text';

type SetChoice = 'all' | 'pinned' | `collection:${string}`;

function initialSet(current: OAuthRequestDto['current']): SetChoice {
  if (current === null) return 'all';
  if (current.promptSet === 'collection' && current.collectionId !== null) {
    return `collection:${current.collectionId}`;
  }
  return current.promptSet === 'pinned' ? 'pinned' : 'all';
}

/**
 * The redirect the API answered with. It is always a URI the app registered
 * and the API checked, never a script URL; checking again costs nothing.
 */
function safeTarget(redirectTo: string): string | null {
  try {
    const { protocol } = new URL(redirectTo);
    return ['javascript:', 'data:', 'vbscript:', 'file:', 'blob:'].includes(protocol)
      ? null
      : redirectTo;
  } catch {
    return null;
  }
}

/**
 * Approve or deny an MCP client. Everything shown about the app is what the
 * app said about itself, except the host its metadata document came from;
 * the page says so rather than lending the app Shelf's credibility.
 */
export function OAuthConsent({ request, handle }: { request: OAuthRequestDto; handle: string }) {
  const summary = useQuery({
    queryKey: SHELF_SUMMARY_KEY,
    queryFn: () => api<ShelfSummaryDto>('/shelf/summary'),
  });
  const writeAsked = request.scopes.includes('prompts:write');
  const [write, setWrite] = useState(
    writeAsked && (request.current === null || request.current.scopes.includes('prompts:write')),
  );
  const [set, setSet] = useState<SetChoice>(initialSet(request.current));
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState<'approve' | 'deny' | null>(null);
  const [leaving, setLeaving] = useState(false);

  async function decide(approve: boolean) {
    setSending(approve ? 'approve' : 'deny');
    setError(null);
    try {
      const answer = await api<OAuthDecisionDto>(`/oauth/requests/${request.id}/decision`, {
        method: 'POST',
        body: approve
          ? {
              approve: true,
              write,
              ...(set.startsWith('collection:')
                ? { promptSet: 'collection', collectionId: set.slice('collection:'.length) }
                : { promptSet: set }),
            }
          : { approve: false },
      });
      const target = safeTarget(answer.redirectTo);
      if (target === null) throw new Error('The app gave an address Shelf will not open.');
      setLeaving(true);
      window.location.assign(target);
    } catch (caught) {
      setError(errorMessage(caught));
      setSending(null);
    }
  }

  if (leaving) {
    return (
      <p role="status" className="text-sm text-text-muted">
        {request.redirect.kind === 'loopback'
          ? 'Handing you back to the app. Once it says it is connected, you can close this tab.'
          : `Handing you back to ${request.redirect.target}…`}
      </p>
    );
  }

  const collections = summary.data?.collections ?? [];

  return (
    <div className="flex flex-col gap-5">
      {error !== null && (
        <p role="alert" className="rounded-md border border-danger px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}

      <div className="flex flex-col gap-1.5 rounded-md border border-border bg-surface-sunken p-4 text-sm">
        <p>
          <span className="font-medium">{request.client.name}</span> wants to use the shelf of{' '}
          <span className="font-mono">@{handle}</span>.
        </p>
        <p className="text-text-muted">
          {request.client.publishedBy === null
            ? 'Shelf has not verified this app: the name is what it calls itself.'
            : `The name is what the app calls itself; its details are published by ${request.client.publishedBy}.`}
        </p>
        <p className="text-text-muted">
          Approving sends you back to{' '}
          <span className="font-medium text-text">{request.redirect.target}</span>.
        </p>
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1.5 text-sm font-medium">It will be able to</legend>
        <p className="text-sm">Read your prompts and run them as commands</p>
        {writeAsked && (
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={write}
              onChange={(event) => setWrite(event.target.checked)}
              className="mt-0.5 accent-accent"
            />
            <span>
              Save new prompts and versions
              <span className="block text-text-muted">
                Always private. It cannot publish or delete anything.
              </span>
            </span>
          </label>
        )}
      </fieldset>

      <Field id="consent-set" label="Prompts it can see">
        <select
          id="consent-set"
          value={set}
          onChange={(event) => setSet(event.target.value as SetChoice)}
          className={selectClass}
        >
          <option value="all">All my prompts</option>
          <option value="pinned">Pinned prompts only</option>
          {collections.map((collection) => (
            <option key={collection.id} value={`collection:${collection.id}`}>
              Collection: {collection.name}
            </option>
          ))}
        </select>
      </Field>

      {request.current !== null && (
        <p className="text-sm text-text-muted">
          You connected this app before. Approving replaces the choices you made then.
        </p>
      )}

      <div className="flex gap-2">
        <Button
          variant="primary"
          disabled={sending !== null}
          onClick={() => void decide(true)}
          className="flex-1"
        >
          {sending === 'approve' ? 'Approving…' : 'Approve'}
        </Button>
        <Button disabled={sending !== null} onClick={() => void decide(false)} className="flex-1">
          {sending === 'deny' ? 'Denying…' : 'Deny'}
        </Button>
      </div>
      <p className="text-sm text-text-subtle">
        You can disconnect it at any time in Settings → Connected apps.
      </p>
    </div>
  );
}
