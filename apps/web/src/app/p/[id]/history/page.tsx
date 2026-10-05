import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import type { PromptDetailDto, PromptVersionDto } from '@shelf/shared';

import { VersionHistory } from '@/components/version-history';
import { serverApiOrNull } from '@/lib/api-server';
import { routes } from '@/lib/routes';
import { plural } from '@/lib/utils';

export const metadata: Metadata = { title: 'History', robots: { index: false } };

export default async function HistoryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [detail, history] = await Promise.all([
    serverApiOrNull<{ prompt: PromptDetailDto }>(`/prompts/${id}`),
    serverApiOrNull<{ versions: PromptVersionDto[] }>(`/prompts/${id}/versions`),
  ]);
  if (detail === null || history === null) notFound();

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-5 py-8">
      <div className="flex flex-col gap-1">
        <p className="text-sm text-text-subtle">
          <Link href={routes.prompt(id)} className="hover:text-text hover:underline">
            {detail.prompt.title}
          </Link>
        </p>
        <h1 className="font-mono text-2xl tracking-tight">History</h1>
        <p className="text-sm text-text-muted">
          {plural(history.versions.length, 'version')}. Every save that changes the prompt is kept.
        </p>
      </div>
      {/* Keyed on the newest version, so a restore resets the selection to it. */}
      <VersionHistory
        key={history.versions[0]?.id}
        promptId={id}
        versions={history.versions}
        canRestore={detail.prompt.viewer.canEdit}
      />
    </main>
  );
}
