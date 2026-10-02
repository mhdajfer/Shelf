import type { Metadata } from 'next';
import Link from 'next/link';

import { brand } from '@shelf/config';
import { publicListQuerySchema, type PromptListDto } from '@shelf/shared';

import {
  LibraryFilters,
  libraryHref,
  Pagination,
  type LibraryQuery,
} from '@/components/library-filters';
import { PromptGrid } from '@/components/prompt-card';
import { serverApi } from '@/lib/api-server';
import { plural } from '@/lib/utils';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** A hand-edited URL falls back to the default view instead of an error page. */
function parseQuery(raw: Record<string, string | string[] | undefined>): LibraryQuery {
  const parsed = publicListQuerySchema.safeParse(raw);
  return parsed.success ? parsed.data : publicListQuerySchema.parse({});
}

function apiQuery(query: LibraryQuery): string {
  const params = new URLSearchParams({ sort: query.sort, page: String(query.page) });
  if (query.q !== undefined && query.q !== '') params.set('q', query.q);
  if (query.category !== undefined) params.set('category', query.category);
  if (query.tag.length > 0) params.set('tag', query.tag.join(','));
  return params.toString();
}

export async function generateMetadata({
  searchParams,
}: {
  searchParams: SearchParams;
}): Promise<Metadata> {
  const query = parseQuery(await searchParams);
  const filtered = query.q !== undefined || query.category !== undefined || query.tag.length > 0;
  return {
    title: query.q !== undefined && query.q !== '' ? `Search: ${query.q}` : 'The public shelf',
    // Filtered and paged views are the same prompts in another order; only the
    // canonical listing should be indexed.
    ...(filtered || query.page > 1 ? { robots: { index: false, follow: true } } : {}),
    alternates: { canonical: '/' },
  };
}

export default async function LibraryPage({ searchParams }: { searchParams: SearchParams }) {
  const query = parseQuery(await searchParams);

  const [list, { categories }, { tags }] = await Promise.all([
    serverApi<PromptListDto>(`/prompts?${apiQuery(query)}`),
    serverApi<{ categories: { category: string; count: number }[] }>('/categories'),
    serverApi<{ tags: { name: string; count: number }[] }>('/tags'),
  ]);

  const searching = query.q !== undefined && query.q !== '';
  const filtered = searching || query.category !== undefined || query.tag.length > 0;

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-5 py-8">
      <div className="flex flex-col gap-1">
        <h1 className="font-mono text-2xl tracking-tight">The public shelf</h1>
        <p className="max-w-prose text-text-muted">
          {brand.description} Copy one as it is, or fork it and make it yours.
        </p>
      </div>

      <LibraryFilters
        query={query}
        categoryCounts={new Map(categories.map((row) => [row.category, row.count]))}
        topTags={tags}
      />

      <section aria-labelledby="results" className="flex flex-col gap-4">
        <h2 id="results" className="text-sm text-text-muted">
          {searching
            ? `${plural(list.total, 'result')} for “${query.q ?? ''}”`
            : plural(list.total, 'prompt')}
          {filtered && (
            <>
              {' · '}
              <Link href="/" className="text-accent underline">
                Clear filters
              </Link>
            </>
          )}
        </h2>

        {list.items.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border-strong p-8 text-center">
            <p className="font-medium">
              {filtered ? 'Nothing on the shelf matches that.' : 'The shelf is empty.'}
            </p>
            <p className="mt-1 text-sm text-text-muted">
              {filtered
                ? 'Try fewer words, or remove a filter.'
                : 'Run pnpm db:seed to stock it with example prompts.'}
            </p>
          </div>
        ) : (
          <PromptGrid prompts={list.items} />
        )}

        <Pagination
          page={list.page}
          total={list.total}
          limit={list.limit}
          hrefFor={(page) => libraryHref(query, { page })}
        />
      </section>
    </main>
  );
}
