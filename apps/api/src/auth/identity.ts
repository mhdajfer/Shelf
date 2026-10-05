import { randomUUID } from 'node:crypto';

import type { NextFunction, Request, Response } from 'express';

import {
  ANONYMOUS,
  guestActor,
  sessionRepo,
  userActor,
  type Database,
  type UserRecord,
} from '@shelf/db';
import type { SessionUser } from '@shelf/shared';

import { env } from '../config/env.js';
import { AppError, unauthorized } from '../http/errors.js';
import { cookieOptions, GUEST_COOKIE, readCookie, SESSION_COOKIE } from './cookies.js';
import { generateToken, hashToken, hmac, signValue, unsignValue } from './tokens.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const sessionTtlMs = (): number => env.SESSION_TTL_DAYS * DAY_MS;
const GUEST_TTL_MS = 365 * DAY_MS;

export function toSessionUser(user: UserRecord): SessionUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    handle: user.handle,
    role: user.role,
    emailVerified: user.emailVerifiedAt !== null,
    hasPassword: user.passwordHash !== null,
  };
}

/** A fresh token on every sign-in, so a planted cookie cannot be promoted. */
export async function startSession(db: Database, res: Response, userId: string): Promise<void> {
  const token = generateToken();
  await sessionRepo.create(db, {
    id: hashToken(token),
    userId,
    expiresAt: new Date(Date.now() + sessionTtlMs()),
  });
  res.cookie(SESSION_COOKIE, token, cookieOptions({ maxAgeMs: sessionTtlMs() }));
}

export async function endSession(db: Database, req: Request, res: Response): Promise<void> {
  if (req.sessionId !== undefined) await sessionRepo.remove(db, req.sessionId);
  res.clearCookie(SESSION_COOKIE, cookieOptions());
}

/**
 * Resolves who is asking, once, before any route runs. A route reads
 * `req.actor` and hands it to a repository; it never inspects cookies itself.
 */
export function identity(db: Database) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    req.actor = ANONYMOUS;

    const token = readCookie(req, SESSION_COOKIE);
    if (token !== undefined) {
      const sessionId = hashToken(token);
      const session = await sessionRepo.findValid(db, sessionId);
      if (session !== null) {
        req.user = toSessionUser(session.user);
        req.sessionId = sessionId;
        req.actor = userActor(session.user.id, session.user.role);

        // Sliding expiry, written at most once per half-lifetime.
        if (session.expiresAt.getTime() - Date.now() < sessionTtlMs() / 2) {
          await sessionRepo.extend(db, sessionId, new Date(Date.now() + sessionTtlMs()));
          res.cookie(SESSION_COOKIE, token, cookieOptions({ maxAgeMs: sessionTtlMs() }));
        }
        next();
        return;
      }
      res.clearCookie(SESSION_COOKIE, cookieOptions());
    }

    const guestCookie = readCookie(req, GUEST_COOKIE);
    const guestId = guestCookie === undefined ? null : unsignValue(guestCookie, env.GUEST_SECRET);
    if (guestId !== null) {
      req.guestId = guestId;
      req.actor = guestActor(guestId);
    }
    next();
  };
}

export function requireUser(req: Request): SessionUser {
  if (req.user === undefined) throw unauthorized();
  return req.user;
}

export function requireAdmin(req: Request): SessionUser {
  const user = requireUser(req);
  // 404 rather than 403: the admin surface does not announce itself.
  if (user.role !== 'admin') throw new AppError('not_found', 'Not found.');
  return user;
}

/**
 * Guests get an identity the first time they do something that needs one, not
 * on first page view, so a read-only visitor is never issued a cookie.
 */
export function ensureGuestId(req: Request, res: Response): string {
  if (req.guestId !== undefined) return req.guestId;
  const guestId = randomUUID();
  res.cookie(
    GUEST_COOKIE,
    signValue(guestId, env.GUEST_SECRET),
    cookieOptions({ maxAgeMs: GUEST_TTL_MS }),
  );
  req.guestId = guestId;
  req.actor = guestActor(guestId);
  return guestId;
}

export const guestHandle = (guestId: string): string =>
  `guest-${guestId.replace(/-/g, '').slice(0, 4)}`;

/** Addresses are never stored; the ledger keys a guest's second allowance on this. */
export const hashIp = (ip: string | undefined): string =>
  hmac(ip ?? 'unknown', env.GUEST_SECRET).slice(0, 32);
