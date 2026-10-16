import { and, eq, gt, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';

import type { AccessScope, PromptSet } from '@shelf/shared';

import type { Database, Executor } from '../client.js';
import { accessGrants, accessTokens, oauthClients, oauthRequests } from '../schema/access.js';
import { collections } from '../schema/collections.js';

/**
 * Storage for the OAuth authorization server: clients, the requests users
 * approve, and the tokens those approvals produce. Every lookup by a secret is
 * by its hash, and every one-time value is consumed in a single statement, so
 * two concurrent uses cannot both succeed.
 */

export type OAuthClientKind = 'registered' | 'metadata_document';

export interface OAuthClientRecord {
  /** The row id, which grants and requests reference. */
  id: string;
  /** What the client presents as `client_id`. */
  clientId: string;
  kind: OAuthClientKind;
  name: string;
  redirectUris: string[];
  metadataFetchedAt: Date | null;
  createdAt: Date;
}

export interface CreateRequestInput {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: AccessScope[];
  resource: string;
  state: string | null;
  expiresAt: Date;
}

/** A request awaiting the user's decision, with what the consent page shows. */
export interface PendingRequest {
  id: string;
  client: OAuthClientRecord;
  redirectUri: string;
  scopes: AccessScope[];
  expiresAt: Date;
}

export interface ApproveInput {
  userId: string;
  scopes: AccessScope[];
  promptSet: PromptSet;
  collectionId: string | null;
  codeHash: string;
  codeExpiresAt: Date;
}

/** Where to send the browser after a decision. */
export interface DecidedRequest {
  redirectUri: string;
  state: string | null;
}

/** What a redeemed code carries forward into its tokens. */
export interface RedeemedCode {
  grantId: string;
  familyId: string;
  /** The client row id, to compare with the client redeeming it. */
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  scopes: AccessScope[];
}

export type RedeemResult =
  | { status: 'ok'; code: RedeemedCode }
  /** The code was already used: whatever it produced should be revoked. */
  | { status: 'replayed'; familyId: string }
  | { status: 'invalid' };

export interface IssuedPair {
  grantId: string;
  familyId: string;
  resource: string;
  access: { hash: string; display: string; expiresAt: Date };
  refresh: { hash: string; display: string; expiresAt: Date };
}

/** A refresh token just consumed, and what the replacement pair inherits. */
export interface RotatedRefresh {
  grantId: string;
  familyId: string;
  resource: string;
  /** The client row id the grant belongs to. */
  clientId: string;
  scopes: AccessScope[];
}

export type RotateResult =
  | { status: 'ok'; refresh: RotatedRefresh }
  | { status: 'reused'; familyId: string }
  | { status: 'invalid' };

const clientColumns = {
  id: oauthClients.id,
  clientId: oauthClients.clientId,
  kind: oauthClients.kind,
  name: oauthClients.name,
  redirectUris: oauthClients.redirectUris,
  metadataFetchedAt: oauthClients.metadataFetchedAt,
  createdAt: oauthClients.createdAt,
};

async function findClient(db: Executor, clientId: string): Promise<OAuthClientRecord | null> {
  const [row] = await db
    .select(clientColumns)
    .from(oauthClients)
    .where(eq(oauthClients.clientId, clientId))
    .limit(1);
  return row ?? null;
}

/** RFC 7591 registration. The client id is issued by the caller. */
async function registerClient(
  db: Executor,
  input: { clientId: string; name: string; redirectUris: string[] },
): Promise<OAuthClientRecord> {
  const [row] = await db
    .insert(oauthClients)
    .values({ ...input, kind: 'registered' })
    .returning(clientColumns);
  if (row === undefined) throw new Error('client insert returned no row');
  return row;
}

/**
 * Caches a client metadata document under its URL. A later fetch replaces the
 * name and redirect URIs, so a client that changes its document is followed.
 */
async function saveMetadataClient(
  db: Executor,
  input: { clientId: string; name: string; redirectUris: string[] },
): Promise<OAuthClientRecord> {
  const now = new Date();
  const [row] = await db
    .insert(oauthClients)
    .values({ ...input, kind: 'metadata_document', metadataFetchedAt: now })
    .onConflictDoUpdate({
      target: oauthClients.clientId,
      set: { name: input.name, redirectUris: input.redirectUris, metadataFetchedAt: now },
      // A registered client's id is a UUID and a metadata client's an HTTPS URL,
      // so the two never collide; this keeps it that way if one ever did.
      setWhere: sql`${oauthClients.kind} = 'metadata_document'`,
    })
    .returning(clientColumns);
  if (row === undefined) throw new Error('that client id is already registered');
  return row;
}

async function createRequest(db: Executor, input: CreateRequestInput): Promise<string> {
  const [row] = await db.insert(oauthRequests).values(input).returning({ id: oauthRequests.id });
  if (row === undefined) throw new Error('request insert returned no row');
  return row.id;
}

/** Null once the request is decided or has expired. */
async function findPendingRequest(db: Executor, id: string): Promise<PendingRequest | null> {
  const [row] = await db
    .select({
      id: oauthRequests.id,
      redirectUri: oauthRequests.redirectUri,
      scopes: oauthRequests.scopes,
      expiresAt: oauthRequests.expiresAt,
      client: clientColumns,
    })
    .from(oauthRequests)
    .innerJoin(oauthClients, eq(oauthClients.id, oauthRequests.clientId))
    .where(
      and(
        eq(oauthRequests.id, id),
        isNull(oauthRequests.grantId),
        gt(oauthRequests.expiresAt, new Date()),
      ),
    )
    .limit(1);
  if (row === undefined) return null;
  return { ...row, scopes: row.scopes as AccessScope[] };
}

/** The user's grant for a client, if they approved it before. */
async function findAppGrant(
  db: Executor,
  userId: string,
  clientRowId: string,
): Promise<{
  scopes: AccessScope[];
  promptSet: PromptSet;
  collectionId: string | null;
} | null> {
  const [row] = await db
    .select({
      scopes: accessGrants.scopes,
      promptSet: accessGrants.promptSet,
      collectionId: accessGrants.collectionId,
    })
    .from(accessGrants)
    .where(
      and(
        eq(accessGrants.userId, userId),
        eq(accessGrants.kind, 'app'),
        eq(accessGrants.clientId, clientRowId),
      ),
    )
    .limit(1);
  return row === undefined ? null : { ...row, scopes: row.scopes as AccessScope[] };
}

/**
 * Approves a pending request: creates the user's grant for the client, or
 * updates the one they already have, and attaches a one-time code. Null when
 * the request was already decided, has expired, or names a collection the
 * user does not own.
 */
async function approveRequest(
  db: Database,
  requestId: string,
  input: ApproveInput,
): Promise<DecidedRequest | null> {
  return db.transaction(async (tx) => {
    // Locks the row, so two decisions on one request cannot both proceed.
    const [request] = await tx
      .select({
        clientId: oauthRequests.clientId,
        redirectUri: oauthRequests.redirectUri,
        state: oauthRequests.state,
        clientName: oauthClients.name,
      })
      .from(oauthRequests)
      .innerJoin(oauthClients, eq(oauthClients.id, oauthRequests.clientId))
      .where(
        and(
          eq(oauthRequests.id, requestId),
          isNull(oauthRequests.grantId),
          gt(oauthRequests.expiresAt, new Date()),
        ),
      )
      .for('update', { of: oauthRequests })
      .limit(1);
    if (request === undefined) return null;

    if (input.collectionId !== null) {
      const [owned] = await tx
        .select({ id: collections.id })
        .from(collections)
        .where(and(eq(collections.id, input.collectionId), eq(collections.ownerId, input.userId)))
        .limit(1);
      if (owned === undefined) return null;
    }

    const settings = {
      name: request.clientName,
      scopes: input.scopes,
      promptSet: input.promptSet,
      collectionId: input.collectionId,
    };
    const [grant] = await tx
      .insert(accessGrants)
      .values({ userId: input.userId, kind: 'app', clientId: request.clientId, ...settings })
      .onConflictDoUpdate({
        target: [accessGrants.userId, accessGrants.clientId],
        targetWhere: sql`kind = 'app'`,
        set: settings,
      })
      .returning({ id: accessGrants.id });
    if (grant === undefined) throw new Error('grant upsert returned no row');

    await tx
      .update(oauthRequests)
      .set({
        grantId: grant.id,
        codeHash: input.codeHash,
        codeExpiresAt: input.codeExpiresAt,
        familyId: sql`gen_random_uuid()`,
      })
      .where(eq(oauthRequests.id, requestId));

    return { redirectUri: request.redirectUri, state: request.state };
  });
}

/** Deletes a pending request the user turned down. */
async function denyRequest(db: Executor, requestId: string): Promise<DecidedRequest | null> {
  const [row] = await db
    .delete(oauthRequests)
    .where(
      and(
        eq(oauthRequests.id, requestId),
        isNull(oauthRequests.grantId),
        gt(oauthRequests.expiresAt, new Date()),
      ),
    )
    .returning({ redirectUri: oauthRequests.redirectUri, state: oauthRequests.state });
  return row ?? null;
}

/**
 * Consumes an authorization code in one statement. A code that exists but was
 * already used reports its token family, so the caller can revoke everything
 * the first use produced.
 */
async function redeemCode(db: Executor, codeHash: string): Promise<RedeemResult> {
  const [row] = await db
    .update(oauthRequests)
    .set({ consumedAt: sql`now()` })
    .where(
      and(
        eq(oauthRequests.codeHash, codeHash),
        isNull(oauthRequests.consumedAt),
        gt(oauthRequests.codeExpiresAt, new Date()),
      ),
    )
    .returning({
      grantId: oauthRequests.grantId,
      familyId: oauthRequests.familyId,
      clientId: oauthRequests.clientId,
      redirectUri: oauthRequests.redirectUri,
      codeChallenge: oauthRequests.codeChallenge,
      resource: oauthRequests.resource,
      scopes: oauthRequests.scopes,
    });

  if (row?.grantId != null && row.familyId != null) {
    return {
      status: 'ok',
      code: {
        ...row,
        grantId: row.grantId,
        familyId: row.familyId,
        scopes: row.scopes as AccessScope[],
      },
    };
  }

  const [used] = await db
    .select({ familyId: oauthRequests.familyId })
    .from(oauthRequests)
    .where(and(eq(oauthRequests.codeHash, codeHash), isNotNull(oauthRequests.consumedAt)))
    .limit(1);
  return used?.familyId != null
    ? { status: 'replayed', familyId: used.familyId }
    : { status: 'invalid' };
}

/** The scopes the user approved, read at the moment tokens are issued. */
async function grantScopes(db: Executor, grantId: string): Promise<AccessScope[] | null> {
  const [row] = await db
    .select({ scopes: accessGrants.scopes })
    .from(accessGrants)
    .where(eq(accessGrants.id, grantId))
    .limit(1);
  return row === undefined ? null : (row.scopes as AccessScope[]);
}

async function issueTokens(db: Executor, pair: IssuedPair): Promise<void> {
  const shared = { grantId: pair.grantId, familyId: pair.familyId, resource: pair.resource };
  await db.insert(accessTokens).values([
    {
      ...shared,
      kind: 'access',
      tokenHash: pair.access.hash,
      display: pair.access.display,
      expiresAt: pair.access.expiresAt,
    },
    {
      ...shared,
      kind: 'refresh',
      tokenHash: pair.refresh.hash,
      display: pair.refresh.display,
      expiresAt: pair.refresh.expiresAt,
    },
  ]);
}

/**
 * A refresh token used twice within this long counts as one client refreshing
 * from two requests at once, as clients do when several calls hit an expired
 * access token together, rather than as a copy being replayed.
 */
const CONCURRENT_REFRESH_WINDOW = sql`interval '10 seconds'`;

/**
 * Consumes a refresh token in one statement. One already consumed moments ago
 * is a concurrent refresh by the same client and is honoured again; one
 * consumed earlier than that has been used twice, which means it was copied,
 * and the caller revokes its family.
 */
async function rotateRefresh(db: Executor, refreshHash: string): Promise<RotateResult> {
  const [fresh] = await db
    .update(accessTokens)
    .set({ consumedAt: sql`now()` })
    .where(
      and(
        eq(accessTokens.tokenHash, refreshHash),
        eq(accessTokens.kind, 'refresh'),
        isNull(accessTokens.consumedAt),
        gt(accessTokens.expiresAt, new Date()),
      ),
    )
    .returning({
      grantId: accessTokens.grantId,
      familyId: accessTokens.familyId,
      resource: accessTokens.resource,
    });

  let token = fresh;
  if (token === undefined) {
    const [used] = await db
      .select({
        grantId: accessTokens.grantId,
        familyId: accessTokens.familyId,
        resource: accessTokens.resource,
        concurrent: sql<boolean>`${accessTokens.consumedAt} > now() - ${CONCURRENT_REFRESH_WINDOW}`,
      })
      .from(accessTokens)
      .where(
        and(
          eq(accessTokens.tokenHash, refreshHash),
          eq(accessTokens.kind, 'refresh'),
          isNotNull(accessTokens.consumedAt),
        ),
      )
      .limit(1);
    if (used?.familyId == null) return { status: 'invalid' };
    if (!used.concurrent) return { status: 'reused', familyId: used.familyId };
    token = used;
  }

  const [grant] = await db
    .select({ clientId: accessGrants.clientId, scopes: accessGrants.scopes })
    .from(accessGrants)
    .where(eq(accessGrants.id, token.grantId))
    .limit(1);
  if (grant?.clientId == null || token.familyId === null || token.resource === null) {
    return { status: 'invalid' };
  }
  return {
    status: 'ok',
    refresh: {
      grantId: token.grantId,
      familyId: token.familyId,
      resource: token.resource,
      clientId: grant.clientId,
      scopes: grant.scopes as AccessScope[],
    },
  };
}

/** Every access and refresh token descended from one authorization. */
async function revokeFamily(db: Executor, familyId: string): Promise<void> {
  await db.delete(accessTokens).where(eq(accessTokens.familyId, familyId));
}

/**
 * The family of an OAuth-issued token, if the named client owns it. Personal
 * access tokens are not reachable here: the revocation endpoint is for clients.
 */
async function findFamilyForClient(
  db: Executor,
  tokenHash: string,
  clientRowId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ familyId: accessTokens.familyId })
    .from(accessTokens)
    .innerJoin(accessGrants, eq(accessGrants.id, accessTokens.grantId))
    .where(
      and(
        eq(accessTokens.tokenHash, tokenHash),
        inArray(accessTokens.kind, ['access', 'refresh']),
        eq(accessGrants.clientId, clientRowId),
      ),
    )
    .limit(1);
  return row?.familyId ?? null;
}

const REQUEST_RETENTION = sql`interval '1 day'`;
const UNUSED_CLIENT_RETENTION = sql`interval '30 days'`;

/**
 * Deletes requests a day after they lapsed (long enough that a replayed code
 * is still recognised), and clients nobody approved within 30 days of
 * registering. A client with a grant stays as long as the grant does.
 */
async function removeExpired(db: Executor): Promise<void> {
  await db
    .delete(oauthRequests)
    .where(
      or(
        lt(oauthRequests.expiresAt, sql`now() - ${REQUEST_RETENTION}`),
        lt(oauthRequests.codeExpiresAt, sql`now() - ${REQUEST_RETENTION}`),
      ),
    );
  await db
    .delete(oauthClients)
    .where(
      and(
        lt(oauthClients.createdAt, sql`now() - ${UNUSED_CLIENT_RETENTION}`),
        sql`NOT EXISTS (SELECT 1 FROM access_grants g WHERE g.client_id = ${oauthClients.id})`,
      ),
    );
}

export const oauthRepo = {
  findClient,
  registerClient,
  saveMetadataClient,
  createRequest,
  findPendingRequest,
  findAppGrant,
  approveRequest,
  denyRequest,
  redeemCode,
  grantScopes,
  issueTokens,
  rotateRefresh,
  revokeFamily,
  findFamilyForClient,
  removeExpired,
};
