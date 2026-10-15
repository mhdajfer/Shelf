'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';

import {
  ACCESS_TOKEN_LIFETIMES_DAYS,
  DEFAULT_ACCESS_TOKEN_LIFETIME_DAYS,
  LIMITS,
  type AccessTokenDto,
  type CreatedAccessTokenDto,
  type ShelfSummaryDto,
} from '@shelf/shared';

import { CopyButton } from '@/components/copy-button';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogTrigger } from '@/components/ui/dialog';
import { describedBy, Field, Input } from '@/components/ui/field';
import { api } from '@/lib/api-client';
import { ApiError, errorMessage } from '@/lib/api-error';
import { MCP_URL } from '@/lib/routes';
import { SHELF_SUMMARY_KEY } from '@/lib/shelf-queries';
import { formatDate } from '@/lib/utils';

const TOKENS_KEY = ['access', 'tokens'] as const;

const selectClass =
  'h-9 w-full rounded-md border border-border-strong bg-surface-raised px-2.5 text-sm text-text aria-invalid:border-danger';

/** "all", "pinned", or a collection id: one select covers the three prompt sets. */
type SetChoice = 'all' | 'pinned' | `collection:${string}`;

function describeSet(token: AccessTokenDto): string {
  if (token.promptSet === 'pinned') return 'Pinned prompts';
  if (token.promptSet === 'collection') return `Collection: ${token.collection?.name ?? '—'}`;
  return 'All prompts';
}

const describeScopes = (token: AccessTokenDto): string =>
  token.scopes.includes('prompts:write') ? 'Read and save' : 'Read only';

/** The one-line Claude Code setup for a new token, so nothing has to be assembled by hand. */
const claudeCommand = (secret: string): string =>
  `claude mcp add --transport http --scope user shelf ${MCP_URL} --header "Authorization: Bearer ${secret}"`;

function NewToken({ onCreated }: { onCreated: (created: CreatedAccessTokenDto) => void }) {
  const summary = useQuery({
    queryKey: SHELF_SUMMARY_KEY,
    queryFn: () => api<ShelfSummaryDto>('/shelf/summary'),
  });
  const [name, setName] = useState('');
  const [write, setWrite] = useState(false);
  const [set, setSet] = useState<SetChoice>('all');
  const [days, setDays] = useState<number>(DEFAULT_ACCESS_TOKEN_LIFETIME_DAYS);
  const [error, setError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setNameError(undefined);
    try {
      const created = await api<CreatedAccessTokenDto>('/access/tokens', {
        method: 'POST',
        body: {
          name,
          write,
          expiresInDays: days,
          ...(set.startsWith('collection:')
            ? { promptSet: 'collection', collectionId: set.slice('collection:'.length) }
            : { promptSet: set }),
        },
      });
      setName('');
      onCreated(created);
    } catch (caught) {
      const field =
        caught instanceof ApiError
          ? caught.details.find((detail) => detail.field === 'name')
          : undefined;
      if (field !== undefined) setNameError(field.message);
      else setError(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  }

  const collections = summary.data?.collections ?? [];

  return (
    <form onSubmit={(event) => void submit(event)} className="flex max-w-sm flex-col gap-4">
      {error !== null && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <Field
        id="token-name"
        label="Token name"
        hint="Where it will be used, so you can tell tokens apart."
        error={nameError}
      >
        <Input
          id="token-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={LIMITS.accessTokenNameMax}
          placeholder="Work laptop"
          {...describedBy('token-name', nameError, true)}
        />
      </Field>

      <Field id="token-set" label="Prompts it can see">
        <select
          id="token-set"
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

      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1.5 text-sm font-medium">Permission</legend>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="token-permission"
            checked={!write}
            onChange={() => setWrite(false)}
            className="accent-accent"
          />
          Read and run prompts
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="token-permission"
            checked={write}
            onChange={() => setWrite(true)}
            className="accent-accent"
          />
          Also save new prompts and versions (always private)
        </label>
      </fieldset>

      <Field id="token-expiry" label="Expires after">
        <select
          id="token-expiry"
          value={days}
          onChange={(event) => setDays(Number(event.target.value))}
          className={selectClass}
        >
          {ACCESS_TOKEN_LIFETIMES_DAYS.map((option) => (
            <option key={option} value={option}>
              {option} days
            </option>
          ))}
        </select>
      </Field>

      <div>
        <Button type="submit" variant="primary" disabled={saving || name.trim() === ''}>
          {saving ? 'Creating…' : 'Create token'}
        </Button>
      </div>
    </form>
  );
}

/** Shown once, straight after creation. Nothing can show this secret again. */
function Created({ created, onDone }: { created: CreatedAccessTokenDto; onDone: () => void }) {
  return (
    <div
      role="status"
      className="flex flex-col gap-3 rounded-md border border-accent bg-surface-sunken p-4 text-sm"
    >
      <p className="font-medium">Copy “{created.token.name}” now. It will not be shown again.</p>
      <div className="flex flex-wrap items-center gap-2">
        <code className="min-w-0 flex-1 rounded bg-surface-raised px-2 py-1.5 font-mono text-[0.8125rem] break-all">
          {created.secret}
        </code>
        <CopyButton text={created.secret} size="sm" label="Copy token" />
      </div>
      <p className="text-text-muted">To connect Claude Code, run:</p>
      <div className="flex flex-wrap items-start gap-2">
        <code className="min-w-0 flex-1 rounded bg-surface-raised px-2 py-1.5 font-mono text-[0.8125rem] break-all">
          {claudeCommand(created.secret)}
        </code>
        <CopyButton text={claudeCommand(created.secret)} size="sm" label="Copy command" />
      </div>
      <p className="text-text-muted">
        Other MCP clients connect to <span className="font-mono">{MCP_URL}</span> with the token as
        a bearer token.
      </p>
      <div>
        <Button size="sm" variant="ghost" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}

function Revoke({ token }: { token: AccessTokenDto }) {
  const queryClient = useQueryClient();
  const [revoking, setRevoking] = useState(false);

  async function revoke() {
    setRevoking(true);
    try {
      await api(`/access/tokens/${token.id}`, { method: 'DELETE' });
      await queryClient.invalidateQueries({ queryKey: TOKENS_KEY });
      toast.success(`Revoked “${token.name}”`);
    } catch (error) {
      toast.error(errorMessage(error));
      setRevoking(false);
    }
  }

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost">
          Revoke
        </Button>
      </DialogTrigger>
      <DialogContent
        title={`Revoke “${token.name}”?`}
        description="Anything using this token loses access to your shelf on its next request."
      >
        <div className="flex justify-end gap-2">
          <DialogClose asChild>
            <Button variant="ghost">Keep it</Button>
          </DialogClose>
          <Button variant="danger" disabled={revoking} onClick={() => void revoke()}>
            {revoking ? 'Revoking…' : 'Revoke token'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Personal access tokens for the MCP endpoint: what lets Claude Code and other
 * clients use the user's prompts. Listed without their secrets, which exist
 * only in the moment after creation.
 */
export function AccessTokens() {
  const queryClient = useQueryClient();
  const tokens = useQuery({
    queryKey: TOKENS_KEY,
    queryFn: () => api<{ tokens: AccessTokenDto[] }>('/access/tokens'),
  });
  const [created, setCreated] = useState<CreatedAccessTokenDto | null>(null);

  return (
    <>
      {created !== null && <Created created={created} onDone={() => setCreated(null)} />}

      {tokens.isError ? (
        <p role="alert" className="text-sm text-danger">
          {errorMessage(tokens.error)}
        </p>
      ) : (tokens.data?.tokens.length ?? 0) > 0 ? (
        <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
          {tokens.data?.tokens.map((token) => (
            <li key={token.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2.5">
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="font-medium">{token.name}</span>
                <span className="text-sm text-text-muted">
                  <span className="font-mono text-[0.8125rem]">{token.display}</span> ·{' '}
                  {describeScopes(token)} · {describeSet(token)}
                </span>
                <span className="text-sm text-text-subtle">
                  {token.lastUsedAt === null
                    ? 'Never used'
                    : `Last used ${formatDate(token.lastUsedAt)}`}{' '}
                  · Expires {formatDate(token.expiresAt)}
                </span>
              </div>
              <Revoke token={token} />
            </li>
          ))}
        </ul>
      ) : (
        tokens.isSuccess && <p className="text-sm text-text-muted">No tokens yet.</p>
      )}

      <NewToken
        onCreated={(next) => {
          setCreated(next);
          void queryClient.invalidateQueries({ queryKey: TOKENS_KEY });
        }}
      />
    </>
  );
}
