import type { NextFunction, Request, Response } from 'express';

import { env } from '../config/env.js';
import { AppError } from '../http/errors.js';
import { cookieOptions, CSRF_COOKIE, readCookie } from './cookies.js';
import { generateToken, safeEqual, signValue, unsignValue } from './tokens.js';

export const CSRF_HEADER = 'x-csrf-token';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Double-submit token. The cookie is signed so that a sibling subdomain able to
 * set cookies on the parent domain still cannot mint a pair that validates.
 */
export function ensureCsrfToken(req: Request, res: Response): string {
  const existing = readCookie(req, CSRF_COOKIE);
  if (existing !== undefined && unsignValue(existing, env.SESSION_SECRET) !== null) {
    return existing;
  }
  const token = signValue(generateToken(18), env.SESSION_SECRET);
  // Readable by script on purpose: the page echoes it back in a header.
  res.cookie(CSRF_COOKIE, token, cookieOptions({ httpOnly: false, maxAgeMs: YEAR_MS }));
  return token;
}

/** Paths that authenticate with a bearer secret instead of a browser session. */
const EXEMPT = /\/cron\//;

export function csrfProtection(req: Request, _res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method) || EXEMPT.test(req.path)) {
    next();
    return;
  }

  const cookie = readCookie(req, CSRF_COOKIE);
  const header = req.get(CSRF_HEADER);
  const valid =
    cookie !== undefined &&
    header !== undefined &&
    safeEqual(cookie, header) &&
    unsignValue(cookie, env.SESSION_SECRET) !== null;

  if (!valid) {
    next(new AppError('forbidden', 'Your session expired. Refresh the page and try again.'));
    return;
  }
  next();
}
