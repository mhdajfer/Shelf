import { cookies } from 'next/headers';

import type { MeDto } from '@shelf/shared';

import { toApiError } from './api-error';

const API_BASE = `${process.env.SHELF_API_ORIGIN ?? 'http://localhost:4000'}/api/v1`;

/**
 * Server-side read from the API, as the visitor: their cookies are forwarded so
 * the API resolves the same actor it would for a browser request. Never cached,
 * because the response depends on who is asking.
 */
export async function serverApi<T>(
  path: string,
  options: { anonymous?: boolean } = {},
): Promise<T> {
  const cookieHeader = options.anonymous === true ? '' : (await cookies()).toString();
  const response = await fetch(`${API_BASE}${path}`, {
    headers: cookieHeader === '' ? {} : { cookie: cookieHeader },
    cache: 'no-store',
  });
  if (!response.ok) throw await toApiError(response);
  return (await response.json()) as T;
}

/** Like serverApi, but a 404 is an answer rather than a failure. */
export async function serverApiOrNull<T>(
  path: string,
  options: { anonymous?: boolean } = {},
): Promise<T | null> {
  try {
    return await serverApi<T>(path, options);
  } catch (error) {
    if ((error as { status?: number }).status === 404) return null;
    throw error;
  }
}

const SIGNED_OUT: MeDto = {
  user: null,
  guest: null,
  csrfToken: '',
  features: { google: false, botCheck: false },
};

/**
 * The session for the page chrome. If the API cannot be reached the chrome
 * renders signed out and the page's own data fetch reports the outage, rather
 * than the layout taking the whole site down.
 */
export async function getMe(): Promise<MeDto> {
  try {
    return await serverApi<MeDto>('/auth/me');
  } catch {
    return SIGNED_OUT;
  }
}
