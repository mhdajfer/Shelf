import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { cache } from 'react';

import type { PromptListDto, PublicProfileDto } from '@shelf/shared';

import { Pagination } from '@/components/library-filters';
import { PromptGrid } from '@/components/prompt-card';
import { serverApi, serverApiOrNull } from '@/lib/api-server';
import { routes } from '@/lib/routes';
import { formatDate, plural } from '@/lib/utils';

type Params = Promise<{ handle: string }>;
type SearchParams = Promise<{ page?: string }>;

const getProfile = cache(async (handle: string): Promise<PublicProfileDto | null> => {
  const result = await serverApiOrNull<{ profile: PublicProfileDto }>(
    `/users/${encodeURIComponent(handle)}`,
  );
  return result?.profile ?? null;
});

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const profile = await getProfile((await params).handle);
  if (profile === null) return { title: 'Not found', robots: { index: false } };
  const name = profile.name ?? profile.handle;
  return {
    title: name,
    description: `Prompts ${name} has published on the public shelf.`,
    alternates: { canonical: routes.profile(profile.handle) },
  };
}

export default async function ProfilePage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SearchParams;
}) {
  const profile = await getProfile((await params).handle);
  if (profile === null) notFound();

  const page = Math.max(1, Number.parseInt((await searchParams).page ?? '1', 10) || 1);
  // The same public listing as the library, narrowed to one author. There is no
  // separate "prompts by user" query that could forget the visibility filter.
  const list = await serverApi<PromptListDto>(
    `/prompts?author=${encodeURIComponent(profile.handle)}&sort=new&page=${String(page)}`,
  );

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-5 py-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{profile.name ?? profile.handle}</h1>
        <p className="text-sm text-text-muted">
          <span className="font-mono">{profile.handle}</span> · Joined{' '}
          {formatDate(profile.joinedAt)} · {plural(profile.publicPromptCount, 'public prompt')}
        </p>
      </header>

      {list.items.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border-strong p-8 text-center text-text-muted">
          Nothing published yet.
        </p>
      ) : (
        <PromptGrid prompts={list.items} />
      )}

      <Pagination
        page={list.page}
        total={list.total}
        limit={list.limit}
        hrefFor={(next) =>
          `${routes.profile(profile.handle)}${next > 1 ? `?page=${String(next)}` : ''}`
        }
      />
    </main>
  );
}
