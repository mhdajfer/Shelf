import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Database } from './client.js';
import { accessRepo, type CreateTokenInput } from './repositories/accessRepo.js';
import { collectionRepo } from './repositories/collectionRepo.js';
import {
  COMMAND_NAME_CONSTRAINT,
  promptRepo,
  type PromptSetScope,
} from './repositories/promptRepo.js';
import { accessGrants, accessTokens } from './schema/access.js';
import { prompts } from './schema/prompts.js';
import { captureDatabaseError, SQLSTATE } from './testing/errors.js';
import { makeGuestPrompt, makeUser, makeUserPrompt } from './testing/fixtures.js';
import { createTestDatabase, type TestDatabase } from './testing/harness.js';

let harness: TestDatabase;
let db: Database;
let userId: string;

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
});

async function commandNameOf(id: string): Promise<string | null> {
  const [row] = await db
    .select({ commandName: prompts.commandName })
    .from(prompts)
    .where(eq(prompts.id, id));
  return row?.commandName ?? null;
}

describe('command names', () => {
  it('are assigned from the title when a prompt is created', async () => {
    const id = await makeUserPrompt(db, userId, { title: 'Commit message (conventional)' });
    expect(await commandNameOf(id)).toBe('commit-message-conventional');
  });

  it('get numbered suffixes on collision, oldest keeping the plain name', async () => {
    const first = await makeUserPrompt(db, userId, { title: 'Review' });
    const second = await makeUserPrompt(db, userId, { title: 'review!' });
    const third = await makeUserPrompt(db, userId, { title: 'REVIEW' });
    expect([
      await commandNameOf(first),
      await commandNameOf(second),
      await commandNameOf(third),
    ]).toEqual(['review', 'review-2', 'review-3']);
  });

  it('are per owner', async () => {
    const other = await makeUser(db);
    await makeUserPrompt(db, userId, { title: 'Review' });
    const theirs = await makeUserPrompt(db, other.id, { title: 'Review' });
    expect(await commandNameOf(theirs)).toBe('review');
  });

  it('are freed when the prompt is deleted', async () => {
    const first = await makeUserPrompt(db, userId, { title: 'Review' });
    await promptRepo.softDelete(db, first);
    const second = await makeUserPrompt(db, userId, { title: 'Review' });
    expect(await commandNameOf(second)).toBe('review');
  });

  it('stay distinct when creates race', async () => {
    const ids = await Promise.all(
      Array.from({ length: 6 }, () => makeUserPrompt(db, userId, { title: 'Same title' })),
    );
    const names = await Promise.all(ids.map(commandNameOf));
    expect(new Set(names).size).toBe(6);
    expect(names).toContain('same-title');
  });

  it('do not change when the title does', async () => {
    const id = await makeUserPrompt(db, userId, { title: 'Original' });
    await promptRepo.updateMeta(db, id, { title: 'Renamed' });
    expect(await commandNameOf(id)).toBe('original');
  });

  it('can be renamed, but not to one the owner already uses', async () => {
    const id = await makeUserPrompt(db, userId, { title: 'First' });
    await makeUserPrompt(db, userId, { title: 'Second' });

    await promptRepo.updateMeta(db, id, { commandName: 'shipit' });
    expect(await commandNameOf(id)).toBe('shipit');

    const error = await captureDatabaseError(() =>
      promptRepo.updateMeta(db, id, { commandName: 'second' }),
    );
    expect(error.constraint).toBe(COMMAND_NAME_CONSTRAINT);
  });

  it('are absent on guest prompts', async () => {
    const id = await makeGuestPrompt(db, 'g1');
    expect(await commandNameOf(id)).toBeNull();
  });

  it('are required on a user prompt and refused on a guest prompt', async () => {
    const missing = await captureDatabaseError(() =>
      db
        .insert(prompts)
        .values({ ownerId: userId, visibility: 'private', title: 'x', category: 'writing' }),
    );
    expect(missing.constraint).toBe('prompts_command_name_check');

    const onGuest = await captureDatabaseError(() =>
      db.insert(prompts).values({
        guestId: 'g1',
        guestHandle: 'guest-g1',
        visibility: 'public',
        title: 'x',
        category: 'writing',
        commandName: 'x',
      }),
    );
    expect(onGuest.constraint).toBe('prompts_command_name_check');
  });

  it.each(['Upper', 'two--hyphens', '-lead', 'under_score', 'a'.repeat(49)])(
    'refuses the malformed name %j',
    async (commandName) => {
      const error = await captureDatabaseError(() =>
        db.insert(prompts).values({
          ownerId: userId,
          visibility: 'private',
          title: 'x',
          category: 'writing',
          commandName,
        }),
      );
      expect(error.constraint).toBe('prompts_command_name_format_check');
    },
  );
});

describe('prompt sets', () => {
  const all = (): PromptSetScope => ({ userId, promptSet: 'all', collectionId: null });

  it('list the owner’s live prompts in command-name order', async () => {
    await makeUserPrompt(db, userId, { title: 'Bravo' });
    await makeUserPrompt(db, userId, { title: 'Alpha' });
    const gone = await makeUserPrompt(db, userId, { title: 'Charlie' });
    await promptRepo.softDelete(db, gone);
    await makeUserPrompt(db, (await makeUser(db)).id, { title: 'Aardvark', visibility: 'public' });

    const listed = await promptRepo.listInSet(db, all());
    expect(listed.map((prompt) => prompt.commandName)).toEqual(['alpha', 'bravo']);
  });

  it('page by the last name seen', async () => {
    for (const title of ['a', 'b', 'c', 'd', 'e']) await makeUserPrompt(db, userId, { title });

    const first = await promptRepo.listInSet(db, all(), { limit: 2 });
    const second = await promptRepo.listInSet(db, all(), {
      limit: 2,
      after: first.at(-1)?.commandName ?? '',
    });
    expect(first.map((prompt) => prompt.commandName)).toEqual(['a', 'b']);
    expect(second.map((prompt) => prompt.commandName)).toEqual(['c', 'd']);
  });

  it('limit to pinned prompts', async () => {
    const pinned = await makeUserPrompt(db, userId, { title: 'Pinned' });
    await makeUserPrompt(db, userId, { title: 'Loose' });
    await promptRepo.updateMeta(db, pinned, { pinned: true });

    const scope: PromptSetScope = { userId, promptSet: 'pinned', collectionId: null };
    expect((await promptRepo.listInSet(db, scope)).map((prompt) => prompt.id)).toEqual([pinned]);
  });

  it('limit to one collection', async () => {
    const inside = await makeUserPrompt(db, userId, { title: 'Inside' });
    const outside = await makeUserPrompt(db, userId, { title: 'Outside' });
    const collectionId = await collectionRepo.createCollection(db, userId, 'Work');
    await collectionRepo.addItem(db, userId, collectionId, inside);

    const scope: PromptSetScope = { userId, promptSet: 'collection', collectionId };
    expect((await promptRepo.listInSet(db, scope)).map((prompt) => prompt.id)).toEqual([inside]);
    expect(await promptRepo.findInSet(db, scope, { id: outside })).toBeNull();
    expect(await promptRepo.findInSet(db, scope, { commandName: 'outside' })).toBeNull();
    expect((await promptRepo.findInSet(db, scope, { commandName: 'inside' }))?.id).toBe(inside);
  });

  it('never reach another user’s prompts, even through their collection', async () => {
    const other = await makeUser(db);
    const theirs = await makeUserPrompt(db, other.id, { title: 'Secret' });
    const theirCollection = await collectionRepo.createCollection(db, other.id, 'Theirs');
    await collectionRepo.addItem(db, other.id, theirCollection, theirs);

    const scope: PromptSetScope = {
      userId,
      promptSet: 'collection',
      collectionId: theirCollection,
    };
    expect(await promptRepo.listInSet(db, scope)).toEqual([]);
    expect(await promptRepo.findInSet(db, all(), { id: theirs })).toBeNull();
    expect(await promptRepo.findInSet(db, all(), { commandName: 'secret' })).toBeNull();
  });

  it('search within the set, with and without a query', async () => {
    await makeUserPrompt(db, userId, {
      title: 'Explain hysteresis',
      tags: ['physics'],
    });
    await makeUserPrompt(db, userId, { title: 'Write a haiku', tags: ['poetry'] });

    const byQuery = await promptRepo.searchInSet(db, all(), { query: 'hysteresis' });
    expect(byQuery.map((prompt) => prompt.title)).toEqual(['Explain hysteresis']);

    const byTag = await promptRepo.searchInSet(db, all(), { tags: ['poetry'] });
    expect(byTag.map((prompt) => prompt.title)).toEqual(['Write a haiku']);
  });
});

describe('access grants and tokens', () => {
  const token = (overrides: Partial<CreateTokenInput> = {}): CreateTokenInput => ({
    userId,
    name: 'Laptop',
    scopes: ['prompts:read'],
    promptSet: 'all',
    collectionId: null,
    tokenHash: `hash-${String(Math.random())}`,
    display: 'shelf_pat_abc123',
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  });

  it('resolve a live token to its grant', async () => {
    const grantId = await accessRepo.createToken(db, token({ tokenHash: 'h1' }));
    const resolved = await accessRepo.resolve(db, 'h1');
    expect(resolved).toMatchObject({ grantId, userId, scopes: ['prompts:read'], promptSet: 'all' });
  });

  it('do not resolve an expired or unknown token', async () => {
    await accessRepo.createToken(db, token({ tokenHash: 'old', expiresAt: new Date(0) }));
    expect(await accessRepo.resolve(db, 'old')).toBeNull();
    expect(await accessRepo.resolve(db, 'never-issued')).toBeNull();
  });

  it('refuse a collection the user does not own', async () => {
    const other = await makeUser(db);
    const theirs = await collectionRepo.createCollection(db, other.id, 'Theirs');
    const created = await accessRepo.createToken(
      db,
      token({ promptSet: 'collection', collectionId: theirs }),
    );
    expect(created).toBeNull();
    expect(await db.$count(accessGrants)).toBe(0);
  });

  it('are deleted, not widened, when their collection is deleted', async () => {
    const collectionId = await collectionRepo.createCollection(db, userId, 'Work');
    await accessRepo.createToken(
      db,
      token({ promptSet: 'collection', collectionId, tokenHash: 'c1' }),
    );
    await collectionRepo.remove(db, userId, collectionId);

    expect(await accessRepo.resolve(db, 'c1')).toBeNull();
    expect(await db.$count(accessGrants)).toBe(0);
    expect(await db.$count(accessTokens)).toBe(0);
  });

  it('can only be revoked by their owner', async () => {
    const grantId = await accessRepo.createToken(db, token({ tokenHash: 'r1' }));
    const other = await makeUser(db);

    expect(await accessRepo.revokeToken(db, other.id, grantId ?? '')).toBe(false);
    expect(await accessRepo.resolve(db, 'r1')).not.toBeNull();
    expect(await accessRepo.revokeToken(db, userId, grantId ?? '')).toBe(true);
    expect(await accessRepo.resolve(db, 'r1')).toBeNull();
  });

  it('record use at most once per interval', async () => {
    const grantId = (await accessRepo.createToken(db, token())) ?? '';
    await accessRepo.touch(db, grantId);
    const [first] = await db.select().from(accessGrants).where(eq(accessGrants.id, grantId));
    await accessRepo.touch(db, grantId);
    const [second] = await db.select().from(accessGrants).where(eq(accessGrants.id, grantId));

    expect(first?.lastUsedAt).not.toBeNull();
    expect(second?.lastUsedAt?.getTime()).toBe(first?.lastUsedAt?.getTime());
  });

  it('list only the user’s live tokens, newest first, with their collection', async () => {
    const collectionId = await collectionRepo.createCollection(db, userId, 'Work');
    await accessRepo.createToken(db, token({ name: 'Old' }));
    await accessRepo.createToken(db, token({ name: 'New', promptSet: 'collection', collectionId }));
    await accessRepo.createToken(db, token({ name: 'Expired', expiresAt: new Date(0) }));
    await accessRepo.createToken(db, token({ userId: (await makeUser(db)).id, name: 'Theirs' }));

    const listed = await accessRepo.listTokens(db, userId);
    expect(listed.map((entry) => entry.name)).toEqual(['New', 'Old']);
    expect(listed[0]?.collection).toEqual({ id: collectionId, name: 'Work' });
    expect(await accessRepo.countTokens(db, userId)).toBe(2);
  });

  it('are all revoked together after a possible compromise', async () => {
    await accessRepo.createToken(db, token({ tokenHash: 'a' }));
    await accessRepo.createToken(db, token({ tokenHash: 'b' }));
    await accessRepo.revokeAllForUser(db, userId);
    expect(await db.$count(accessGrants)).toBe(0);
  });

  it('are cleaned up once expired, grant and all', async () => {
    await accessRepo.createToken(db, token({ tokenHash: 'live' }));
    await accessRepo.createToken(db, token({ tokenHash: 'dead', expiresAt: new Date(0) }));
    await accessRepo.removeExpired(db);

    expect(await db.$count(accessTokens)).toBe(1);
    expect(await db.$count(accessGrants)).toBe(1);
  });

  it('refuse write without read, and unknown scopes', async () => {
    for (const scopes of [['prompts:write'], ['prompts:read', 'prompts:delete'], []]) {
      const error = await captureDatabaseError(() =>
        db.insert(accessGrants).values({ userId, kind: 'token', name: 'x', scopes }),
      );
      expect(error.constraint).toBe('access_grants_scopes_check');
    }
  });

  it('need a collection exactly when limited to one', async () => {
    const error = await captureDatabaseError(() =>
      db.insert(accessGrants).values({
        userId,
        kind: 'token',
        name: 'x',
        scopes: ['prompts:read'],
        promptSet: 'collection',
      }),
    );
    expect(error.constraint).toBe('access_grants_collection_check');
  });

  it('never store the same token hash twice', async () => {
    await accessRepo.createToken(db, token({ tokenHash: 'dup' }));
    const error = await captureDatabaseError(() =>
      accessRepo.createToken(db, token({ tokenHash: 'dup' })),
    );
    expect(error.code).toBe(SQLSTATE.uniqueViolation);
    expect(error.constraint).toBe('access_tokens_hash_key');
  });

  it('go with the account', async () => {
    await accessRepo.createToken(db, token());
    await harness.pool.query('DELETE FROM users WHERE id = $1', [userId]);
    expect(await db.$count(accessGrants)).toBe(0);
  });
});
