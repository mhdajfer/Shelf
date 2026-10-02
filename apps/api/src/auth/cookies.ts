import type { CookieOptions, Request } from 'express';

import { env, isProduction } from '../config/env.js';

export const SESSION_COOKIE = 'shelf_session';
export const GUEST_COOKIE = 'shelf_guest';
export const CSRF_COOKIE = 'shelf_csrf';
export const OAUTH_STATE_COOKIE = 'shelf_oauth_state';
export const OAUTH_VERIFIER_COOKIE = 'shelf_oauth_verifier';

/**
 * One place decides cookie scope. In production COOKIE_DOMAIN is the parent
 * domain so the web and api subdomains share the cookie; in development it is
 * unset and the cookie stays host-only.
 */
export function cookieOptions(
  options: { maxAgeMs?: number; httpOnly?: boolean } = {},
): CookieOptions {
  return {
    httpOnly: options.httpOnly ?? true,
    secure: isProduction,
    sameSite: 'lax',
    path: '/',
    ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
    ...(options.maxAgeMs === undefined ? {} : { maxAge: options.maxAgeMs }),
  };
}

export function readCookie(req: Request, name: string): string | undefined {
  const jar = req.cookies as Record<string, unknown> | undefined;
  const value = jar?.[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
