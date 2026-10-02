'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { toast } from 'sonner';

import {
  CATEGORIES,
  CATEGORY_LABELS,
  createPromptSchema,
  LIMITS,
  parseTemplate,
  updatePromptSchema,
  type Category,
  type CreditsDto,
  type PromptDetailDto,
  type Visibility,
} from '@shelf/shared';

import { CodeEditor } from '@/components/code-editor';
import { Turnstile, turnstileEnabled } from '@/components/turnstile';
import { Button } from '@/components/ui/button';
import { describedBy, Field, Input, Textarea } from '@/components/ui/field';
import { UsePanel } from '@/components/use-panel';
import { api } from '@/lib/api-client';
import { ApiError, errorMessage } from '@/lib/api-error';
import { routes } from '@/lib/routes';
import { useSession } from '@/lib/session';
import { cn } from '@/lib/utils';

interface Draft {
  title: string;
  description: string;
  body: string;
  category: Category | '';
  modelHint: string;
  tags: string;
  visibility: Visibility;
  note: string;
}

const EMPTY: Draft = {
  title: '',
  description: '',
  body: '',
  category: '',
  modelHint: '',
  tags: '',
  visibility: 'private',
  note: '',
};

const fromPrompt = (prompt: PromptDetailDto): Draft => ({
  title: prompt.title,
  description: prompt.description ?? '',
  body: prompt.body,
  category: prompt.category as Category,
  modelHint: prompt.modelHint ?? '',
  tags: prompt.tags.join(', '),
  visibility: prompt.visibility,
  note: '',
});

const parseTags = (raw: string): string[] => [
  ...new Set(
    raw
      .split(/[,\s]+/)
      .map((tag) => tag.trim().replace(/^#/, '').toLowerCase())
      .filter(Boolean),
  ),
];

type FieldErrors = Partial<Record<keyof Draft, string>>;

const selectClass =
  'h-9 w-full rounded-md border border-border-strong bg-surface-raised px-2.5 text-sm text-text aria-invalid:border-danger';

function VisibilityToggle({
  value,
  onChange,
}: {
  value: Visibility;
  onChange: (value: Visibility) => void;
}) {
  const options: { value: Visibility; label: string; hint: string }[] = [
    { value: 'private', label: 'Private', hint: 'Only you can see it.' },
    { value: 'public', label: 'Public', hint: 'Listed on the public shelf.' },
  ];
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1.5 text-sm font-medium">Visibility</legend>
      <div className="grid grid-cols-2 gap-2">
        {options.map((option) => (
          <label
            key={option.value}
            className={cn(
              'flex cursor-pointer flex-col gap-0.5 rounded-md border border-border-strong bg-surface-raised px-3 py-2 text-sm has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-accent',
              value === option.value && 'border-accent',
            )}
          >
            <span className="flex items-center gap-2 font-medium">
              <input
                type="radio"
                name="visibility"
                value={option.value}
                checked={value === option.value}
                onChange={() => onChange(option.value)}
                className="accent-accent outline-none"
              />
              {option.label}
            </span>
            <span className="text-text-subtle">{option.hint}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/**
 * One form for a new prompt and for editing one. A signed-in user chooses the
 * visibility; a guest posts publicly on a daily allowance, shown before they
 * start typing rather than discovered on save.
 */
export function PromptForm({ prompt }: { prompt?: PromptDetailDto }) {
  const editing = prompt !== undefined;
  const { user } = useSession();
  const router = useRouter();
  const isGuest = user === null;

  const initial = useMemo<Draft>(
    () => (prompt === undefined ? EMPTY : fromPrompt(prompt)),
    [prompt],
  );
  const [draft, setDraft] = useState<Draft>(initial);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);

  const credits = useQuery({
    queryKey: ['credits'],
    queryFn: () => api<{ credits: CreditsDto }>('/credits'),
    enabled: isGuest && !editing,
  });
  const createCredits = credits.data?.credits.create ?? null;
  const outOfCredits =
    isGuest && !editing && createCredits !== null && createCredits.remaining === 0;

  const parsed = useMemo(() => parseTemplate(draft.body), [draft.body]);
  const tags = parseTags(draft.tags);
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const bodyChanged = editing && draft.body !== initial.body;

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: undefined }));
  }

  // Leaving with unsaved edits asks first. The browser supplies the wording.
  useEffect(() => {
    if (!dirty || saving) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, saving]);

  async function save() {
    if (saving) return;
    setFormError(null);

    const payload = {
      title: draft.title,
      description: draft.description,
      category: draft.category,
      modelHint: draft.modelHint,
      body: draft.body,
      tags,
      // The API decides a guest's visibility; sending one would be refused.
      ...(isGuest ? {} : { visibility: draft.visibility }),
      ...(draft.note.trim() === '' ? {} : { note: draft.note }),
      ...(turnstileToken === null ? {} : { turnstileToken }),
    };

    // The same schema the API validates with, so an error shows up under its
    // field before a request is made.
    const checked = (editing ? updatePromptSchema : createPromptSchema).safeParse(payload);
    if (!checked.success) {
      const next: FieldErrors = {};
      for (const issue of checked.error.issues) {
        const field = issue.path[0] as keyof Draft | undefined;
        if (field !== undefined && next[field] === undefined) next[field] = issue.message;
      }
      setErrors(next);
      setFormError('Some fields need fixing.');
      return;
    }

    setSaving(true);
    try {
      const result = editing
        ? await api<{ prompt: PromptDetailDto }>(`/prompts/${prompt.id}`, {
            method: 'PATCH',
            body: payload,
          })
        : await api<{ prompt: PromptDetailDto }>('/prompts', { method: 'POST', body: payload });

      toast.success(
        !editing
          ? 'Prompt saved'
          : result.prompt.versionNumber > prompt.versionNumber
            ? `Saved as version ${String(result.prompt.versionNumber)}`
            : 'Changes saved',
      );
      router.push(routes.prompt(result.prompt.id));
      router.refresh();
    } catch (error) {
      if (error instanceof ApiError && error.details.length > 0) {
        const next: FieldErrors = {};
        for (const detail of error.details) next[detail.field as keyof Draft] = detail.message;
        setErrors(next);
      }
      setFormError(errorMessage(error));
      setSaving(false);
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void save();
  }

  const needsToken = isGuest && !editing && turnstileEnabled && turnstileToken === null;

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      {/* The preview sits outside the form, so Enter in one of its fields
          fills in a variable instead of saving the prompt. */}
      <form
        onSubmit={onSubmit}
        noValidate
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
            event.preventDefault();
            void save();
          }
        }}
        className="flex min-w-0 flex-col gap-5"
      >
        {isGuest && !editing && (
          <p className="rounded-md border border-border bg-surface-sunken px-3 py-2 text-sm text-text-muted">
            You are posting as a guest. Guest prompts are public and can be edited for 24 hours.
            {createCredits !== null &&
              ` ${String(createCredits.remaining)} of ${String(createCredits.limit)} left today.`}{' '}
            <Link href={routes.signIn(routes.newPrompt)} className="text-accent underline">
              Sign in
            </Link>{' '}
            to keep prompts private and edit them any time.
          </p>
        )}

        {formError !== null && (
          <p role="alert" className="rounded-md border border-danger px-3 py-2 text-sm text-danger">
            {formError}
          </p>
        )}

        <Field id="title" label="Title" error={errors.title}>
          <Input
            id="title"
            value={draft.title}
            onChange={(event) => set('title', event.target.value)}
            maxLength={LIMITS.titleMax}
            placeholder="What the prompt does, in a few words"
            {...describedBy('title', errors.title)}
          />
        </Field>

        <Field
          id="description"
          label="Description"
          hint="One or two sentences on when to use it. Optional."
          error={errors.description}
        >
          <Textarea
            id="description"
            value={draft.description}
            onChange={(event) => set('description', event.target.value)}
            maxLength={LIMITS.descriptionMax}
            rows={2}
            {...describedBy('description', errors.description, true)}
          />
        </Field>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between gap-2">
            {/* Not a <label>: the editor is a contenteditable with its own aria-label. */}
            <span className="text-sm font-medium">Prompt</span>
            <span className="text-sm text-text-subtle tabular-nums">
              {draft.body.length.toLocaleString('en')} / {LIMITS.bodyMax.toLocaleString('en')}
            </span>
          </div>
          <CodeEditor
            value={draft.body}
            onChange={(value) => set('body', value)}
            onSave={() => void save()}
            label="Prompt body"
            describedBy="body-help"
            invalid={errors.body !== undefined}
            placeholderText={'Write the prompt. Mark inputs as {{name}} or {{name:default}}.'}
          />
          <div id="body-help" className="flex flex-col gap-1 text-sm">
            {errors.body !== undefined && (
              <p role="alert" className="text-danger">
                {errors.body}
              </p>
            )}
            {parsed.diagnostics.length > 0 ? (
              <ul className="flex flex-col gap-0.5 text-warning">
                {parsed.diagnostics.map((issue) => (
                  <li key={`${issue.code}-${String(issue.start)}`}>{issue.message}</li>
                ))}
              </ul>
            ) : (
              <p className="text-text-subtle">
                {
                  'Inputs are written as {{name}} or {{name:default}}. Use \\{{ for a literal brace.'
                }
              </p>
            )}
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="category" label="Category" error={errors.category}>
            <select
              id="category"
              value={draft.category}
              onChange={(event) => set('category', event.target.value as Category | '')}
              className={selectClass}
              {...describedBy('category', errors.category)}
            >
              <option value="" disabled>
                Choose one
              </option>
              {CATEGORIES.map((category) => (
                <option key={category} value={category}>
                  {CATEGORY_LABELS[category]}
                </option>
              ))}
            </select>
          </Field>

          <Field
            id="modelHint"
            label="Written for"
            hint="The model it was tuned on. Optional."
            error={errors.modelHint}
          >
            <Input
              id="modelHint"
              value={draft.modelHint}
              onChange={(event) => set('modelHint', event.target.value)}
              maxLength={LIMITS.modelHintMax}
              placeholder="any"
              {...describedBy('modelHint', errors.modelHint, true)}
            />
          </Field>
        </div>

        <Field
          id="tags"
          label="Tags"
          hint={`Up to ${String(LIMITS.tagsMax)}, separated by commas.`}
          error={errors.tags}
        >
          <Input
            id="tags"
            value={draft.tags}
            onChange={(event) => set('tags', event.target.value)}
            placeholder="editing, release-notes"
            autoCapitalize="none"
            {...describedBy('tags', errors.tags, true)}
          />
        </Field>

        {!isGuest && (
          <VisibilityToggle
            value={draft.visibility}
            onChange={(value) => set('visibility', value)}
          />
        )}

        {bodyChanged && (
          <Field
            id="note"
            label="What changed?"
            hint="Saved with the new version, and shown in its history. Optional."
            error={errors.note}
          >
            <Input
              id="note"
              value={draft.note}
              onChange={(event) => set('note', event.target.value)}
              maxLength={LIMITS.versionNoteMax}
              {...describedBy('note', errors.note, true)}
            />
          </Field>
        )}

        {isGuest && !editing && <Turnstile onToken={setTurnstileToken} />}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="submit"
            variant="primary"
            disabled={saving || outOfCredits || needsToken || (editing && !dirty)}
          >
            {saving ? 'Saving…' : editing ? 'Save changes' : 'Save prompt'}
          </Button>
          <Button asChild variant="ghost">
            <Link href={editing ? routes.prompt(prompt.id) : isGuest ? routes.home : routes.shelf}>
              Cancel
            </Link>
          </Button>
          {outOfCredits && (
            <p className="text-sm text-text-muted">
              You have used today&apos;s guest prompts.{' '}
              <Link href={routes.signIn(routes.newPrompt)} className="text-accent underline">
                Sign in
              </Link>{' '}
              to keep going.
            </p>
          )}
        </div>
      </form>

      <aside className="flex min-w-0 flex-col gap-4 lg:sticky lg:top-4">
        <section
          aria-labelledby="variables-heading"
          className="flex flex-col gap-2 rounded-lg border border-border bg-surface-raised p-4"
        >
          <h2 id="variables-heading" className="font-medium">
            Variables
          </h2>
          {parsed.variables.length === 0 ? (
            <p className="text-sm text-text-muted">
              {'None yet. Anything written as {{name}} becomes an input.'}
            </p>
          ) : (
            <ul className="flex flex-col gap-1 text-sm">
              {parsed.variables.map((variable) => (
                <li key={variable.name} className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-mono text-[0.8125rem]">{variable.name}</span>
                  <span className="text-text-subtle">
                    {variable.defaultValue !== undefined && `default "${variable.defaultValue}" · `}
                    used{' '}
                    {variable.occurrences === 1 ? 'once' : `${String(variable.occurrences)} times`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {draft.body.trim() !== '' && <UsePanel body={draft.body} heading="Preview" />}
      </aside>
    </div>
  );
}
