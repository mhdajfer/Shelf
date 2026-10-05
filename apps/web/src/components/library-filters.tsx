import { Search } from 'lucide-react';
import Link from 'next/link';

import { CATEGORIES, CATEGORY_LABELS, type PublicListQuery, type PublicSort } from '@shelf/shared';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/field';
import { cn } from '@/lib/utils';

export type LibraryQuery = Pick<PublicListQuery, 'q' | 'sort' | 'category' | 'tag' | 'page'>;

/**
 * The library's state lives in the URL, so every filter is a plain link: it
 * works without JavaScript, can be shared, and the back button undoes it.
 * Changing a filter returns to the first page.
 */
export function libraryHref(current: LibraryQuery, patch: Partial<LibraryQuery> = {}): string {
  const next = { ...current, page: 1, ...patch };
  const params = new URLSearchParams();
  if (next.q !== undefined && next.q !== '') params.set('q', next.q);
  if (next.sort !== 'trending') params.set('sort', next.sort);
  if (next.category !== undefined) params.set('category', next.category);
  if (next.tag.length > 0) params.set('tag', next.tag.join(','));
  if (next.page > 1) params.set('page', String(next.page));
  const query = params.toString();
  return query === '' ? '/' : `/?${query}`;
}

const SORTS: { value: PublicSort; label: string }[] = [
  { value: 'trending', label: 'Trending' },
  { value: 'new', label: 'New' },
  { value: 'top_week', label: 'Top this week' },
  { value: 'top_all', label: 'Top of all time' },
];

const chip =
  'inline-flex h-7 items-center gap-1.5 rounded-full border border-border px-2.5 text-sm text-text-muted transition-colors duration-fast ease-shelf hover:border-border-strong hover:text-text';
const chipActive =
  'border-accent bg-accent text-accent-contrast hover:border-accent hover:text-accent-contrast';

export function LibraryFilters({
  query,
  categoryCounts,
  topTags,
}: {
  query: LibraryQuery;
  categoryCounts: Map<string, number>;
  topTags: { name: string; count: number }[];
}) {
  const searching = query.q !== undefined && query.q !== '';
  // Selected tags stay visible even when they are not among the most used.
  const tags = [...new Set([...query.tag, ...topTags.map((tag) => tag.name)])];

  return (
    <div className="flex flex-col gap-4">
      <form action="/" role="search" className="flex gap-2">
        {query.sort !== 'trending' && <input type="hidden" name="sort" value={query.sort} />}
        {query.category !== undefined && (
          <input type="hidden" name="category" value={query.category} />
        )}
        {query.tag.length > 0 && <input type="hidden" name="tag" value={query.tag.join(',')} />}
        <div className="relative flex-1">
          <Search
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-text-subtle"
          />
          <Input
            type="search"
            name="q"
            defaultValue={query.q ?? ''}
            placeholder={'Search prompts. Try "release notes" or sql -beginner'}
            aria-label="Search the public shelf"
            className="pl-9"
          />
        </div>
        <Button type="submit" variant="primary">
          Search
        </Button>
      </form>

      <nav aria-label="Category" className="flex flex-wrap gap-1.5">
        <Link
          href={libraryHref(query, { category: undefined })}
          aria-current={query.category === undefined ? 'true' : undefined}
          className={cn(chip, query.category === undefined && chipActive)}
        >
          All
        </Link>
        {CATEGORIES.map((category) => {
          const active = query.category === category;
          return (
            <Link
              key={category}
              href={libraryHref(query, { category: active ? undefined : category })}
              aria-current={active ? 'true' : undefined}
              className={cn(chip, active && chipActive)}
            >
              {CATEGORY_LABELS[category]}
              <span className={cn('tabular-nums', active ? 'opacity-80' : 'text-text-subtle')}>
                {categoryCounts.get(category) ?? 0}
              </span>
            </Link>
          );
        })}
      </nav>

      {tags.length > 0 && (
        <nav aria-label="Tag" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <span className="text-text-subtle">Tags</span>
          {tags.map((tag) => {
            const active = query.tag.includes(tag);
            return (
              <Link
                key={tag}
                href={libraryHref(query, {
                  tag: active ? query.tag.filter((name) => name !== tag) : [...query.tag, tag],
                })}
                aria-current={active ? 'true' : undefined}
                className={cn(
                  'font-mono text-[0.8125rem] text-text-muted hover:text-text hover:underline',
                  active && 'text-accent underline',
                )}
              >
                #{tag}
              </Link>
            );
          })}
        </nav>
      )}

      {/* Search results are ordered by relevance, so the sort tabs would mislead. */}
      {!searching && (
        <nav aria-label="Sort" className="flex gap-1 border-b border-border">
          {SORTS.map((sort) => {
            const active = query.sort === sort.value;
            return (
              <Link
                key={sort.value}
                href={libraryHref(query, { sort: sort.value })}
                aria-current={active ? 'true' : undefined}
                className={cn(
                  '-mb-px border-b-2 border-transparent px-3 py-2 text-sm text-text-muted hover:text-text',
                  active && 'border-accent text-text',
                )}
              >
                {sort.label}
              </Link>
            );
          })}
        </nav>
      )}
    </div>
  );
}

export function Pagination({
  page,
  total,
  limit,
  hrefFor,
}: {
  page: number;
  total: number;
  limit: number;
  hrefFor: (page: number) => string;
}) {
  const pages = Math.max(1, Math.ceil(total / limit));
  if (pages <= 1) return null;

  return (
    <nav aria-label="Pages" className="flex items-center justify-between gap-4 text-sm">
      <Button asChild={page > 1} disabled={page <= 1}>
        {page > 1 ? <Link href={hrefFor(page - 1)}>Previous</Link> : 'Previous'}
      </Button>
      <span className="text-text-muted tabular-nums">
        Page {page} of {pages}
      </span>
      <Button asChild={page < pages} disabled={page >= pages}>
        {page < pages ? <Link href={hrefFor(page + 1)}>Next</Link> : 'Next'}
      </Button>
    </nav>
  );
}
