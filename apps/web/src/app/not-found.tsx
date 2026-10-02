import Link from 'next/link';

import { Button } from '@/components/ui/button';

export default function NotFound() {
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col items-start justify-center gap-4 px-5 py-16">
      <h1 className="font-mono text-2xl tracking-tight">Not on the shelf</h1>
      <p className="max-w-prose text-text-muted">
        This page does not exist, or it is private and you are not signed in as its owner.
      </p>
      <Button asChild variant="primary">
        <Link href="/">Browse the public shelf</Link>
      </Button>
    </main>
  );
}
