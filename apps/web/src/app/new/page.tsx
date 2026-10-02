import type { Metadata } from 'next';

import { PromptForm } from '@/components/prompt-form';

export const metadata: Metadata = { title: 'New prompt', robots: { index: false } };

export default function NewPromptPage() {
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-5 py-8">
      <h1 className="font-mono text-2xl tracking-tight">New prompt</h1>
      <PromptForm />
    </main>
  );
}
