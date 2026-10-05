'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import type { CreditsDto } from '@shelf/shared';

import { api } from './api-client';

const CREDITS_KEY = ['credits'] as const;

/**
 * Today's allowance. Model calls answer with the new balance, which is written
 * straight into the cache, so the count on screen never waits for a refetch.
 */
export function useCredits() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: CREDITS_KEY,
    queryFn: () => api<{ credits: CreditsDto }>('/credits'),
  });

  const setCredits = useCallback(
    (credits: CreditsDto) => {
      queryClient.setQueryData(CREDITS_KEY, { credits });
    },
    [queryClient],
  );

  return { credits: query.data?.credits ?? null, setCredits };
}

/** "3 of 5 test runs left today", or nothing until the balance is known. */
export function modelAllowance(credits: CreditsDto | null): string | null {
  if (credits === null) return null;
  const { remaining, limit } = credits.model;
  return `${String(remaining)} of ${String(limit)} test runs left today`;
}
