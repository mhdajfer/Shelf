import { and, eq, gt, isNull, lt, ne } from 'drizzle-orm';

import type { Executor } from '../client.js';
import { emailTokens, sessions, users } from '../schema/users.js';
import type { UserRecord } from './userRepo.js';

export interface SessionRecord {
  /** SHA-256 of the cookie token. The raw token is never stored. */
  id: string;
  expiresAt: Date;
  user: UserRecord;
}

async function create(
  db: Executor,
  input: { id: string; userId: string; expiresAt: Date },
): Promise<void> {
  await db.insert(sessions).values(input);
}

/** Null for an unknown or expired session; expiry is checked in the query. */
async function findValid(db: Executor, id: string): Promise<SessionRecord | null> {
  const [row] = await db
    .select({
      id: sessions.id,
      expiresAt: sessions.expiresAt,
      userId: users.id,
      email: users.email,
      emailVerifiedAt: users.emailVerifiedAt,
      passwordHash: users.passwordHash,
      name: users.name,
      handle: users.handle,
      role: users.role,
      createdAt: users.createdAt,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, id), gt(sessions.expiresAt, new Date())))
    .limit(1);

  if (row === undefined) return null;
  return {
    id: row.id,
    expiresAt: row.expiresAt,
    user: {
      id: row.userId,
      email: row.email,
      emailVerifiedAt: row.emailVerifiedAt,
      passwordHash: row.passwordHash,
      name: row.name,
      handle: row.handle,
      role: row.role,
      createdAt: row.createdAt,
    },
  };
}

async function extend(db: Executor, id: string, expiresAt: Date): Promise<void> {
  await db.update(sessions).set({ expiresAt }).where(eq(sessions.id, id));
}

async function remove(db: Executor, id: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, id));
}

/** Used after a password change, optionally sparing the session that made it. */
async function removeAllForUser(db: Executor, userId: string, exceptId?: string): Promise<void> {
  await db
    .delete(sessions)
    .where(
      exceptId === undefined
        ? eq(sessions.userId, userId)
        : and(eq(sessions.userId, userId), ne(sessions.id, exceptId)),
    );
}

async function removeExpired(db: Executor): Promise<void> {
  await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
}

type EmailTokenKind = 'verify_email' | 'reset_password';

/**
 * Issuing a token retires the user's earlier unconsumed ones of the same kind,
 * so only the most recent email's link works.
 */
async function issueEmailToken(
  db: Executor,
  input: { userId: string; kind: EmailTokenKind; tokenHash: string; expiresAt: Date },
): Promise<void> {
  await db
    .delete(emailTokens)
    .where(and(eq(emailTokens.userId, input.userId), eq(emailTokens.kind, input.kind)));
  await db.insert(emailTokens).values(input);
}

/**
 * Single statement, so two requests racing on the same link cannot both win.
 * Returns the user the token belonged to, or null if it is unknown, expired, or
 * already used.
 */
async function consumeEmailToken(
  db: Executor,
  tokenHash: string,
  kind: EmailTokenKind,
): Promise<string | null> {
  const [row] = await db
    .update(emailTokens)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(emailTokens.tokenHash, tokenHash),
        eq(emailTokens.kind, kind),
        gt(emailTokens.expiresAt, new Date()),
        isNull(emailTokens.consumedAt),
      ),
    )
    .returning({ userId: emailTokens.userId });
  return row?.userId ?? null;
}

export const sessionRepo = {
  create,
  findValid,
  extend,
  remove,
  removeAllForUser,
  removeExpired,
  issueEmailToken,
  consumeEmailToken,
};
