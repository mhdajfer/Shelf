import { and, eq, sql } from 'drizzle-orm';

import type { UserRole } from '@shelf/shared';

import type { Database, Executor } from '../client.js';
import { oauthAccounts, users } from '../schema/users.js';

export interface UserRecord {
  id: string;
  email: string;
  emailVerifiedAt: Date | null;
  /** Null for accounts that only ever signed in through an OAuth provider. */
  passwordHash: string | null;
  name: string | null;
  handle: string;
  role: UserRole;
  createdAt: Date;
}

const columns = {
  id: users.id,
  email: users.email,
  emailVerifiedAt: users.emailVerifiedAt,
  passwordHash: users.passwordHash,
  name: users.name,
  handle: users.handle,
  role: users.role,
  createdAt: users.createdAt,
};

export const USER_EMAIL_CONSTRAINT = 'users_email_key';
export const USER_HANDLE_CONSTRAINT = 'users_handle_key';

async function findById(db: Executor, id: string): Promise<UserRecord | null> {
  const [row] = await db.select(columns).from(users).where(eq(users.id, id)).limit(1);
  return row ?? null;
}

async function findByEmail(db: Executor, email: string): Promise<UserRecord | null> {
  const [row] = await db
    .select(columns)
    .from(users)
    .where(eq(users.email, email.trim().toLowerCase()))
    .limit(1);
  return row ?? null;
}

async function findByHandle(db: Executor, handle: string): Promise<UserRecord | null> {
  const [row] = await db
    .select(columns)
    .from(users)
    .where(eq(users.handle, handle.toLowerCase()))
    .limit(1);
  return row ?? null;
}

export interface CreateUserInput {
  email: string;
  handle: string;
  name?: string | null;
  passwordHash?: string | null;
  role?: UserRole;
  emailVerified?: boolean;
}

/** Throws a unique violation on a taken email or handle; see `uniqueViolation`. */
async function create(db: Executor, input: CreateUserInput): Promise<UserRecord> {
  const [row] = await db
    .insert(users)
    .values({
      email: input.email.trim().toLowerCase(),
      handle: input.handle.toLowerCase(),
      name: input.name ?? null,
      passwordHash: input.passwordHash ?? null,
      role: input.role ?? 'user',
      emailVerifiedAt: input.emailVerified === true ? new Date() : null,
    })
    .returning(columns);

  if (row === undefined) throw new Error('user insert returned no row');
  return row;
}

/** Null clears the password, leaving an account that can only sign in via OAuth. */
async function setPasswordHash(
  db: Executor,
  id: string,
  passwordHash: string | null,
): Promise<void> {
  await db.update(users).set({ passwordHash }).where(eq(users.id, id));
}

/**
 * Role is granted here rather than at signup: an address on the admin list only
 * earns the role once its owner has proved they control it.
 */
async function markEmailVerified(db: Executor, id: string, role?: UserRole): Promise<void> {
  await db
    .update(users)
    .set({ emailVerifiedAt: new Date(), ...(role === undefined ? {} : { role }) })
    .where(eq(users.id, id));
}

async function updateProfile(
  db: Executor,
  id: string,
  patch: { name?: string | null; handle?: string },
): Promise<UserRecord | null> {
  const values: { name?: string | null; handle?: string } = {};
  if (patch.name !== undefined) values.name = patch.name;
  if (patch.handle !== undefined) values.handle = patch.handle.toLowerCase();
  if (Object.keys(values).length === 0) return findById(db, id);

  const [row] = await db.update(users).set(values).where(eq(users.id, id)).returning(columns);
  return row ?? null;
}

async function findByOAuthAccount(
  db: Executor,
  provider: string,
  providerAccountId: string,
): Promise<UserRecord | null> {
  const [row] = await db
    .select(columns)
    .from(oauthAccounts)
    .innerJoin(users, eq(users.id, oauthAccounts.userId))
    .where(
      and(
        eq(oauthAccounts.provider, provider),
        eq(oauthAccounts.providerAccountId, providerAccountId),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function linkOAuthAccount(
  db: Executor,
  userId: string,
  provider: string,
  providerAccountId: string,
): Promise<void> {
  await db
    .insert(oauthAccounts)
    .values({ userId, provider, providerAccountId })
    .onConflictDoNothing();
}

export interface PublicProfile {
  handle: string;
  name: string | null;
  joinedAt: Date;
  /** Public, active prompts only. A private shelf never shows in this number. */
  publicPromptCount: number;
}

/** What anyone may know about an account. Never the email address. */
async function findPublicProfile(db: Executor, handle: string): Promise<PublicProfile | null> {
  const [row] = await db
    .select({
      handle: users.handle,
      name: users.name,
      joinedAt: users.createdAt,
      publicPromptCount: sql<number>`(
        SELECT count(*)::int FROM prompts p
        WHERE p.owner_id = "users"."id" AND p.visibility = 'public' AND p.status = 'active'
      )`,
    })
    .from(users)
    .where(eq(users.handle, handle.toLowerCase()))
    .limit(1);
  return row ?? null;
}

async function remove(db: Database, id: string): Promise<void> {
  await db.delete(users).where(eq(users.id, id));
}

export const userRepo = {
  findById,
  findByEmail,
  findByHandle,
  findPublicProfile,
  create,
  setPasswordHash,
  markEmailVerified,
  updateProfile,
  findByOAuthAccount,
  linkOAuthAccount,
  remove,
};
