import { and, desc, eq, gt, lt, sql } from 'drizzle-orm';

import type { AccessScope, PromptSet } from '@shelf/shared';

import type { Database, Executor } from '../client.js';
import { accessGrants, accessTokens, oauthClients } from '../schema/access.js';
import { collections } from '../schema/collections.js';
import { users } from '../schema/users.js';

/** What a valid credential resolves to. The only thing the MCP endpoint reads. */
export interface ResolvedGrant {
  grantId: string;
  /** A personal access token, or an app the user approved over OAuth. */
  kind: 'token' | 'app';
  userId: string;
  scopes: AccessScope[];
  promptSet: PromptSet;
  collectionId: string | null;
  /** The RFC 8707 audience an OAuth token was issued for; null for a personal token. */
  resource: string | null;
  expiresAt: Date;
}

export interface AccessTokenRecord {
  /** The grant's id; revoking addresses the grant, which takes its token with it. */
  id: string;
  name: string;
  scopes: AccessScope[];
  promptSet: PromptSet;
  collection: { id: string; name: string } | null;
  display: string;
  createdAt: Date;
  expiresAt: Date;
  lastUsedAt: Date | null;
}

/** An app the user approved over OAuth, as Settings lists it. */
export interface ConnectedAppRecord {
  /** The grant's id; revoking addresses it, which takes every token with it. */
  id: string;
  /** The name the client declared when the user approved it. Unverified. */
  name: string;
  clientKind: 'registered' | 'metadata_document';
  /** The client's id: an issued UUID, or the URL of its metadata document. */
  clientId: string;
  scopes: AccessScope[];
  promptSet: PromptSet;
  collection: { id: string; name: string } | null;
  createdAt: Date;
  lastUsedAt: Date | null;
  /** When its newest refresh token lapses, unless the app uses it first. */
  expiresAt: Date;
}

export interface CreateTokenInput {
  userId: string;
  name: string;
  scopes: AccessScope[];
  promptSet: PromptSet;
  collectionId: string | null;
  tokenHash: string;
  display: string;
  expiresAt: Date;
}

/** How stale `last_used_at` may get before a request rewrites it. */
const LAST_USED_GRANULARITY = sql`interval '5 minutes'`;

/** Live personal access tokens, which is what the per-user cap counts. */
async function countTokens(db: Executor, userId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(accessTokens)
    .innerJoin(accessGrants, eq(accessGrants.id, accessTokens.grantId))
    .where(
      and(
        eq(accessGrants.userId, userId),
        eq(accessTokens.kind, 'pat'),
        gt(accessTokens.expiresAt, new Date()),
      ),
    );
  return row?.count ?? 0;
}

/**
 * Creates a personal access token: a grant and its one token, together. Null
 * when the grant names a collection the user does not own, so a token cannot
 * be scoped to, or probe for, someone else's collection.
 */
async function createToken(db: Database, input: CreateTokenInput): Promise<string | null> {
  return db.transaction(async (tx) => {
    if (input.collectionId !== null) {
      const [owned] = await tx
        .select({ id: collections.id })
        .from(collections)
        .where(and(eq(collections.id, input.collectionId), eq(collections.ownerId, input.userId)))
        .limit(1);
      if (owned === undefined) return null;
    }

    const [grant] = await tx
      .insert(accessGrants)
      .values({
        userId: input.userId,
        kind: 'token',
        name: input.name,
        scopes: input.scopes,
        promptSet: input.promptSet,
        collectionId: input.collectionId,
      })
      .returning({ id: accessGrants.id });
    if (grant === undefined) throw new Error('grant insert returned no row');

    await tx.insert(accessTokens).values({
      grantId: grant.id,
      kind: 'pat',
      tokenHash: input.tokenHash,
      display: input.display,
      expiresAt: input.expiresAt,
    });
    return grant.id;
  });
}

/** The user's unexpired personal access tokens, newest first. */
async function listTokens(db: Executor, userId: string): Promise<AccessTokenRecord[]> {
  const rows = await db
    .select({
      id: accessGrants.id,
      name: accessGrants.name,
      scopes: accessGrants.scopes,
      promptSet: accessGrants.promptSet,
      collectionId: collections.id,
      collectionName: collections.name,
      display: accessTokens.display,
      createdAt: accessGrants.createdAt,
      expiresAt: accessTokens.expiresAt,
      lastUsedAt: accessGrants.lastUsedAt,
    })
    .from(accessGrants)
    .innerJoin(accessTokens, eq(accessTokens.grantId, accessGrants.id))
    .leftJoin(collections, eq(collections.id, accessGrants.collectionId))
    .where(
      and(
        eq(accessGrants.userId, userId),
        eq(accessGrants.kind, 'token'),
        eq(accessTokens.kind, 'pat'),
        gt(accessTokens.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(accessGrants.createdAt));

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    scopes: row.scopes as AccessScope[],
    promptSet: row.promptSet,
    collection:
      row.collectionId === null || row.collectionName === null
        ? null
        : { id: row.collectionId, name: row.collectionName },
    display: row.display,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    lastUsedAt: row.lastUsedAt,
  }));
}

/** False when there is no such token, or it is someone else's. */
async function revokeToken(db: Executor, userId: string, grantId: string): Promise<boolean> {
  const rows = await db
    .delete(accessGrants)
    .where(
      and(
        eq(accessGrants.id, grantId),
        eq(accessGrants.userId, userId),
        eq(accessGrants.kind, 'token'),
      ),
    )
    .returning({ id: accessGrants.id });
  return rows.length > 0;
}

/**
 * The grant behind a presented secret, by its hash. Null for an unknown,
 * expired, or consumed token; expiry is checked in the query.
 */
async function resolve(db: Executor, tokenHash: string): Promise<ResolvedGrant | null> {
  const [row] = await db
    .select({
      grantId: accessGrants.id,
      kind: accessGrants.kind,
      userId: accessGrants.userId,
      scopes: accessGrants.scopes,
      promptSet: accessGrants.promptSet,
      collectionId: accessGrants.collectionId,
      resource: accessTokens.resource,
      expiresAt: accessTokens.expiresAt,
    })
    .from(accessTokens)
    .innerJoin(accessGrants, eq(accessGrants.id, accessTokens.grantId))
    .innerJoin(users, eq(users.id, accessGrants.userId))
    .where(
      and(
        eq(accessTokens.tokenHash, tokenHash),
        // Refresh tokens authorise nothing but a token request.
        sql`${accessTokens.kind} IN ('pat', 'access')`,
        gt(accessTokens.expiresAt, new Date()),
        sql`${accessTokens.consumedAt} IS NULL`,
      ),
    )
    .limit(1);

  if (row === undefined) return null;
  return { ...row, scopes: row.scopes as AccessScope[] };
}

/**
 * Records a use. The staleness check is in the statement, so a client making
 * many calls a minute costs one write every few minutes, not one per call.
 */
async function touch(db: Executor, grantId: string): Promise<void> {
  await db
    .update(accessGrants)
    .set({ lastUsedAt: sql`now()` })
    .where(
      and(
        eq(accessGrants.id, grantId),
        sql`(${accessGrants.lastUsedAt} IS NULL OR ${accessGrants.lastUsedAt} < now() - ${LAST_USED_GRANULARITY})`,
      ),
    );
}

/**
 * The apps the user approved that can still act: those holding a refresh token
 * that has not lapsed. Newest approval first.
 */
async function listApps(db: Executor, userId: string): Promise<ConnectedAppRecord[]> {
  const newestRefresh = sql<Date | null>`(
    SELECT max(t.expires_at) FROM access_tokens t
    WHERE t.grant_id = ${accessGrants.id}
      AND t.kind = 'refresh' AND t.consumed_at IS NULL AND t.expires_at > now()
  )`;
  const rows = await db
    .select({
      id: accessGrants.id,
      name: accessGrants.name,
      clientKind: oauthClients.kind,
      clientId: oauthClients.clientId,
      scopes: accessGrants.scopes,
      promptSet: accessGrants.promptSet,
      collectionId: collections.id,
      collectionName: collections.name,
      createdAt: accessGrants.createdAt,
      lastUsedAt: accessGrants.lastUsedAt,
      expiresAt: newestRefresh.mapWith((value: string | Date | null) =>
        value === null ? null : new Date(value),
      ),
    })
    .from(accessGrants)
    .innerJoin(oauthClients, eq(oauthClients.id, accessGrants.clientId))
    .leftJoin(collections, eq(collections.id, accessGrants.collectionId))
    .where(and(eq(accessGrants.userId, userId), eq(accessGrants.kind, 'app')))
    .orderBy(desc(accessGrants.createdAt));

  return rows.flatMap((row) =>
    row.expiresAt === null
      ? []
      : [
          {
            id: row.id,
            name: row.name,
            clientKind: row.clientKind,
            clientId: row.clientId,
            scopes: row.scopes as AccessScope[],
            promptSet: row.promptSet,
            collection:
              row.collectionId === null || row.collectionName === null
                ? null
                : { id: row.collectionId, name: row.collectionName },
            createdAt: row.createdAt,
            lastUsedAt: row.lastUsedAt,
            expiresAt: row.expiresAt,
          },
        ],
  );
}

/** False when there is no such app, or it is someone else's. */
async function revokeApp(db: Executor, userId: string, grantId: string): Promise<boolean> {
  const rows = await db
    .delete(accessGrants)
    .where(
      and(
        eq(accessGrants.id, grantId),
        eq(accessGrants.userId, userId),
        eq(accessGrants.kind, 'app'),
      ),
    )
    .returning({ id: accessGrants.id });
  return rows.length > 0;
}

/** After a possible account compromise: every token and connected app goes. */
async function revokeAllForUser(db: Executor, userId: string): Promise<void> {
  await db.delete(accessGrants).where(eq(accessGrants.userId, userId));
}

/**
 * Deletes expired tokens, then any grant left without a token. A personal
 * access token's grant has exactly one, so it goes with it. An app's grant
 * whose authorization code has not been redeemed yet has no token either, and
 * is kept until the code lapses.
 */
async function removeExpired(db: Executor): Promise<void> {
  await db.delete(accessTokens).where(lt(accessTokens.expiresAt, new Date()));
  await db.delete(accessGrants).where(
    and(
      sql`NOT EXISTS (SELECT 1 FROM access_tokens t WHERE t.grant_id = ${accessGrants.id})`,
      sql`NOT EXISTS (
          SELECT 1 FROM oauth_requests r
          WHERE r.grant_id = ${accessGrants.id} AND r.consumed_at IS NULL AND r.code_expires_at > now()
        )`,
    ),
  );
}

export const accessRepo = {
  countTokens,
  createToken,
  listTokens,
  revokeToken,
  listApps,
  revokeApp,
  resolve,
  touch,
  revokeAllForUser,
  removeExpired,
};
