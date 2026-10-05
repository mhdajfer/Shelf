import { Download, History } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { cache } from 'react';

import type { PromptDetailDto, PromptDto } from '@shelf/shared';

import { CopyButton } from '@/components/copy-button';
import { OwnerActions } from '@/components/owner-actions';
import { ForkButton, ReportButton } from '@/components/prompt-actions';
import { PromptBody } from '@/components/prompt-body';
import { AuthorLink, categoryLabel, PromptGrid } from '@/components/prompt-card';
import { Button } from '@/components/ui/button';
import { UsePanel } from '@/components/use-panel';
import { VoteButton } from '@/components/vote-button';
import { serverApi, serverApiOrNull } from '@/lib/api-server';
import { routes } from '@/lib/routes';
import { formatDate, plural } from '@/lib/utils';

type Params = Promise<{ id: string }>;

const API_ORIGIN = process.env.NEXT_PUBLIC_API_ORIGIN ?? '';

/** One fetch per request, shared by the metadata and the page. */
const getPrompt = cache(async (id: string): Promise<PromptDetailDto | null> => {
  const result = await serverApiOrNull<{ prompt: PromptDetailDto }>(`/prompts/${id}`);
  return result?.prompt ?? null;
});

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const prompt = await getPrompt((await params).id);
  // A private prompt and a missing one get the same, empty, metadata.
  if (prompt === null) return { title: 'Not found', robots: { index: false } };

  const description = prompt.description ?? prompt.body.replace(/\s+/g, ' ').trim().slice(0, 160);
  const indexable = prompt.visibility === 'public' && prompt.status === 'active';

  return {
    title: prompt.title,
    description,
    alternates: { canonical: routes.prompt(prompt.id) },
    robots: { index: indexable, follow: indexable },
    openGraph: { title: prompt.title, description, type: 'article' },
  };
}

export default async function PromptPage({ params }: { params: Params }) {
  const prompt = await getPrompt((await params).id);
  if (prompt === null) notFound();

  const isPublic = prompt.visibility === 'public';
  const votable = isPublic && prompt.status === 'active';
  const forks =
    prompt.forkCount > 0
      ? (await serverApi<{ items: PromptDto[] }>(`/prompts/${prompt.id}/forks`)).items
      : [];

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-5 py-8">
      {prompt.status === 'hidden' && (
        <p
          role="status"
          className="rounded-md border border-warning px-3 py-2 text-sm text-warning"
        >
          This prompt was reported and is hidden from the public shelf until a moderator reviews it.
          Only you can see it.
        </p>
      )}

      <header className="flex flex-col gap-3">
        <p className="text-sm text-text-subtle">
          <Link href={`/?category=${prompt.category}`} className="hover:text-text hover:underline">
            {categoryLabel(prompt.category)}
          </Link>
          {!isPublic && ' · Private'}
        </p>
        <h1 className="text-2xl font-semibold tracking-tight text-balance">{prompt.title}</h1>
        {prompt.description !== null && (
          <p className="max-w-prose text-text-muted">{prompt.description}</p>
        )}
        <p className="flex flex-wrap gap-x-2 text-sm text-text-muted">
          <span>
            By <AuthorLink author={prompt.author} />
          </span>
          <span aria-hidden>·</span>
          <span>Version {prompt.versionNumber}</span>
          <span aria-hidden>·</span>
          <span>Updated {formatDate(prompt.updatedAt)}</span>
          {prompt.modelHint !== null && (
            <>
              <span aria-hidden>·</span>
              <span>Written for {prompt.modelHint}</span>
            </>
          )}
        </p>
        {prompt.forkedFrom !== null && (
          <p className="text-sm text-text-muted">
            Forked from{' '}
            <Link href={routes.prompt(prompt.forkedFrom.id)} className="text-accent underline">
              {prompt.forkedFrom.title}
            </Link>{' '}
            by <AuthorLink author={prompt.forkedFrom.author} />
          </p>
        )}
        {prompt.tags.length > 0 && (
          <ul className="flex flex-wrap gap-x-3 gap-y-1">
            {prompt.tags.map((tag) => (
              <li key={tag}>
                <Link
                  href={`/?tag=${encodeURIComponent(tag)}`}
                  className="font-mono text-[0.8125rem] text-text-muted hover:text-text hover:underline"
                >
                  #{tag}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <VoteButton
          promptId={prompt.id}
          initialCount={prompt.upvoteCount}
          initialVoted={prompt.viewer.hasVoted}
          disabled={!votable}
        />
        {/* Your own prompt is already on your shelf; forking it would only copy it. */}
        {!prompt.viewer.isOwner && <ForkButton promptId={prompt.id} forkId={prompt.viewerForkId} />}
        <Button asChild variant="ghost">
          <Link href={routes.promptHistory(prompt.id)}>
            <History />
            History
          </Link>
        </Button>
        {isPublic && !prompt.viewer.isOwner && <ReportButton promptId={prompt.id} />}
        {prompt.viewer.isOwner && <OwnerActions prompt={prompt} />}
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <section aria-labelledby="source" className="flex min-w-0 flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <h2 id="source" className="font-medium">
              Prompt
            </h2>
            <div className="flex items-center gap-1">
              <Button asChild variant="ghost" size="sm">
                {/* A plain link to the API: the browser downloads the file it returns. */}
                <a href={`${API_ORIGIN}/api/v1/prompts/${prompt.id}/export`} download>
                  <Download />
                  Markdown
                </a>
              </Button>
              <CopyButton text={prompt.body} variant="ghost" size="sm" label="Copy source" />
            </div>
          </div>
          <PromptBody body={prompt.body} />
        </section>

        <UsePanel
          body={prompt.body}
          {...(prompt.currentVersionId === null
            ? {}
            : { run: { promptId: prompt.id, versionId: prompt.currentVersionId } })}
        />
      </div>

      {forks.length > 0 && (
        <section aria-labelledby="forks" className="flex flex-col gap-3">
          <h2 id="forks" className="font-medium">
            {plural(forks.length, 'public fork')}
          </h2>
          <PromptGrid prompts={forks} />
        </section>
      )}
    </main>
  );
}
