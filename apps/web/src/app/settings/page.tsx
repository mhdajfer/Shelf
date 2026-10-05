import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { Settings } from '@/components/settings';
import { getMe } from '@/lib/api-server';
import { routes } from '@/lib/routes';

export const metadata: Metadata = { title: 'Settings', robots: { index: false } };

export default async function SettingsPage() {
  const { user } = await getMe();
  if (user === null) redirect(routes.signIn(routes.settings));

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-5 py-8">
      <h1 className="font-mono text-2xl tracking-tight">Settings</h1>
      <Settings />
    </main>
  );
}
