import { GitFork, Lock } from 'lucide-react';
import Link from 'next/link';

import { brand } from '@shelf/config';
import { CATEGORY_LABELS, type Category, type PromptDto } from '@shelf/shared';

import { CopyButton } from '@/components/copy-button';
import { PromptBody } from '@/components/prompt-body';
import { VoteButton } from '@/components/vote-button';
import { routes } from '@/lib/routes';
import { formatCount } from '@/lib/utils';

export function AuthorLink({ author }: { author: PromptDto['author'] }) {
  if (author.kind === 'guest') {
    return (
      <span title="Posted without an account">
        {brand.guestDisplayName} <span className="font-mono">{author.handle}</span>
      </span>
    );
  }
  return (
    <Link href={routes.profile(author.handle)} className="hover:text-text hover:underline">
      {author.name ?? author.handle}
    </Link>
  );
}

export const categoryLabel = (category: string): string =>
  CATEGORY_LABELS[category as Category] ?? category;

export function PromptCard({
  prompt,
  href = routes.prompt(prompt.id),
}: {
  prompt: PromptDto;
  /** The shelf links a card to its editor; everywhere else it goes to the public page. */
  href?: string;
}) {
  const votable = prompt.visibility === 'public' && prompt.status === 'active';

  return (
    <article className="flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-surface-raised p-4">
      <div className="flex flex-col gap-1">
        <h3 className="flex items-start gap-2 font-medium text-balance">
          <Link href={href} className="hover:underline">
            {prompt.title}
          </Link>
          {prompt.visibility === 'private' && (
            <Lock aria-label="Private" className="mt-1 size-3.5 shrink-0 text-text-subtle" />
          )}
        </h3>
        {prompt.description !== null && (
          <p className="line-clamp-2 text-sm text-text-muted">{prompt.description}</p>
        )}
      </div>

      <PromptBody body={prompt.body} clamp />

      <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-text-subtle">
        <VoteButton
          promptId={prompt.id}
          initialCount={prompt.upvoteCount}
          initialVoted={prompt.viewer.hasVoted}
          disabled={!votable}
        />
        {prompt.forkCount > 0 && (
          <span className="inline-flex items-center gap-1 tabular-nums" title="Forks">
            <GitFork className="size-3.5" aria-hidden />
            {formatCount(prompt.forkCount)}
            <span className="sr-only"> forks</span>
          </span>
        )}
        <span className="min-w-0 truncate">
          <AuthorLink author={prompt.author} /> · {categoryLabel(prompt.category)}
        </span>
        <CopyButton text={prompt.body} variant="ghost" size="sm" className="ml-auto" />
      </div>
    </article>
  );
}

export function PromptGrid({
  prompts,
  hrefFor,
}: {
  prompts: PromptDto[];
  hrefFor?: (prompt: PromptDto) => string;
}) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {prompts.map((prompt) => (
        <PromptCard
          key={prompt.id}
          prompt={prompt}
          {...(hrefFor === undefined ? {} : { href: hrefFor(prompt) })}
        />
      ))}
    </div>
  );
}
