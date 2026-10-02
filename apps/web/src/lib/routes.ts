/** Every internal URL is built here, so a route can move without a search-and-replace. */
export const routes = {
  home: '/',
  prompt: (id: string) => `/p/${id}`,
  profile: (handle: string) => `/u/${handle}`,
  signIn: (next?: string) =>
    next === undefined ? '/sign-in' : `/sign-in?next=${encodeURIComponent(next)}`,
  signUp: '/sign-up',
  forgotPassword: '/forgot-password',
} as const;

/** Where a visitor lands after signing in, unless they were on their way somewhere. */
export const AFTER_SIGN_IN = '/';

/**
 * Only same-site paths are honoured as a post-sign-in destination; anything
 * else would make the sign-in page an open redirect.
 */
export function safeNext(next: string | null | undefined): string {
  if (next == null || !next.startsWith('/') || next.startsWith('//') || next.includes('\\')) {
    return AFTER_SIGN_IN;
  }
  return next;
}
