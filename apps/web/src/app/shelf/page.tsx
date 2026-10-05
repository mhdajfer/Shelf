import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Suspense } from 'react';

import { Shelf } from '@/components/shelf';
import { getMe } from '@/lib/api-server';
import { routes } from '@/lib/routes';

export const metadata: Metadata = { title: 'Your shelf', robots: { index: false } };

export default async function ShelfPage() {
  // The API refuses every shelf request without a session regardless; this
  // sends a signed-out visitor to sign in instead of to an empty page.
  const { user } = await getMe();
  if (user === null) redirect(routes.signIn(routes.shelf));

  return (
    <main className="mx-auto w-full max-w-5xl px-5 py-8">
      <Suspense>
        <Shelf />
      </Suspense>
    </main>
  );
}
