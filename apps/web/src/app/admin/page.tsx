import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { Moderation } from '@/components/moderation';
import { getMe } from '@/lib/api-server';

export const metadata: Metadata = { title: 'Moderation', robots: { index: false } };

export default async function AdminPage() {
  // Not found, rather than forbidden, for anyone who is not an admin: the same
  // answer the API gives. The API checks the role again on every request.
  const { user } = await getMe();
  if (user?.role !== 'admin') notFound();

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-5 py-8">
      <div className="flex flex-col gap-1">
        <h1 className="font-mono text-2xl tracking-tight">Moderation</h1>
        <p className="max-w-prose text-sm text-text-muted">
          Prompts on the public shelf that readers have reported. Three reports from different
          people hide a prompt until it is reviewed here.
        </p>
      </div>
      <Moderation />
    </main>
  );
}
