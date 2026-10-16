import { randomUUID } from 'node:crypto';

import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { AccessScope } from '@shelf/shared';

import type { Database } from './client.js';
import { accessRepo } from './repositories/accessRepo.js';
import { collectionRepo } from './repositories/collectionRepo.js';
import { oauthRepo, type OAuthClientRecord } from './repositories/oauthRepo.js';
import { accessGrants, accessTokens, oauthClients, oauthRequests } from './schema/access.js';
import { captureDatabaseError, SQLSTATE } from './testing/errors.js';
import { makeUser } from './testing/fixtures.js';
import { createTestDatabase, type TestDatabase } from './testing/harness.js';

let harness: TestDatabase;
let db: Database;
let userId: string;
let client: OAuthClientRecord;

const RESOURCE = 'https://shelf.example/mcp';
const HOUR_MS = 60 * 60 * 1000;

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
}, 60_000);

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  await harness.truncate();
  userId = (await makeUser(db)).id;
  client = await oauthRepo.registerClient(db, {
    clientId: randomUUID(),
    name: 'Claude Code',
    redirectUris: ['http://127.0.0.1/callback'],
  });
});

async function pendingRequest(
  overrides: Partial<{ expiresAt: Date; scopes: AccessScope[]; clientId: string }> = {},
): Promise<string> {
  return oauthRepo.createRequest(db, {
    clientId: client.id,
    redirectUri: 'http://127.0.0.1:5555/callback',
    codeChallenge: 'challenge',
    scopes: ['prompts:read', 'prompts:write'],
    resource: RESOURCE,
    state: 'xyz',
    expiresAt: new Date(Date.now() + 10 * 60_000),
    ...overrides,
  });
}

function approve(
  requestId: string,
  overrides: Partial<Parameters<typeof oauthRepo.approveRequest>[2]> = {},
) {
  return oauthRepo.approveRequest(db, requestId, {
    userId,
    scopes: ['prompts:read'],
    promptSet: 'all',
    collectionId: null,
    codeHash: `code-${randomUUID()}`,
    codeExpiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  });
}

/** Approves a request and redeems its code, as a client finishing the flow would. */
async function connectedApp(): Promise<{ grantId: string; familyId: string }> {
  const codeHash = `code-${randomUUID()}`;
  await approve(await pendingRequest(), { codeHash });
  const redeemed = await oauthRepo.redeemCode(db, codeHash);
  if (redeemed.status !== 'ok') throw new Error('code did not redeem');
  const { grantId, familyId } = redeemed.code;
  await oauthRepo.issueTokens(db, {
    grantId,
    familyId,
    resource: RESOURCE,
    access: {
      hash: `at-${familyId}`,
      display: 'shelf_at_x…',
      expiresAt: new Date(Date.now() + HOUR_MS),
    },
    refresh: {
      hash: `rt-${familyId}`,
      display: 'shelf_rt_x…',
      expiresAt: new Date(Date.now() + 30 * 24 * HOUR_MS),
    },
  });
  return { grantId, familyId };
}

describe('clients', () => {
  it('are found by the id they present', async () => {
    expect(await oauthRepo.findClient(db, client.clientId)).toMatchObject({
      id: client.id,
      kind: 'registered',
      name: 'Claude Code',
    });
    expect(await oauthRepo.findClient(db, 'nobody')).toBeNull();
  });

  it('cache a metadata document, and follow it when it changes', async () => {
    const url = 'https://client.example/oauth/metadata.json';
    const first = await oauthRepo.saveMetadataClient(db, {
      clientId: url,
      name: 'First',
      redirectUris: ['http://127.0.0.1/cb'],
    });
    const second = await oauthRepo.saveMetadataClient(db, {
      clientId: url,
      name: 'Second',
      redirectUris: ['http://localhost/cb'],
    });
    expect(second.id).toBe(first.id);
    expect(second).toMatchObject({ kind: 'metadata_document', name: 'Second' });
    expect(second.redirectUris).toEqual(['http://localhost/cb']);
  });

  it('never let a metadata document take over a registered client', async () => {
    await expect(
      oauthRepo.saveMetadataClient(db, {
        clientId: client.clientId,
        name: 'Impostor',
        redirectUris: ['https://evil.example/cb'],
      }),
    ).rejects.toThrow();
    expect((await oauthRepo.findClient(db, client.clientId))?.name).toBe('Claude Code');
  });

  it('need between one and ten redirect URIs', async () => {
    for (const redirectUris of [
      [],
      Array.from({ length: 11 }, (_, i) => `https://a.example/${String(i)}`),
    ]) {
      const error = await captureDatabaseError(() =>
        oauthRepo.registerClient(db, { clientId: randomUUID(), name: 'x', redirectUris }),
      );
      expect(error.constraint).toBe('oauth_clients_redirect_uris_check');
    }
  });
});

describe('authorization requests', () => {
  it('are pending until decided, and shown with their client', async () => {
    const id = await pendingRequest();
    const pending = await oauthRepo.findPendingRequest(db, id);
    expect(pending).toMatchObject({ id, scopes: ['prompts:read', 'prompts:write'] });
    expect(pending?.client.name).toBe('Claude Code');

    expect(await approve(id)).toEqual({
      redirectUri: 'http://127.0.0.1:5555/callback',
      state: 'xyz',
    });
    expect(await oauthRepo.findPendingRequest(db, id)).toBeNull();
  });

  it('can be decided once only', async () => {
    const id = await pendingRequest();
    expect(await approve(id)).not.toBeNull();
    expect(await approve(id)).toBeNull();
    expect(await oauthRepo.denyRequest(db, id)).toBeNull();
  });

  it('lapse unanswered', async () => {
    const id = await pendingRequest({ expiresAt: new Date(Date.now() - 1000) });
    expect(await oauthRepo.findPendingRequest(db, id)).toBeNull();
    expect(await approve(id)).toBeNull();
    expect(await oauthRepo.denyRequest(db, id)).toBeNull();
  });

  it('are deleted when denied', async () => {
    const id = await pendingRequest();
    expect(await oauthRepo.denyRequest(db, id)).toEqual({
      redirectUri: 'http://127.0.0.1:5555/callback',
      state: 'xyz',
    });
    expect(await db.$count(oauthRequests)).toBe(0);
    expect(await db.$count(accessGrants)).toBe(0);
  });

  it('cannot be limited to someone else’s collection', async () => {
    const other = await makeUser(db);
    const theirs = await collectionRepo.createCollection(db, other.id, 'Theirs');
    const id = await pendingRequest();
    expect(await approve(id, { promptSet: 'collection', collectionId: theirs })).toBeNull();
    expect(await db.$count(accessGrants)).toBe(0);
    expect(await oauthRepo.findPendingRequest(db, id)).not.toBeNull();
  });

  it('update the user’s grant for a client instead of adding another', async () => {
    await approve(await pendingRequest(), { scopes: ['prompts:read'] });
    await approve(await pendingRequest(), {
      scopes: ['prompts:read', 'prompts:write'],
      promptSet: 'pinned',
    });

    const grants = await db.select().from(accessGrants);
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({
      kind: 'app',
      clientId: client.id,
      name: 'Claude Code',
      scopes: ['prompts:read', 'prompts:write'],
      promptSet: 'pinned',
    });
    expect(await oauthRepo.findAppGrant(db, userId, client.id)).toMatchObject({
      promptSet: 'pinned',
    });
  });
});

describe('authorization codes', () => {
  it('redeem once, carrying the request forward', async () => {
    await approve(await pendingRequest(), { codeHash: 'c1' });
    const first = await oauthRepo.redeemCode(db, 'c1');
    expect(first).toMatchObject({
      status: 'ok',
      code: {
        clientId: client.id,
        redirectUri: 'http://127.0.0.1:5555/callback',
        codeChallenge: 'challenge',
        resource: RESOURCE,
      },
    });
  });

  it('report a second use with the family to revoke', async () => {
    await approve(await pendingRequest(), { codeHash: 'c2' });
    const first = await oauthRepo.redeemCode(db, 'c2');
    const second = await oauthRepo.redeemCode(db, 'c2');
    expect(second).toEqual({
      status: 'replayed',
      familyId: first.status === 'ok' ? first.code.familyId : 'missing',
    });
  });

  it('do not redeem once lapsed, or if never issued', async () => {
    await approve(await pendingRequest(), {
      codeHash: 'old',
      codeExpiresAt: new Date(Date.now() - 1000),
    });
    expect(await oauthRepo.redeemCode(db, 'old')).toEqual({ status: 'invalid' });
    expect(await oauthRepo.redeemCode(db, 'never')).toEqual({ status: 'invalid' });
  });

  it('are stored only with their grant, expiry, and family', async () => {
    const id = await pendingRequest();
    const error = await captureDatabaseError(() =>
      db.update(oauthRequests).set({ codeHash: 'orphan' }).where(eq(oauthRequests.id, id)),
    );
    expect(error.constraint).toBe('oauth_requests_code_check');
  });
});

describe('issued tokens', () => {
  it('resolve as an app grant bound to their resource', async () => {
    const { grantId, familyId } = await connectedApp();
    expect(await accessRepo.resolve(db, `at-${familyId}`)).toMatchObject({
      grantId,
      kind: 'app',
      userId,
      resource: RESOURCE,
    });
  });

  it('never resolve a refresh token as a credential', async () => {
    const { familyId } = await connectedApp();
    expect(await accessRepo.resolve(db, `rt-${familyId}`)).toBeNull();
  });

  it('rotate: a refresh token works once, and later reuse names its family', async () => {
    const { grantId, familyId } = await connectedApp();
    expect(await oauthRepo.rotateRefresh(db, `rt-${familyId}`)).toEqual({
      status: 'ok',
      refresh: {
        grantId,
        familyId,
        resource: RESOURCE,
        clientId: client.id,
        scopes: ['prompts:read'],
      },
    });
    await db
      .update(accessTokens)
      .set({ consumedAt: sql`now() - interval '11 seconds'` })
      .where(eq(accessTokens.tokenHash, `rt-${familyId}`));
    expect(await oauthRepo.rotateRefresh(db, `rt-${familyId}`)).toEqual({
      status: 'reused',
      familyId,
    });
    expect(await oauthRepo.rotateRefresh(db, 'unknown')).toEqual({ status: 'invalid' });
  });

  it('honour a second use within moments, as one client refreshing twice at once', async () => {
    const { familyId } = await connectedApp();
    const [first, second] = await Promise.all([
      oauthRepo.rotateRefresh(db, `rt-${familyId}`),
      oauthRepo.rotateRefresh(db, `rt-${familyId}`),
    ]);
    expect(first.status).toBe('ok');
    expect(second.status).toBe('ok');
  });

  it('do not honour a concurrent use once the family is revoked', async () => {
    const { familyId } = await connectedApp();
    await oauthRepo.rotateRefresh(db, `rt-${familyId}`);
    await oauthRepo.revokeFamily(db, familyId);
    expect(await oauthRepo.rotateRefresh(db, `rt-${familyId}`)).toEqual({ status: 'invalid' });
  });

  it('are revoked as a family', async () => {
    const { familyId } = await connectedApp();
    const other = await connectedApp();
    await oauthRepo.revokeFamily(db, familyId);
    expect(await accessRepo.resolve(db, `at-${familyId}`)).toBeNull();
    expect(await accessRepo.resolve(db, `at-${other.familyId}`)).not.toBeNull();
  });

  it('are found for revocation only by the client they were issued to', async () => {
    const { familyId } = await connectedApp();
    const stranger = await oauthRepo.registerClient(db, {
      clientId: randomUUID(),
      name: 'Other',
      redirectUris: ['https://other.example/cb'],
    });
    expect(await oauthRepo.findFamilyForClient(db, `rt-${familyId}`, client.id)).toBe(familyId);
    expect(await oauthRepo.findFamilyForClient(db, `rt-${familyId}`, stranger.id)).toBeNull();
  });

  it('never share a hash with any other token', async () => {
    const { grantId, familyId } = await connectedApp();
    const error = await captureDatabaseError(() =>
      db.insert(accessTokens).values({
        grantId,
        kind: 'access',
        tokenHash: `at-${familyId}`,
        display: 'x',
        expiresAt: new Date(Date.now() + HOUR_MS),
      }),
    );
    expect(error.code).toBe(SQLSTATE.uniqueViolation);
  });
});

describe('connected apps', () => {
  it('are listed while they hold a live refresh token', async () => {
    const { grantId } = await connectedApp();
    // Approved but never redeemed: nothing can act on it, so it is not listed.
    await approve(await pendingRequest());

    const apps = await accessRepo.listApps(db, userId);
    expect(apps.map((app) => app.id)).toEqual([grantId]);
    expect(apps[0]).toMatchObject({ name: 'Claude Code', clientKind: 'registered' });
    expect(apps[0]?.expiresAt.getTime()).toBeGreaterThan(Date.now() + 29 * 24 * HOUR_MS);
  });

  it('are not mixed in with personal access tokens', async () => {
    await connectedApp();
    expect(await accessRepo.listTokens(db, userId)).toEqual([]);
    expect(await accessRepo.countTokens(db, userId)).toBe(0);
  });

  it('can be revoked by their owner only, taking every token with them', async () => {
    const { grantId, familyId } = await connectedApp();
    const other = await makeUser(db);
    expect(await accessRepo.revokeApp(db, other.id, grantId)).toBe(false);
    expect(await accessRepo.revokeApp(db, userId, grantId)).toBe(true);
    expect(await accessRepo.resolve(db, `at-${familyId}`)).toBeNull();
    expect(await db.$count(accessTokens)).toBe(0);
  });

  it('go when their client is deleted', async () => {
    await connectedApp();
    await db.delete(oauthClients).where(eq(oauthClients.id, client.id));
    expect(await db.$count(accessGrants)).toBe(0);
    expect(await db.$count(accessTokens)).toBe(0);
  });

  it('need a client exactly when they are an app', async () => {
    const appWithoutClient = await captureDatabaseError(() =>
      db.insert(accessGrants).values({ userId, kind: 'app', name: 'x', scopes: ['prompts:read'] }),
    );
    expect(appWithoutClient.constraint).toBe('access_grants_client_check');

    const tokenWithClient = await captureDatabaseError(() =>
      db.insert(accessGrants).values({
        userId,
        kind: 'token',
        name: 'x',
        scopes: ['prompts:read'],
        clientId: client.id,
      }),
    );
    expect(tokenWithClient.constraint).toBe('access_grants_client_check');
  });
});

describe('cleanup', () => {
  it('keeps a grant whose code is still waiting to be redeemed', async () => {
    await approve(await pendingRequest());
    await accessRepo.removeExpired(db);
    expect(await db.$count(accessGrants)).toBe(1);
  });

  it('removes a grant once its code lapsed unredeemed', async () => {
    await approve(await pendingRequest(), { codeExpiresAt: new Date(Date.now() - 1000) });
    await accessRepo.removeExpired(db);
    expect(await db.$count(accessGrants)).toBe(0);
  });

  it('removes requests a day after they lapse, and clients nobody approved', async () => {
    await pendingRequest({ expiresAt: new Date(Date.now() - 2 * 24 * HOUR_MS) });
    await pendingRequest();
    const unused = await oauthRepo.registerClient(db, {
      clientId: randomUUID(),
      name: 'Abandoned',
      redirectUris: ['https://abandoned.example/cb'],
    });
    await db
      .update(oauthClients)
      .set({ createdAt: sql`now() - interval '31 days'` })
      .where(eq(oauthClients.id, unused.id));
    await connectedApp();
    await db.update(oauthClients).set({ createdAt: sql`now() - interval '31 days'` });

    await oauthRepo.removeExpired(db);
    expect(await db.$count(oauthRequests)).toBe(2);
    expect((await db.select().from(oauthClients)).map((row) => row.id)).toEqual([client.id]);
  });
});
