import { Router, type Request, type Response } from 'express';

import {
  sessionRepo,
  uniqueViolation,
  USER_EMAIL_CONSTRAINT,
  USER_HANDLE_CONSTRAINT,
  userRepo,
  type Database,
  type UserRecord,
} from '@shelf/db';
import {
  changePasswordSchema,
  deleteAccountSchema,
  forgotPasswordSchema,
  LIMITS,
  loginSchema,
  resetPasswordSchema,
  signupSchema,
  updateProfileSchema,
  verifyEmailSchema,
  type UserRole,
} from '@shelf/shared';

import {
  cookieOptions,
  OAUTH_STATE_COOKIE,
  OAUTH_VERIFIER_COOKIE,
  readCookie,
} from '../auth/cookies.js';
import { ensureCsrfToken } from '../auth/csrf.js';
import { newOAuthState, type OAuthProvider } from '../auth/google.js';
import {
  endSession,
  guestHandle,
  requireUser,
  startSession,
  toSessionUser,
} from '../auth/identity.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { generateToken, hashToken, safeEqual } from '../auth/tokens.js';
import { env } from '../config/env.js';
import { passwordResetEmail, verificationEmail } from '../email/messages.js';
import type { EmailTransport } from '../email/transport.js';
import { AppError, unauthorized } from '../http/errors.js';
import type { LlmProvider } from '../llm/provider.js';
import { logger } from '../observability/logger.js';
import type { BotCheck } from '../security/botCheck.js';
import type { RateLimits } from '../security/rateLimit.js';

export interface AuthDeps {
  db: Database;
  email: EmailTransport;
  limits: RateLimits;
  botCheck: BotCheck;
  google: OAuthProvider | null;
  llm: LlmProvider;
}

const HOUR_MS = 60 * 60 * 1000;
const VERIFY_TTL_MS = 24 * HOUR_MS;
const RESET_TTL_MS = HOUR_MS;
const OAUTH_COOKIE_TTL_MS = 10 * 60 * 1000;

const clientKey = (req: Request): string => req.ip ?? 'unknown';

/** Admin is configured by address and earned by proving control of it. */
const roleFor = (email: string): UserRole =>
  env.ADMIN_EMAILS.map((entry) => entry.toLowerCase()).includes(email) ? 'admin' : 'user';

function handleSeed(email: string): string {
  const local = email.split('@')[0] ?? '';
  const cleaned = local.replace(/[^a-z0-9_]/g, '').slice(0, LIMITS.handleMax - 5);
  return cleaned.length >= 3 && !cleaned.startsWith('guest') ? cleaned : 'reader';
}

const randomSuffix = (): string => String(Math.floor(1000 + Math.random() * 9000));

/**
 * Inserts with a derived handle and retries with a numeric suffix on a
 * collision. The unique index decides, so two concurrent signups cannot end up
 * sharing a handle.
 */
async function createUserWithHandle(
  db: Database,
  input: { email: string; name?: string | null; passwordHash?: string; emailVerified?: boolean },
): Promise<UserRecord> {
  const seed = handleSeed(input.email);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const handle = attempt === 0 ? seed : `${seed}_${randomSuffix()}`;
    try {
      return await userRepo.create(db, {
        ...input,
        handle,
        role: input.emailVerified === true ? roleFor(input.email) : 'user',
      });
    } catch (error) {
      const constraint = uniqueViolation(error);
      if (constraint === USER_HANDLE_CONSTRAINT) continue;
      if (constraint === USER_EMAIL_CONSTRAINT) {
        throw new AppError('conflict', 'That email is already registered. Sign in instead.', {
          details: [{ field: 'email', message: 'That email is already registered.' }],
        });
      }
      throw error;
    }
  }
  throw new AppError('conflict', 'Could not pick a handle for you. Try again.');
}

export function createAuthRouter(deps: AuthDeps): Router {
  const { db, email, limits, botCheck, google } = deps;
  const router = Router();

  /** A failed send must not fail the request: the user can ask for another link. */
  async function sendVerification(user: UserRecord): Promise<void> {
    const token = generateToken();
    await sessionRepo.issueEmailToken(db, {
      userId: user.id,
      kind: 'verify_email',
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + VERIFY_TTL_MS),
    });
    try {
      await email.send(verificationEmail(user.email, token));
    } catch (error) {
      logger.error({ err: error, userId: user.id }, 'verification email failed to send');
    }
  }

  router.get('/csrf', (req, res) => {
    res.json({ csrfToken: ensureCsrfToken(req, res) });
  });

  /** Everything the web app needs to draw its chrome, in one request. */
  router.get('/me', (req, res) => {
    res.json({
      user: req.user ?? null,
      guest: req.guestId === undefined ? null : { handle: guestHandle(req.guestId) },
      csrfToken: ensureCsrfToken(req, res),
      features: {
        google: google !== null,
        botCheck: botCheck.enabled,
        simulatedModel: deps.llm.name === 'fake',
      },
    });
  });

  router.post('/signup', async (req, res) => {
    const input = signupSchema.parse(req.body);
    await limits.consume('signup', clientKey(req));
    await botCheck.verify(input.turnstileToken, req.ip);

    const user = await createUserWithHandle(db, {
      email: input.email,
      name: input.name === undefined || input.name === '' ? null : input.name,
      passwordHash: await hashPassword(input.password),
    });

    await sendVerification(user);
    await startSession(db, res, user.id);
    res.status(201).json({ user: toSessionUser(user) });
  });

  router.post('/login', async (req, res) => {
    const input = loginSchema.parse(req.body);
    await limits.consume('login', `${clientKey(req)}:${input.email}`);

    const user = await userRepo.findByEmail(db, input.email);
    const ok = await verifyPassword(user?.passwordHash, input.password);
    if (user === null || !ok) {
      // One message for "no such account", "wrong password", and "Google-only
      // account", so the form cannot be used to enumerate addresses.
      throw unauthorized('Email or password is incorrect.');
    }

    await startSession(db, res, user.id);
    res.json({ user: toSessionUser(user) });
  });

  router.post('/logout', async (req, res) => {
    await endSession(db, req, res);
    res.json({ ok: true });
  });

  router.post('/verify-email', async (req, res) => {
    const { token } = verifyEmailSchema.parse(req.body);
    const userId = await sessionRepo.consumeEmailToken(db, hashToken(token), 'verify_email');
    const user = userId === null ? null : await userRepo.findById(db, userId);
    if (user === null) {
      throw new AppError(
        'bad_request',
        'That link has expired or was already used. Ask for a new one from your account.',
      );
    }

    await userRepo.markEmailVerified(db, user.id, roleFor(user.email));
    res.json({ ok: true });
  });

  router.post('/resend-verification', async (req, res) => {
    const sessionUser = requireUser(req);
    await limits.consume('verification', sessionUser.id);

    const user = await userRepo.findById(db, sessionUser.id);
    if (user !== null && user.emailVerifiedAt === null) await sendVerification(user);
    res.json({ ok: true });
  });

  router.post('/forgot-password', async (req, res) => {
    const input = forgotPasswordSchema.parse(req.body);
    await limits.consume('passwordReset', clientKey(req));

    const user = await userRepo.findByEmail(db, input.email);
    if (user !== null) {
      const token = generateToken();
      await sessionRepo.issueEmailToken(db, {
        userId: user.id,
        kind: 'reset_password',
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + RESET_TTL_MS),
      });
      try {
        await email.send(passwordResetEmail(user.email, token));
      } catch (error) {
        logger.error({ err: error, userId: user.id }, 'reset email failed to send');
      }
    }

    // Same answer either way: the form must not confirm an address is registered.
    res.json({ ok: true });
  });

  router.post('/reset-password', async (req, res) => {
    const input = resetPasswordSchema.parse(req.body);
    await limits.consume('passwordReset', clientKey(req));

    const userId = await sessionRepo.consumeEmailToken(
      db,
      hashToken(input.token),
      'reset_password',
    );
    const user = userId === null ? null : await userRepo.findById(db, userId);
    if (user === null) {
      throw new AppError(
        'bad_request',
        'That link has expired or was already used. Request a new reset email.',
      );
    }

    await userRepo.setPasswordHash(db, user.id, await hashPassword(input.password));
    // Whoever knew the old password is signed out everywhere.
    await sessionRepo.removeAllForUser(db, user.id);
    // Following an emailed link proves control of the address.
    if (user.emailVerifiedAt === null) {
      await userRepo.markEmailVerified(db, user.id, roleFor(user.email));
    }
    res.json({ ok: true });
  });

  router.post('/change-password', async (req, res) => {
    const sessionUser = requireUser(req);
    const input = changePasswordSchema.parse(req.body);
    await limits.consume('login', `${clientKey(req)}:${sessionUser.email}`);

    const user = await userRepo.findById(db, sessionUser.id);
    if (user === null) throw unauthorized();

    if (user.passwordHash !== null) {
      const ok = await verifyPassword(user.passwordHash, input.currentPassword ?? '');
      if (!ok) {
        throw new AppError('bad_request', 'Your current password is incorrect.', {
          details: [{ field: 'currentPassword', message: 'That password is incorrect.' }],
        });
      }
    }

    await userRepo.setPasswordHash(db, user.id, await hashPassword(input.newPassword));
    await sessionRepo.removeAllForUser(db, user.id, req.sessionId);
    res.json({ ok: true });
  });

  router.patch('/me', async (req, res) => {
    const sessionUser = requireUser(req);
    const input = updateProfileSchema.parse(req.body);
    await limits.consume('write', sessionUser.id);

    try {
      const updated = await userRepo.updateProfile(db, sessionUser.id, {
        ...(input.name === undefined ? {} : { name: input.name === '' ? null : input.name }),
        ...(input.handle === undefined ? {} : { handle: input.handle }),
      });
      if (updated === null) throw unauthorized();
      res.json({ user: toSessionUser(updated) });
    } catch (error) {
      if (uniqueViolation(error) === USER_HANDLE_CONSTRAINT) {
        throw new AppError('conflict', 'That handle is taken.', {
          details: [{ field: 'handle', message: 'That handle is taken.' }],
        });
      }
      throw error;
    }
  });

  /**
   * Deletes the account and, by cascade, everything it owns: prompts, versions,
   * collections, sessions. Confirmed with the password, or for a Google-only
   * account by typing the handle, so a stolen session alone cannot do it.
   */
  router.post('/delete-account', async (req, res) => {
    const sessionUser = requireUser(req);
    const input = deleteAccountSchema.parse(req.body);
    await limits.consume('login', `${clientKey(req)}:${sessionUser.email}`);

    const user = await userRepo.findById(db, sessionUser.id);
    if (user === null) throw unauthorized();

    const confirmed =
      user.passwordHash !== null
        ? await verifyPassword(user.passwordHash, input.password ?? '')
        : input.confirmHandle?.trim().toLowerCase() === user.handle;
    if (!confirmed) {
      throw new AppError(
        'bad_request',
        user.passwordHash !== null
          ? 'That password is incorrect.'
          : 'Type your handle exactly to confirm.',
        {
          details: [
            {
              field: user.passwordHash !== null ? 'password' : 'confirmHandle',
              message:
                user.passwordHash !== null
                  ? 'That password is incorrect.'
                  : 'That does not match your handle.',
            },
          ],
        },
      );
    }

    await userRepo.remove(db, user.id);
    await endSession(db, req, res);
    res.json({ ok: true });
  });

  router.get('/oauth/google', (_req, res) => {
    if (google === null) {
      throw new AppError('upstream_unavailable', 'Google sign-in is not configured.');
    }
    const { state, codeVerifier } = newOAuthState();
    const options = cookieOptions({ maxAgeMs: OAUTH_COOKIE_TTL_MS });
    res.cookie(OAUTH_STATE_COOKIE, state, options);
    res.cookie(OAUTH_VERIFIER_COOKIE, codeVerifier, options);
    res.redirect(google.createAuthorizationUrl(state, codeVerifier).toString());
  });

  router.get('/oauth/google/callback', async (req, res) => {
    const fail = (reason: string): void => {
      res.redirect(`${env.PUBLIC_WEB_URL}/sign-in?error=${reason}`);
    };
    const finish = (response: Response): void => {
      response.clearCookie(OAUTH_STATE_COOKIE, cookieOptions());
      response.clearCookie(OAUTH_VERIFIER_COOKIE, cookieOptions());
    };

    const storedState = readCookie(req, OAUTH_STATE_COOKIE);
    const codeVerifier = readCookie(req, OAUTH_VERIFIER_COOKIE);
    const { code, state } = req.query;
    finish(res);

    if (
      google === null ||
      typeof code !== 'string' ||
      typeof state !== 'string' ||
      storedState === undefined ||
      codeVerifier === undefined ||
      !safeEqual(state, storedState)
    ) {
      fail('oauth');
      return;
    }

    let profile;
    try {
      profile = await google.exchange(code, codeVerifier);
    } catch (error) {
      logger.warn({ err: error }, 'google code exchange failed');
      fail('oauth');
      return;
    }

    // An unverified Google address must not be allowed to claim a Shelf account.
    if (!profile.emailVerified) {
      fail('oauth_unverified');
      return;
    }

    let user = await userRepo.findByOAuthAccount(db, 'google', profile.subject);
    if (user === null) {
      const existing = await userRepo.findByEmail(db, profile.email);
      if (existing !== null) {
        if (existing.emailVerifiedAt === null) {
          // Someone registered this address without proving they own it. The
          // Google sign-in is the proof, so that password and its sessions go.
          await userRepo.setPasswordHash(db, existing.id, null);
          await sessionRepo.removeAllForUser(db, existing.id);
          await userRepo.markEmailVerified(db, existing.id, roleFor(existing.email));
        }
        user = existing;
      } else {
        user = await createUserWithHandle(db, {
          email: profile.email,
          name: profile.name,
          emailVerified: true,
        });
      }
      await userRepo.linkOAuthAccount(db, user.id, 'google', profile.subject);
    }

    await startSession(db, res, user.id);
    res.redirect(`${env.PUBLIC_WEB_URL}/shelf`);
  });

  return router;
}
