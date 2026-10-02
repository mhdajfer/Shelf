import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Database } from './client.js';
import { creditRepo, reportRepo, voteRepo, type CreditActor } from './repositories/activityRepo.js';
import { promptRepo } from './repositories/promptRepo.js';
import { makeUser, makeUserPrompt } from './testing/fixtures.js';
import { createTestDatabase, type TestDatabase } from './testing/harness.js';

let harness: TestDatabase;
let db: Database;

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
}, 60_000);

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  await harness.truncate();
});

describe('credits', () => {
  const guest: CreditActor = { type: 'guest', id: 'cookie-a', ipHash: 'ip-1' };

  it('debits until the limit and then refuses', async () => {
    for (let index = 0; index < 3; index += 1) {
      expect((await creditRepo.spend(db, guest, 'create', 3)).ok).toBe(true);
    }
    expect(await creditRepo.spend(db, guest, 'create', 3)).toEqual({ ok: false, used: 3 });
  });

  it('never overspends when requests race for the last credit', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => creditRepo.spend(db, guest, 'run', 3)),
    );
    expect(results.filter((result) => result.ok)).toHaveLength(3);
    expect(await creditRepo.used(db, guest, 'model')).toBe(3);
  });

  it('keeps the two pools separate, and shares one between runs and tools', async () => {
    await creditRepo.spend(db, guest, 'create', 3);
    await creditRepo.spend(db, guest, 'run', 5);
    await creditRepo.spend(db, guest, 'tool', 5);

    expect(await creditRepo.used(db, guest, 'create')).toBe(1);
    expect(await creditRepo.used(db, guest, 'model')).toBe(2);
  });

  it('meters a guest by address as well as by cookie', async () => {
    await creditRepo.spend(db, guest, 'create', 3);
    const sameAddressNewCookie: CreditActor = { type: 'guest', id: 'cookie-b', ipHash: 'ip-1' };
    const elsewhere: CreditActor = { type: 'guest', id: 'cookie-c', ipHash: 'ip-2' };

    expect(await creditRepo.used(db, sameAddressNewCookie, 'create')).toBe(1);
    expect(await creditRepo.used(db, elsewhere, 'create')).toBe(0);
  });

  it('gives the credit back on refund, once, however often it is asked', async () => {
    const spent = await creditRepo.spend(db, guest, 'run', 5);
    if (!spent.ok) throw new Error('expected the spend to succeed');

    await creditRepo.refund(db, spent.entryId);
    await creditRepo.refund(db, spent.entryId);

    expect(await creditRepo.used(db, guest, 'model')).toBe(0);
    // The refund reverses a model debit, so it must not leak into the other pool.
    expect(await creditRepo.used(db, guest, 'create')).toBe(0);
    expect(await creditRepo.modelCallsToday(db)).toBe(0);
  });

  it("does not count yesterday's spending", async () => {
    await creditRepo.spend(db, guest, 'run', 5);
    // TRUNCATE-free way to age a row in an append-only table: bypass the trigger.
    await harness.pool.query('ALTER TABLE credit_ledger DISABLE TRIGGER credit_ledger_append_only');
    await harness.pool.query(`UPDATE credit_ledger SET created_at = now() - interval '25 hours'`);
    await harness.pool.query('ALTER TABLE credit_ledger ENABLE TRIGGER credit_ledger_append_only');

    expect(await creditRepo.used(db, guest, 'model')).toBe(0);
  });
});

describe('votes and reports', () => {
  it('keeps the counter equal to the number of distinct voters', async () => {
    const author = await makeUser(db);
    const promptId = await makeUserPrompt(db, author.id, { visibility: 'public' });
    const voter = { type: 'user' as const, userId: (await makeUser(db)).id };

    await Promise.all([
      voteRepo.addVote(db, promptId, voter),
      voteRepo.addVote(db, promptId, voter),
      voteRepo.addVote(db, promptId, { type: 'guest', guestId: 'g-1' }),
    ]);
    expect(await voteRepo.addVote(db, promptId, voter)).toBe(2);
    expect(await voteRepo.removeVote(db, promptId, voter)).toBe(1);
    expect(await voteRepo.removeVote(db, promptId, voter)).toBe(1);
  });

  it('does not bump updated_at when a prompt is upvoted', async () => {
    const author = await makeUser(db);
    const promptId = await makeUserPrompt(db, author.id, { visibility: 'public' });
    const before = await promptRepo.findVisible(db, { type: 'anonymous' }, promptId);

    await voteRepo.addVote(db, promptId, { type: 'guest', guestId: 'g-1' });
    const after = await promptRepo.findVisible(db, { type: 'anonymous' }, promptId);

    expect(after?.upvoteCount).toBe(1);
    expect(after?.updatedAt).toEqual(before?.updatedAt);
  });

  it('queues reported prompts for moderation and clears them on resolve', async () => {
    const author = await makeUser(db);
    const admin = await makeUser(db, { role: 'admin' });
    const promptId = await makeUserPrompt(db, author.id, { visibility: 'public' });

    for (const guestId of ['g-1', 'g-2', 'g-3']) {
      await reportRepo.addReport(db, promptId, { type: 'guest', guestId }, 'Spam link farm.');
    }

    const queue = await reportRepo.listReported(db);
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ promptId, status: 'hidden', openReports: 3 });

    expect(await reportRepo.resolveReports(db, promptId, admin.id, 'restore')).toBe(true);
    expect(await reportRepo.listReported(db)).toEqual([]);
    expect((await promptRepo.findVisible(db, { type: 'anonymous' }, promptId))?.status).toBe(
      'active',
    );
  });
});
