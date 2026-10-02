'use client';

import { useQueryClient } from '@tanstack/react-query';
import { Download, Upload } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { toast } from 'sonner';

import {
  LIMITS,
  NAME_MAX,
  PASSWORD_MIN,
  type ImportResultDto,
  type SessionUser,
} from '@shelf/shared';

import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogTrigger } from '@/components/ui/dialog';
import { describedBy, Field, Input } from '@/components/ui/field';
import { api, API_BASE } from '@/lib/api-client';
import { ApiError, errorMessage } from '@/lib/api-error';
import { routes } from '@/lib/routes';
import { useSession } from '@/lib/session';
import { plural } from '@/lib/utils';

type FieldErrors = Record<string, string | undefined>;

/** The API's field errors keyed by field, plus a message for anything left over. */
function readError(error: unknown): { fields: FieldErrors; message: string | null } {
  if (error instanceof ApiError && error.details.length > 0) {
    return {
      fields: Object.fromEntries(error.details.map((detail) => [detail.field, detail.message])),
      message: null,
    };
  }
  return { fields: {}, message: errorMessage(error) };
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="grid gap-4 border-t border-border pt-6 md:grid-cols-[14rem_minmax(0,1fr)] md:gap-8">
      <div className="flex flex-col gap-1">
        <h2 className="font-medium">{title}</h2>
        {description !== undefined && <p className="text-sm text-text-muted">{description}</p>}
      </div>
      <div className="flex min-w-0 flex-col gap-4">{children}</div>
    </section>
  );
}

function FormMessage({ message }: { message: string | null }) {
  if (message === null) return null;
  return (
    <p role="alert" className="text-sm text-danger">
      {message}
    </p>
  );
}

function ProfileForm({ user }: { user: SessionUser }) {
  const { refresh } = useSession();
  const router = useRouter();
  const [name, setName] = useState(user.name ?? '');
  const [handle, setHandle] = useState(user.handle);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const dirty = name !== (user.name ?? '') || handle !== user.handle;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setErrors({});
    setMessage(null);
    try {
      await api('/auth/me', { method: 'PATCH', body: { name, handle } });
      await refresh();
      router.refresh();
      toast.success('Profile saved');
    } catch (error) {
      const read = readError(error);
      setErrors(read.fields);
      setMessage(read.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="flex max-w-sm flex-col gap-4">
      <FormMessage message={message} />
      <Field id="name" label="Name" hint="Shown on prompts you publish." error={errors.name}>
        <Input
          id="name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={NAME_MAX}
          autoComplete="name"
          {...describedBy('name', errors.name, true)}
        />
      </Field>
      <Field
        id="handle"
        label="Handle"
        hint={`Your profile is at /u/${handle || 'handle'}. Lowercase letters, numbers, underscores.`}
        error={errors.handle}
      >
        <Input
          id="handle"
          value={handle}
          onChange={(event) => setHandle(event.target.value.toLowerCase())}
          maxLength={LIMITS.handleMax}
          autoCapitalize="none"
          spellCheck={false}
          className="font-mono"
          {...describedBy('handle', errors.handle, true)}
        />
      </Field>
      <div>
        <Button type="submit" variant="primary" disabled={saving || !dirty}>
          {saving ? 'Saving…' : 'Save profile'}
        </Button>
      </div>
    </form>
  );
}

function PasswordForm({ user }: { user: SessionUser }) {
  const { refresh } = useSession();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setErrors({});
    setMessage(null);
    try {
      await api('/auth/change-password', {
        method: 'POST',
        body: { ...(user.hasPassword ? { currentPassword } : {}), newPassword },
      });
      setCurrentPassword('');
      setNewPassword('');
      await refresh();
      toast.success(user.hasPassword ? 'Password changed' : 'Password set', {
        description: 'Your other sessions were signed out.',
      });
    } catch (error) {
      const read = readError(error);
      setErrors(read.fields);
      setMessage(read.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="flex max-w-sm flex-col gap-4">
      <FormMessage message={message} />
      {user.hasPassword && (
        <Field id="currentPassword" label="Current password" error={errors.currentPassword}>
          <Input
            id="currentPassword"
            type="password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
            autoComplete="current-password"
            {...describedBy('currentPassword', errors.currentPassword)}
          />
        </Field>
      )}
      <Field
        id="newPassword"
        label="New password"
        hint={`At least ${String(PASSWORD_MIN)} characters.`}
        error={errors.newPassword}
      >
        <Input
          id="newPassword"
          type="password"
          value={newPassword}
          onChange={(event) => setNewPassword(event.target.value)}
          autoComplete="new-password"
          {...describedBy('newPassword', errors.newPassword, true)}
        />
      </Field>
      <div>
        <Button type="submit" disabled={saving || newPassword === ''}>
          {saving ? 'Saving…' : user.hasPassword ? 'Change password' : 'Set a password'}
        </Button>
      </div>
    </form>
  );
}

function DataTransfer() {
  const queryClient = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<ImportResultDto | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function importFile(file: File) {
    setImporting(true);
    setResult(null);
    setMessage(null);
    try {
      let parsed: unknown;
      try {
        parsed = JSON.parse(await file.text());
      } catch {
        throw new ApiError(400, 'bad_request', 'That file is not valid JSON.');
      }
      const outcome = await api<ImportResultDto>('/import', { method: 'POST', body: parsed });
      setResult(outcome);
      await queryClient.invalidateQueries({ queryKey: ['shelf'] });
    } catch (error) {
      const read = readError(error);
      setMessage(
        read.message ?? Object.values(read.fields)[0] ?? 'That file could not be imported.',
      );
    } finally {
      setImporting(false);
      // Clear the field so choosing the same file again triggers a change.
      if (input.current !== null) input.current.value = '';
    }
  }

  return (
    <>
      <div className="flex flex-wrap gap-2">
        <Button asChild>
          {/* A navigation, so the browser handles the download and sends the session cookie. */}
          <a href={`${API_BASE}/export`} download>
            <Download />
            Export your shelf
          </a>
        </Button>
        <Button onClick={() => input.current?.click()} disabled={importing}>
          <Upload />
          {importing ? 'Importing…' : 'Import a file'}
        </Button>
        <input
          ref={input}
          type="file"
          accept="application/json,.json"
          className="sr-only"
          aria-label="Shelf export file to import"
          tabIndex={-1}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file !== undefined) void importFile(file);
          }}
        />
      </div>
      <p className="text-sm text-text-muted">
        The export is one JSON file with every prompt, its full history, tags, and collections.
        Imported prompts always arrive private.
      </p>

      <FormMessage message={message} />
      {result !== null && (
        <div
          role="status"
          className="rounded-md border border-border bg-surface-sunken p-3 text-sm"
        >
          <p>
            Imported {plural(result.imported, 'prompt')}
            {result.skipped.length > 0 && `, skipped ${String(result.skipped.length)}`}.
          </p>
          {result.skipped.length > 0 && (
            <ul className="mt-2 flex flex-col gap-1 text-text-muted">
              {result.skipped.map((entry) => (
                <li key={entry.index}>
                  {entry.title ?? `Entry ${String(entry.index + 1)}`}: {entry.reason}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </>
  );
}

function DeleteAccount({ user }: { user: SessionUser }) {
  const router = useRouter();
  const { refresh } = useSession();
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [deleting, setDeleting] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setDeleting(true);
    setError(undefined);
    try {
      await api('/auth/delete-account', {
        method: 'POST',
        body: user.hasPassword ? { password: value } : { confirmHandle: value },
      });
      await refresh();
      toast.success('Account deleted');
      router.push(routes.home);
      router.refresh();
    } catch (caught) {
      const read = readError(caught);
      setError(read.message ?? Object.values(read.fields)[0]);
      setDeleting(false);
    }
  }

  return (
    <Dialog>
      <div>
        <DialogTrigger asChild>
          <Button variant="danger">Delete account</Button>
        </DialogTrigger>
      </div>
      <DialogContent
        title="Delete your account?"
        description="Your prompts, their history, and your collections are deleted with it, including anything on the public shelf. This cannot be undone. Export your shelf first if you want a copy."
      >
        <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
          <Field
            id="delete-confirm"
            label={
              user.hasPassword ? 'Your password' : `Type your handle, ${user.handle}, to confirm`
            }
            error={error}
          >
            <Input
              id="delete-confirm"
              type={user.hasPassword ? 'password' : 'text'}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              autoComplete={user.hasPassword ? 'current-password' : 'off'}
              {...describedBy('delete-confirm', error)}
            />
          </Field>
          <div className="flex justify-end gap-2">
            <DialogClose asChild>
              <Button variant="ghost">Keep my account</Button>
            </DialogClose>
            <Button type="submit" variant="danger" disabled={deleting || value === ''}>
              {deleting ? 'Deleting…' : 'Delete account'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function Settings() {
  const { user } = useSession();
  // Signed out in another tab: the page's redirect handles the next load.
  if (user === null) return null;

  return (
    <div className="flex flex-col gap-6">
      <Section title="Profile" description={user.email}>
        <ProfileForm user={user} />
      </Section>
      <Section
        title="Password"
        description={
          user.hasPassword
            ? 'Changing it signs out your other sessions.'
            : 'You sign in with Google. Set a password to sign in with your email as well.'
        }
      >
        <PasswordForm user={user} />
      </Section>
      <Section title="Your data" description="Take your shelf with you, or bring one in.">
        <DataTransfer />
      </Section>
      <Section title="Delete account" description="Permanent, and immediate.">
        <DeleteAccount user={user} />
      </Section>
    </div>
  );
}
