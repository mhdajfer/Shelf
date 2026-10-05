import { ApiError, toApiError } from './api-error';

export const API_BASE = `${process.env.NEXT_PUBLIC_API_ORIGIN ?? ''}/api/v1`;

const CSRF_COOKIE = 'shelf_csrf';
const SAFE_METHODS = new Set(['GET', 'HEAD']);

function csrfFromCookie(): string | null {
  const match = document.cookie.split('; ').find((entry) => entry.startsWith(`${CSRF_COOKIE}=`));
  return match === undefined ? null : decodeURIComponent(match.slice(CSRF_COOKIE.length + 1));
}

let csrfRequest: Promise<string> | null = null;

/**
 * The token for the double-submit check. Read from the cookie when the browser
 * has one, otherwise fetched once; concurrent callers share the same request.
 */
export async function csrfToken(forceRefresh = false): Promise<string> {
  if (!forceRefresh) {
    const fromCookie = csrfFromCookie();
    if (fromCookie !== null) return fromCookie;
  }
  csrfRequest ??= fetch(`${API_BASE}/auth/csrf`, { credentials: 'include' })
    .then(async (response) => {
      if (!response.ok) throw await toApiError(response);
      return ((await response.json()) as { csrfToken: string }).csrfToken;
    })
    .finally(() => {
      csrfRequest = null;
    });
  return csrfRequest;
}

export interface ApiOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
}

async function send(path: string, options: ApiOptions, token: string | null): Promise<Response> {
  return fetch(`${API_BASE}${path}`, {
    method: options.method ?? 'GET',
    credentials: 'include',
    headers: {
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token === null ? {} : { 'x-csrf-token': token }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}

/** Browser-side request. Throws ApiError with the API's own message on failure. */
export async function api<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const needsToken = !SAFE_METHODS.has(options.method ?? 'GET');
  let response = await send(path, options, needsToken ? await csrfToken() : null);

  // The token cookie can expire or be cleared under a long-open tab. One retry
  // with a fresh token turns that into a non-event.
  if (needsToken && response.status === 403) {
    const error = await toApiError(response.clone());
    if (error.message.includes('session expired')) {
      response = await send(path, options, await csrfToken(true));
    }
  }

  if (!response.ok) throw await toApiError(response);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export { ApiError };
