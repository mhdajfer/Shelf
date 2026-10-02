import {
  ANONYMOUS,
  collectionRepo,
  guestActor,
  promptRepo,
  userActor,
  type Actor,
  type Database,
} from '@shelf/db';
import {
  createTestDatabase,
  makeGuestPrompt,
  makeUser,
  makeUserPrompt,
  type TestDatabase,
  type UserFixture,
} from '@shelf/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * The suite the brief calls out by name. One rule, asserted on every surface
 * that can return a prompt: user B cannot learn that user A's private prompt
 * exists, by any route.
 *
 * This file covers the repository surfaces. The same rule is asserted over HTTP
 * in privacy.http.spec.ts; the `it.todo` entries at the bottom name the
 * surfaces whose endpoints have not landed yet.
 */
let harness: TestDatabase;
let db: Database;

let alice: UserFixture;
let bob: UserFixture;
let admin: UserFixture;

/** Alice's private prompt. The thing nobody else may see. */
let secretId: string;
/** Alice's public prompt, for contrast: everyone may see this one. */
let publicId: string;
let aliceCollectionId: string;

const GUEST_A = 'guest-cookie-aaaa';
const GUEST_B = 'guest-cookie-bbbb';

beforeAll(async () => {
  harness = await createTestDatabase();
  db = harness.db;
}, 60_000);

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  await harness.truncate();

  alice = await makeUser(db, { handle: 'alice' });
  bob = await makeUser(db, { handle: 'bob' });
  admin = await makeUser(db, { handle: 'root', role: 'admin' });

  secretId = await makeUserPrompt(db, alice.id, {
    title: 'Quarterly earnings narrative',
    body: 'Draft the narrative for {{quarter}} using {{figures}}.',
    description: 'Internal only.',
    tags: ['finance', 'internal'],
  });

  publicId = await makeUserPrompt(db, alice.id, {
    visibility: 'public',
    title: 'Summarize a changelog',
    tags: ['changelog'],
  });

  aliceCollectionId = await collectionRepo.createCollection(db, alice.id, 'Internal');
  await collectionRepo.addItem(db, aliceCollectionId, secretId);
});

/**
 * Everyone who is not Alice. Each actor is a thunk because describe.each runs
 * at collection time, before the fixtures in beforeEach exist.
 */
const OUTSIDERS: [string, () => Actor][] = [
  ['anonymous', () => ANONYMOUS],
  ['another user', () => userActor(bob.id, bob.role)],
  ['an admin', () => userActor(admin.id, 'admin')],
  ['a guest', () => guestActor(GUEST_B)],
];

describe("a private prompt and its owner's shelf", () => {
  it('is readable by its owner', async () => {
    const found = await promptRepo.findVisible(db, userActor(alice.id), secretId);
    expect(found?.id).toBe(secretId);
    expect(found?.visibility).toBe('private');
  });

  describe.each(OUTSIDERS)('%s', (_label, getActor) => {
    it('cannot fetch it directly', async () => {
      expect(await promptRepo.findVisible(db, getActor(), secretId)).toBeNull();
    });

    it('cannot find it in any public listing or sort order', async () => {
      for (const sort of ['trending', 'new', 'top_week', 'top_all'] as const) {
        const ids = (await promptRepo.listPublic(db, { sort, limit: 50 })).map((p) => p.id);
        expect(ids).not.toContain(secretId);
        expect(ids).toContain(publicId);
      }
    });

    it('cannot find it by searching its title', async () => {
      const ids = (await promptRepo.searchPublic(db, { query: 'quarterly earnings' })).map(
        (p) => p.id,
      );
      expect(ids).not.toContain(secretId);
    });

    it('cannot find it by searching its body', async () => {
      const ids = (await promptRepo.searchPublic(db, { query: 'narrative figures' })).map(
        (p) => p.id,
      );
      expect(ids).not.toContain(secretId);
    });

    it('cannot find it by searching its tags', async () => {
      const ids = (await promptRepo.searchPublic(db, { query: 'internal' })).map((p) => p.id);
      expect(ids).not.toContain(secretId);
    });

    it('cannot find it by filtering on its tags', async () => {
      const ids = (await promptRepo.listPublic(db, { tags: ['internal'], limit: 50 })).map(
        (p) => p.id,
      );
      expect(ids).not.toContain(secretId);
    });

    it('cannot read its version history', async () => {
      expect(await promptRepo.listVersions(db, getActor(), secretId)).toBeNull();
    });

    it('cannot read a specific version of it', async () => {
      const owned = await promptRepo.listVersions(db, userActor(alice.id), secretId);
      const versionId = owned?.[0]?.id;
      expect(versionId).toBeDefined();
      expect(
        await promptRepo.findVersion(db, getActor(), secretId, versionId as string),
      ).toBeNull();
    });

    it('cannot see it through the collection it sits in', async () => {
      expect(await collectionRepo.listItems(db, getActor(), aliceCollectionId)).toBeNull();
    });

    it('cannot enumerate the collection itself', async () => {
      expect(await collectionRepo.findCollection(db, getActor(), aliceCollectionId)).toBeNull();
      expect(await collectionRepo.listCollections(db, getActor())).toEqual([]);
    });

    it("gets its own shelf, never Alice's, from listOwned", async () => {
      const ids = (await promptRepo.listOwned(db, getActor(), { limit: 50 })).map((p) => p.id);
      expect(ids).not.toContain(secretId);
      expect(ids).not.toContain(publicId);
    });

    it('cannot reach it through a shelf search', async () => {
      const ids = (await promptRepo.searchOwned(db, getActor(), { query: 'quarterly' })).map(
        (p) => p.id,
      );
      expect(ids).not.toContain(secretId);
    });

    it('cannot see it listed as a fork of a public prompt', async () => {
      const forkId = await makeUserPrompt(db, alice.id, {
        title: 'Private fork',
        forkedFromId: publicId,
      });
      const ids = (await promptRepo.listForks(db, publicId)).map((p) => p.id);
      expect(ids).not.toContain(forkId);
    });
  });

  it('is not revealed by the category counts used for the public chips', async () => {
    const counts = await promptRepo.listCategoriesWithCounts(db);
    const total = counts.reduce((sum, row) => sum + row.count, 0);
    const publicCount = (await promptRepo.listPublic(db, { sort: 'new', limit: 50 })).length;
    expect(total).toBe(publicCount);
  });
});

describe('a hidden public prompt', () => {
  beforeEach(async () => {
    await promptRepo.setStatus(db, publicId, 'hidden');
  });

  it('disappears from public listings', async () => {
    const ids = (await promptRepo.listPublic(db, { sort: 'new', limit: 50 })).map((p) => p.id);
    expect(ids).not.toContain(publicId);
  });

  it('is still visible to an admin, who has to moderate it', async () => {
    const found = await promptRepo.findVisible(db, userActor(admin.id, 'admin'), publicId);
    expect(found?.id).toBe(publicId);
  });

  it('is still visible to its owner', async () => {
    expect(await promptRepo.findVisible(db, userActor(alice.id), publicId)).not.toBeNull();
  });

  it('is not visible to an unrelated user', async () => {
    expect(await promptRepo.findVisible(db, userActor(bob.id), publicId)).toBeNull();
  });
});

describe('an admin', () => {
  it('can moderate hidden public content but cannot read a private prompt', async () => {
    const asAdmin = userActor(admin.id, 'admin');
    await promptRepo.setStatus(db, publicId, 'hidden');

    expect(await promptRepo.findVisible(db, asAdmin, publicId)).not.toBeNull();
    // The admin role exists for public moderation. It is not a master key.
    expect(await promptRepo.findVisible(db, asAdmin, secretId)).toBeNull();
  });
});

describe('a deleted prompt', () => {
  it('is gone for its owner and everyone else', async () => {
    await promptRepo.setStatus(db, secretId, 'deleted');
    expect(await promptRepo.findVisible(db, userActor(alice.id), secretId)).toBeNull();
    expect(await promptRepo.findVisible(db, userActor(bob.id), secretId)).toBeNull();
  });

  it("leaves the owner's shelf", async () => {
    await promptRepo.setStatus(db, publicId, 'deleted');
    const ids = (await promptRepo.listOwned(db, userActor(alice.id), { limit: 50 })).map(
      (p) => p.id,
    );
    expect(ids).not.toContain(publicId);
  });
});

describe('guest prompts', () => {
  it('are public and readable by anyone', async () => {
    const id = await makeGuestPrompt(db, GUEST_A, { title: 'Guest contribution' });
    expect(await promptRepo.findVisible(db, ANONYMOUS, id)).not.toBeNull();
    expect(await promptRepo.findVisible(db, userActor(bob.id), id)).not.toBeNull();
  });

  it('are attributed to a guest handle, never to a user', async () => {
    const id = await makeGuestPrompt(db, GUEST_A);
    const found = await promptRepo.findVisible(db, ANONYMOUS, id);
    expect(found?.author.kind).toBe('guest');
    expect(found?.author.handle).toMatch(/^guest-/);
  });

  it('stay readable to their author after it is hidden, but not to another guest', async () => {
    const id = await makeGuestPrompt(db, GUEST_A);
    await promptRepo.setStatus(db, id, 'hidden');

    expect(await promptRepo.findVisible(db, guestActor(GUEST_A), id)).not.toBeNull();
    expect(await promptRepo.findVisible(db, guestActor(GUEST_B), id)).toBeNull();
    expect(await promptRepo.findVisible(db, ANONYMOUS, id)).toBeNull();
  });

  it('give a guest no shelf to list', async () => {
    await makeGuestPrompt(db, GUEST_A);
    expect(await promptRepo.listOwned(db, guestActor(GUEST_A), {})).toEqual([]);
  });
});

describe('surfaces still to be covered', () => {
  // Each lands with the phase that introduces the endpoint. Listed here so the
  // gap is visible in the test output rather than only in the brief.
  it.todo('POST /runs refuses a prompt version the actor cannot read');
  it.todo('GET /export refuses a prompt the actor cannot read');
  it.todo('the OG image route 404s for a private prompt');
  it.todo('the sitemap lists only public, active prompts');
  it.todo("a profile page lists only that user's public prompts");
});
