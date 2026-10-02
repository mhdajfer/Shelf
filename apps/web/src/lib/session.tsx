'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, type ReactNode } from 'react';

import type { MeDto, SessionUser } from '@shelf/shared';

import { api } from './api-client';

const ME_KEY = ['me'] as const;

const InitialMe = createContext<MeDto | null>(null);

/** Seeds the session from the server render so the header never flashes signed out. */
export function SessionProvider({ me, children }: { me: MeDto; children: ReactNode }) {
  return <InitialMe.Provider value={me}>{children}</InitialMe.Provider>;
}

export interface Session {
  user: SessionUser | null;
  guest: MeDto['guest'];
  features: MeDto['features'];
  /** Re-reads the session after anything that changes it. */
  refresh: () => Promise<void>;
}

export function useSession(): Session {
  const initial = useContext(InitialMe);
  if (initial === null) throw new Error('useSession must be used inside SessionProvider');

  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: ME_KEY,
    queryFn: () => api<MeDto>('/auth/me'),
    initialData: initial,
    staleTime: 60_000,
  });

  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ME_KEY });
  }, [queryClient]);

  return { user: data.user, guest: data.guest, features: data.features, refresh };
}
