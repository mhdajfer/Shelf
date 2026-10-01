import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Database } from './client.js';
import { promptRepo } from './repositories/promptRepo.js';
import { creditLedger, reports, votes } from './schema/activity.js';
import { promptVersions, prompts } from './schema/prompts.js';
import { captureDatabaseError, SQLSTATE } from './testing/errors.js';
import { makeGuestPrompt, makeUser, makeUserPrompt } from './testing/fixtures.js';
import { createTestDatabase, type TestDatabase } from './testing/harness.js';

/**
 * The invariants that live in the database rather than in TypeScript. These are
 * the ones that still hold when a future route forgets them, so they are
 * asserted against the real engine and by exact constraint name.
 */
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

describe('prompt check constraints', () => {
  it('rejects a prompt with neither an owner nor a guest', async () => {
    const error = await captureDatabaseError(() =>
      db.insert(prompts).values({ visibility: 'public', title: 'Orphan', category: 'writing' }),
    );
    expect(error.constraint).toBe('prompts_single_actor_check');
    expect(error.code).toBe(SQLSTATE.checkViolation);
  });

  it('rejects a prompt with both an owner and a guest', async () => {
    const error = await captureDatabaseError(() =>
      db.insert(prompts).values({
        ownerId: userId,
        guestId: 'g1',
        guestHandle: 'guest-g1',
        visibility: 'public',
        title: 'Both',
        category: 'writing',
      }),
    );
    expect(error.constraint).toBe('prompts_single_actor_check');
  });

  it('refuses to let a guest prompt be private', async () => {
    const error = await captureDatabaseError(() =>
      db.insert(prompts).values({
        guestId: 'g1',
        guestHandle: 'guest-g1',
        visibility: 'private',
        title: 'Hidden guest prompt',
        category: 'writing',
      }),
    );
    expect(error.constraint).toBe('prompts_guest_is_public_check');
  });

  it('requires a guest handle exactly when there is a guest', async () => {
    const error = await captureDatabaseError(() =>
      db.insert(prompts).values({
        guestId: 'g1',
        visibility: 'public',
        title: 'No handle',
        category: 'writing',
      }),
    );
    expect(error.constraint).toBe('prompts_guest_handle_check');
  });

  it('rejects a category outside the fixed list', async () => {
    const error = await captureDatabaseError(() =>
      db
        .insert(prompts)
        .values({ ownerId: userId, visibility: 'private', title: 'Odd', category: 'astrology' }),
    );
    expect(error.constraint).toBe('prompts_category_check');
  });
});

describe('prompt_versions immutability', () => {
  it('rejects an update to a stored version', async () => {
    const promptId = await makeUserPrompt(db, userId);
    const error = await captureDatabaseError(() =>
      db
        .update(promptVersions)
        .set({ body: 'rewritten' })
        .where(eq(promptVersions.promptId, promptId)),
    );
    expect(error.code).toBe(SQLSTATE.restrictViolation);
    expect(error.message).toMatch(/immutable/);
  });

  it('numbers versions sequentially and moves the current pointer', async () => {
    const promptId = await makeUserPrompt(db, userId);
    const second = await promptRepo.addVersion(db, promptId, { body: 'v2 body', variables: [] });

    expect(second.number).toBe(2);
    const versions = await promptRepo.listVersions(
      db,
      { type: 'user', userId, role: 'user' },
      promptId,
    );
    expect(versions?.map((version) => version.number)).toEqual([2, 1]);

    const [row] = await db
      .select({ currentVersionId: prompts.currentVersionId })
      .from(prompts)
      .where(eq(prompts.id, promptId));
    expect(row?.currentVersionId).toBe(second.id);
  });

  it('still cascades when the prompt is deleted', async () => {
    const promptId = await makeUserPrompt(db, userId);
    await db.delete(prompts).where(eq(prompts.id, promptId));

    const remaining = await db
      .select({ id: promptVersions.id })
      .from(promptVersions)
      .where(eq(promptVersions.promptId, promptId));
    expect(remaining).toEqual([]);
  });
});

describe('credit_ledger is append-only', () => {
  const entry = { actorType: 'user' as const, actorId: 'a', kind: 'run' as const, amount: -1 };

  it('accepts inserts', async () => {
    const [row] = await db.insert(creditLedger).values(entry).returning({ id: creditLedger.id });
    expect(row?.id).toBeGreaterThan(0);
  });

  it('rejects updates', async () => {
    await db.insert(creditLedger).values(entry);
    const error = await captureDatabaseError(() =>
      db.update(creditLedger).set({ amount: -99 }).where(eq(creditLedger.actorId, 'a')),
    );
    expect(error.code).toBe(SQLSTATE.restrictViolation);
    expect(error.message).toMatch(/append-only/);
  });

  it('rejects deletes', async () => {
    await db.insert(creditLedger).values(entry);
    const error = await captureDatabaseError(() =>
      db.delete(creditLedger).where(eq(creditLedger.actorId, 'a')),
    );
    expect(error.code).toBe(SQLSTATE.restrictViolation);
  });

  it('rejects a zero-amount entry', async () => {
    const error = await captureDatabaseError(() =>
      db.insert(creditLedger).values({ ...entry, amount: 0 }),
    );
    expect(error.constraint).toBe('credit_ledger_amount_nonzero_check');
  });

  it('records a refund as a compensating entry beside the debit', async () => {
    const [debit] = await db.insert(creditLedger).values(entry).returning({ id: creditLedger.id });
    await db
      .insert(creditLedger)
      .values({ ...entry, kind: 'refund', amount: 1, refId: debit?.id ?? null });

    const rows = await db.select().from(creditLedger).where(eq(creditLedger.actorId, 'a'));
    expect(rows).toHaveLength(2);
    expect(rows.reduce((sum, row) => sum + row.amount, 0)).toBe(0);
  });
});

describe('one vote and one report per actor', () => {
  it('rejects a second vote from the same user', async () => {
    const promptId = await makeUserPrompt(db, userId, { visibility: 'public' });
    await db.insert(votes).values({ promptId, userId });

    const error = await captureDatabaseError(() => db.insert(votes).values({ promptId, userId }));
    expect(error.constraint).toBe('votes_user_key');
  });

  it('rejects a second vote from the same guest', async () => {
    const promptId = await makeGuestPrompt(db, 'g1');
    await db.insert(votes).values({ promptId, guestId: 'g2' });

    const error = await captureDatabaseError(() =>
      db.insert(votes).values({ promptId, guestId: 'g2' }),
    );
    expect(error.constraint).toBe('votes_guest_key');
  });

  it('allows different voters on the same prompt', async () => {
    const promptId = await makeUserPrompt(db, userId, { visibility: 'public' });
    const other = await makeUser(db);

    await db.insert(votes).values({ promptId, userId });
    await db.insert(votes).values({ promptId, userId: other.id });
    await db.insert(votes).values({ promptId, guestId: 'g9' });

    expect(await db.$count(votes)).toBe(3);
  });

  it('stops one reporter tripping the auto-hide threshold alone', async () => {
    const promptId = await makeUserPrompt(db, userId, { visibility: 'public' });
    await db.insert(reports).values({ promptId, reporterUserId: userId, reason: 'spam' });

    const error = await captureDatabaseError(() =>
      db.insert(reports).values({ promptId, reporterUserId: userId, reason: 'spam again' }),
    );
    expect(error.constraint).toBe('reports_user_key');
  });
});

describe('search vector', () => {
  it('is populated on create, from the body as well as the title', async () => {
    await makeUserPrompt(db, userId, {
      visibility: 'public',
      title: 'Unrelated title',
      body: 'Explain the {{concept}} of hysteresis to a beginner.',
    });

    expect(await promptRepo.searchPublic(db, { query: 'hysteresis' })).toHaveLength(1);
  });

  it('follows the current version when a new one is saved', async () => {
    const promptId = await makeUserPrompt(db, userId, {
      visibility: 'public',
      body: 'Original wording about kingfishers.',
    });

    await promptRepo.addVersion(db, promptId, {
      body: 'Replaced wording about marmosets.',
      variables: [],
    });

    expect(await promptRepo.searchPublic(db, { query: 'marmosets' })).toHaveLength(1);
    expect(await promptRepo.searchPublic(db, { query: 'kingfishers' })).toHaveLength(0);
  });

  it('indexes tags, and drops them again when they are removed', async () => {
    const promptId = await makeUserPrompt(db, userId, {
      visibility: 'public',
      title: 'Nothing to do with the tag',
      body: 'Nothing to do with the tag either.',
      tags: ['phenomenology'],
    });

    expect(await promptRepo.searchPublic(db, { query: 'phenomenology' })).toHaveLength(1);

    await promptRepo.replaceTags(db, promptId, []);
    expect(await promptRepo.searchPublic(db, { query: 'phenomenology' })).toHaveLength(0);
  });

  it('ranks a title match above a body match', async () => {
    const titleMatch = await makeUserPrompt(db, userId, {
      visibility: 'public',
      title: 'Thermocline survey notes',
      body: 'Unrelated body text.',
    });
    await makeUserPrompt(db, userId, {
      visibility: 'public',
      title: 'Unrelated title',
      body: 'A passing mention of the thermocline in the third paragraph.',
    });

    const found = await promptRepo.searchPublic(db, { query: 'thermocline' });
    expect(found).toHaveLength(2);
    expect(found[0]?.id).toBe(titleMatch);
  });

  it('matches a quoted phrase as a phrase', async () => {
    await makeUserPrompt(db, userId, {
      visibility: 'public',
      title: 'Decision log from meeting notes',
      body: 'Separate decisions from discussion.',
    });

    expect(await promptRepo.searchPublic(db, { query: '"decision log"' })).toHaveLength(1);
    expect(await promptRepo.searchPublic(db, { query: '"log decision"' })).toHaveLength(0);
  });
});
