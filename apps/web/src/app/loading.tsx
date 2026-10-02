export default function Loading() {
  return (
    <main
      aria-busy
      className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-5 py-8 motion-safe:animate-pulse"
    >
      <span className="sr-only">Loading</span>
      <div className="h-8 w-56 rounded-md bg-surface-sunken" />
      <div className="h-4 w-96 max-w-full rounded-md bg-surface-sunken" />
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        {[0, 1, 2, 3].map((item) => (
          <div key={item} className="h-48 rounded-lg border border-border bg-surface-raised" />
        ))}
      </div>
    </main>
  );
}
