import { brand } from '@shelf/config';

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center gap-6 px-5 py-16">
      <div>
        <h1 className="font-mono text-2xl tracking-tight">{brand.name}</h1>
        <p className="mt-2 text-text-muted">{brand.tagline}</p>
      </div>

      <p className="max-w-prose">{brand.description}</p>

      <pre className="overflow-x-auto rounded-md border border-border bg-surface-sunken p-4 font-mono text-sm">
        {'Summarize {{source}} for a {{audience:general}} reader.'}
      </pre>

      <p className="text-sm text-text-subtle">
        The public library and the editor are not wired up yet. This page exists so the theme,
        fonts, and build pipeline are verifiable.
      </p>
    </main>
  );
}
