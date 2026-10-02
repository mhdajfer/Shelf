import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import type { PromptDetailDto } from '@shelf/shared';

import { PromptForm } from '@/components/prompt-form';
import { serverApiOrNull } from '@/lib/api-server';
import { routes } from '@/lib/routes';

export const metadata: Metadata = { title: 'Edit prompt', robots: { index: false } };

export default async function EditPromptPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await serverApiOrNull<{ prompt: PromptDetailDto }>(`/prompts/${id}`);
  // A prompt you cannot edit has no edit page. The API would refuse the save
  // anyway; this just avoids showing a form that cannot succeed.
  if (result === null || !result.prompt.viewer.canEdit) notFound();

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-5 py-8">
      <div className="flex flex-col gap-1">
        <p className="text-sm text-text-subtle">
          <Link href={routes.prompt(id)} className="hover:text-text hover:underline">
            {result.prompt.title}
          </Link>{' '}
          · Version {result.prompt.versionNumber}
        </p>
        <h1 className="font-mono text-2xl tracking-tight">Edit prompt</h1>
      </div>
      <PromptForm prompt={result.prompt} />
    </main>
  );
}
