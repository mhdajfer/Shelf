'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from 'next-themes';
import { useState, type ReactNode } from 'react';
import { Toaster } from 'sonner';

import type { MeDto } from '@shelf/shared';

import { ApiError } from '@/lib/api-error';
import { SessionProvider } from '@/lib/session';

export function Providers({
  me,
  nonce,
  children,
}: {
  me: MeDto;
  nonce: string | undefined;
  children: ReactNode;
}) {
  // One client per browser tab, created lazily so it is never shared between
  // two requests during server rendering.
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            refetchOnWindowFocus: false,
            // Retrying a 4xx only repeats the same answer more slowly.
            retry: (failures, error) =>
              !(error instanceof ApiError && error.status < 500) && failures < 2,
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      {/* Writes the choice to data-theme on <html>, which is what the tokens key
          off. "system" resolves to light or dark, so the attribute is always set. */}
      <ThemeProvider
        attribute="data-theme"
        defaultTheme="system"
        enableSystem
        disableTransitionOnChange
        {...(nonce === undefined ? {} : { nonce })}
      >
        <SessionProvider me={me}>{children}</SessionProvider>
      </ThemeProvider>
      <Toaster
        position="bottom-right"
        toastOptions={{
          classNames: {
            toast:
              'rounded-md! border! border-border! bg-surface-raised! text-text! font-sans! shadow-lg!',
            description: 'text-text-muted!',
          },
        }}
      />
    </QueryClientProvider>
  );
}
