'use client';

import { useEffect } from 'react';

import { Button } from '@/components/ui/button';

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col items-start justify-center gap-4 px-5 py-16">
      <h1 className="font-mono text-2xl tracking-tight">Shelf could not load this page</h1>
      <p className="max-w-prose text-text-muted">
        The service did not respond. If it has been idle it may be waking up, which takes a few
        seconds.
      </p>
      <Button variant="primary" onClick={reset}>
        Try again
      </Button>
    </main>
  );
}
