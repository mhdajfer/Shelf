'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Toaster } from 'sonner';

import type { MeDto } from '@shelf/shared';

import { ApiError } from '@/lib/api-error';
import { SessionProvider } from '@/lib/session';

export function Providers({ me, children }: { me: MeDto; children: ReactNode }) {
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
      <SessionProvider me={me}>{children}</SessionProvider>
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
