import type { PromptDetailDto, PromptListDto, PromptVersionDto } from '@shelf/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createApiHarness,
  signedInBrowser,
  type ApiHarness,
  type Browser,
} from './testing/harness.js';

let harness: ApiHarness;
let ada: Browser;

const DRAFT = {
  title: 'Summarize a changelog',
  description: 'Turns a raw changelog into release notes.',
  category: 'writing',
  body: 'Summarize {{changelog}} for a {{audience:general}} reader.',
  tags: ['Changelog', 'release-notes'],
};

beforeAll(async () => {
  harness = await createApiHarness();
}, 60_000);

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  await harness.database.truncate();
  harness.outbox.length = 0;
  ada = await signedInBrowser(harness, 'ada@example.test');
});

const promptOf = (response: { body: unknown }): PromptDetailDto =>
  (response.body as { prompt: PromptDetailDto }).prompt;

async function create(browser: Browser, overrides: object = {}): Promise<PromptDetailDto> {
  const response = await browser.post('/prompts', { ...DRAFT, ...overrides });
  if (response.status !== 201) {
    throw new Error(`create failed: ${String(response.status)} ${JSON.stringify(response.body)}`);
  }
  return promptOf(response);
}

describe('creating a prompt', () => {
  it('is private by default, with variables parsed and tags normalised', async () => {
    const prompt = await create(ada);

    expect(prompt).toMatchObject({
      visibility: 'private',
      versionNumber: 1,
      tags: ['changelog', 'release-notes'],
      author: { kind: 'user', handle: 'ada' },
      viewer: { isOwner: true, canEdit: true, hasVoted: false },
    });
    expect(prompt.variables.map((variable) => variable.name)).toEqual(['changelog', 'audience']);
    expect(prompt.variables[1]?.defaultValue).toBe('general');
  });

  it('reports each invalid field', async () => {
    const response = await ada.post('/prompts', { title: '', category: 'poetry', body: '   ' });
    expect(response.status).toBe(400);
    const fields = (response.body as { error: { details: { field: string }[] } }).error.details.map(
      (detail) => detail.field,
    );
    expect(fields).toEqual(expect.arrayContaining(['title', 'category', 'body']));
  });

  it('will not publish for an unverified account, but will save privately', async () => {
    const browser = await harness.browser();
    await browser.post('/auth/signup', { email: 'new@example.test', password: 'long enough pw' });

    expect((await browser.post('/prompts', { ...DRAFT, visibility: 'public' })).status).toBe(403);
    expect((await browser.post('/prompts', DRAFT)).status).toBe(201);
  });

  it('keeps unsuitable language out of public listings but allows it privately', async () => {
    const title = 'A fucking great prompt';
    const refused = await ada.post('/prompts', { ...DRAFT, title, visibility: 'public' });
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({ error: { details: [{ field: 'title' }] } });

    expect((await ada.post('/prompts', { ...DRAFT, title })).status).toBe(201);
  });
});

describe('guests', () => {
  it('can post publicly, are attributed to a guest handle, and run out after three', async () => {
    const guest = await harness.browser();

    for (let index = 0; index < 3; index += 1) {
      const prompt = await create(guest, { title: `Guest prompt ${String(index)}` });
      expect(prompt.visibility).toBe('public');
      expect(prompt.author).toMatchObject({ kind: 'guest' });
      expect(prompt.author.handle).toMatch(/^guest-[0-9a-f]{4}$/);
    }

    const fourth = await guest.post('/prompts', DRAFT);
    expect(fourth.status).toBe(402);
    expect(fourth.body).toMatchObject({ error: { code: 'insufficient_credits' } });
  });

  it('cannot reset the allowance by clearing cookies', async () => {
    const first = await harness.browser();
    for (let index = 0; index < 3; index += 1) await create(first);

    // A fresh cookie jar from the same address.
    const second = await harness.browser();
    expect((await second.post('/prompts', DRAFT)).status).toBe(402);
  });

  it('report the allowance before spending it', async () => {
    const guest = await harness.browser();
    await create(guest);
    const response = await guest.get('/credits');
    expect(response.body).toMatchObject({
      credits: { create: { limit: 3, used: 1, remaining: 2 }, model: { limit: 5, used: 0 } },
    });
  });

  it('cannot keep a prompt private', async () => {
    const guest = await harness.browser();
    expect((await guest.post('/prompts', { ...DRAFT, visibility: 'private' })).status).toBe(401);
  });

  it('can edit their own prompt for 24 hours, then it freezes', async () => {
    const guest = await harness.browser();
    const prompt = await create(guest);

    const edited = await guest.patch(`/prompts/${prompt.id}`, { title: 'Renamed' });
    expect(promptOf(edited).title).toBe('Renamed');

    await harness.database.pool.query(
      `UPDATE prompts SET created_at = now() - interval '25 hours' WHERE id = $1`,
      [prompt.id],
    );
    expect((await guest.patch(`/prompts/${prompt.id}`, { title: 'Again' })).status).toBe(403);
    expect((await guest.delete(`/prompts/${prompt.id}`)).status).toBe(403);

    const frozen = promptOf(await guest.get(`/prompts/${prompt.id}`));
    expect(frozen.viewer).toMatchObject({ isOwner: true, canEdit: false });
  });

  it('are not metered once signed in', async () => {
    for (let index = 0; index < 5; index += 1) await create(ada);
    expect((await ada.get('/credits')).body).toMatchObject({ credits: { create: null } });
  });
});

describe('editing and versions', () => {
  it('saves a new version only when the body changes', async () => {
    const prompt = await create(ada);

    const renamed = promptOf(await ada.patch(`/prompts/${prompt.id}`, { title: 'New title' }));
    expect(renamed.versionNumber).toBe(1);

    const rewritten = promptOf(
      await ada.patch(`/prompts/${prompt.id}`, {
        body: 'Summarize {{changelog}} in three bullets.',
        note: 'Shorter output',
      }),
    );
    expect(rewritten.versionNumber).toBe(2);
    expect(rewritten.variables.map((variable) => variable.name)).toEqual(['changelog']);

    const versions = (
      (await ada.get(`/prompts/${prompt.id}/versions`)).body as { versions: PromptVersionDto[] }
    ).versions;
    expect(versions.map((version) => version.number)).toEqual([2, 1]);
    expect(versions[0]?.note).toBe('Shorter output');
  });

  it('diffs the current version against the previous one by default', async () => {
    const prompt = await create(ada, { body: 'Line one\nLine two\n' });
    await ada.patch(`/prompts/${prompt.id}`, { body: 'Line one\nLine 2\n' });

    const diff = (await ada.get(`/prompts/${prompt.id}/diff`)).body as {
      from: { number: number };
      to: { number: number };
      changes: { value: string; added: boolean; removed: boolean }[];
    };
    expect(diff.from.number).toBe(1);
    expect(diff.to.number).toBe(2);
    expect(diff.changes.find((change) => change.removed)?.value).toBe('Line two\n');
    expect(diff.changes.find((change) => change.added)?.value).toBe('Line 2\n');
  });

  it('restores an old version by appending it, keeping the history intact', async () => {
    const prompt = await create(ada, { body: 'Original' });
    await ada.patch(`/prompts/${prompt.id}`, { body: 'Changed' });
    const versions = (
      (await ada.get(`/prompts/${prompt.id}/versions`)).body as { versions: PromptVersionDto[] }
    ).versions;
    const first = versions.find((version) => version.number === 1);

    const restored = promptOf(
      await ada.post(`/prompts/${prompt.id}/versions/${first?.id ?? ''}/restore`),
    );
    expect(restored.body).toBe('Original');
    expect(restored.versionNumber).toBe(3);
  });

  it('pins and unpins without touching updatedAt', async () => {
    const prompt = await create(ada);
    const pinned = promptOf(await ada.patch(`/prompts/${prompt.id}`, { pinned: true }));
    expect(pinned.pinned).toBe(true);
    expect(pinned.updatedAt).toBe(prompt.updatedAt);

    const list = (await ada.get('/shelf/prompts?pinned=true')).body as PromptListDto;
    expect(list.items.map((item) => item.id)).toEqual([prompt.id]);
  });

  it("refuses to edit or delete someone else's public prompt", async () => {
    const prompt = await create(ada, { visibility: 'public' });
    const grace = await signedInBrowser(harness, 'grace@example.test');

    expect((await grace.patch(`/prompts/${prompt.id}`, { title: 'Mine now' })).status).toBe(403);
    expect((await grace.delete(`/prompts/${prompt.id}`)).status).toBe(403);
  });

  it('deletes softly: gone for the owner, and from the shelf', async () => {
    const prompt = await create(ada);
    expect((await ada.delete(`/prompts/${prompt.id}`)).status).toBe(204);
    expect((await ada.get(`/prompts/${prompt.id}`)).status).toBe(404);
    expect(((await ada.get('/shelf/prompts')).body as PromptListDto).items).toEqual([]);
  });

  it('answers 404 for a malformed id instead of failing', async () => {
    expect((await ada.get('/prompts/not-a-uuid')).status).toBe(404);
  });
});

describe('forking', () => {
  it('copies a public prompt onto your shelf and credits the source', async () => {
    const source = await create(ada, { visibility: 'public' });
    const grace = await signedInBrowser(harness, 'grace@example.test');

    const response = await grace.post(`/prompts/${source.id}/fork`);
    expect(response.status).toBe(201);
    const fork = promptOf(response);
    expect(fork).toMatchObject({
      visibility: 'private',
      body: source.body,
      author: { handle: 'grace' },
      forkedFrom: { id: source.id, author: { handle: 'ada' } },
    });

    expect(promptOf(await ada.get(`/prompts/${source.id}`)).forkCount).toBe(1);
  });

  it('requires an account', async () => {
    const source = await create(ada, { visibility: 'public' });
    const guest = await harness.browser();
    expect((await guest.post(`/prompts/${source.id}/fork`)).status).toBe(401);
  });

  it('hides lineage once the source goes private', async () => {
    const source = await create(ada, { visibility: 'public' });
    const grace = await signedInBrowser(harness, 'grace@example.test');
    const fork = promptOf(await grace.post(`/prompts/${source.id}/fork`));

    await ada.patch(`/prompts/${source.id}`, { visibility: 'private' });
    expect(promptOf(await grace.get(`/prompts/${fork.id}`)).forkedFrom).toBeNull();
  });
});

describe('voting', () => {
  it('counts each voter once, however often they click', async () => {
    const prompt = await create(ada, { visibility: 'public' });
    const grace = await signedInBrowser(harness, 'grace@example.test');
    const guest = await harness.browser();

    await grace.put(`/prompts/${prompt.id}/vote`);
    const again = await grace.put(`/prompts/${prompt.id}/vote`);
    expect(again.body).toEqual({ upvoteCount: 1, hasVoted: true });

    expect((await guest.put(`/prompts/${prompt.id}/vote`)).body).toMatchObject({ upvoteCount: 2 });
    expect(promptOf(await grace.get(`/prompts/${prompt.id}`)).viewer.hasVoted).toBe(true);
    expect(promptOf(await ada.get(`/prompts/${prompt.id}`)).viewer.hasVoted).toBe(false);

    expect((await grace.delete(`/prompts/${prompt.id}/vote`)).body).toEqual({
      upvoteCount: 1,
      hasVoted: false,
    });
  });

  it('is only for prompts on the public shelf', async () => {
    const prompt = await create(ada);
    expect((await ada.put(`/prompts/${prompt.id}/vote`)).status).toBe(400);
  });
});

describe('reporting', () => {
  const reason = { reason: 'This is spam and links to a scam site.' };

  it('hides a prompt once three different people report it', async () => {
    const prompt = await create(ada, { visibility: 'public' });
    const reader = await harness.browser();

    for (const email of ['r1@example.test', 'r2@example.test']) {
      const reporter = await signedInBrowser(harness, email);
      expect((await reporter.post(`/prompts/${prompt.id}/report`, reason)).status).toBe(201);
    }
    expect((await reader.get(`/prompts/${prompt.id}`)).status).toBe(200);

    const third = await signedInBrowser(harness, 'r3@example.test');
    await third.post(`/prompts/${prompt.id}/report`, reason);

    expect((await reader.get(`/prompts/${prompt.id}`)).status).toBe(404);
    // The author still sees it, marked hidden, so they know what happened.
    expect(promptOf(await ada.get(`/prompts/${prompt.id}`)).status).toBe('hidden');
  });

  it('does not let one person reach the threshold alone', async () => {
    const prompt = await create(ada, { visibility: 'public' });
    const grace = await signedInBrowser(harness, 'grace@example.test');

    expect((await grace.post(`/prompts/${prompt.id}/report`, reason)).status).toBe(201);
    for (let index = 0; index < 3; index += 1) {
      const repeat = await grace.post(`/prompts/${prompt.id}/report`, reason);
      expect(repeat.body).toEqual({ ok: true, alreadyReported: true });
    }
    expect((await grace.get(`/prompts/${prompt.id}`)).status).toBe(200);
  });

  it('refuses a report on your own prompt', async () => {
    const prompt = await create(ada, { visibility: 'public' });
    expect((await ada.post(`/prompts/${prompt.id}/report`, reason)).status).toBe(400);
  });
});

describe('the public listing', () => {
  it('lists public prompts with a total, and filters by category and tag', async () => {
    await create(ada, { visibility: 'public', title: 'One' });
    await create(ada, { visibility: 'public', title: 'Two', category: 'coding', tags: ['sql'] });
    await create(ada, { title: 'Private one' });

    const reader = await harness.browser();
    const all = (await reader.get('/prompts?sort=new')).body as PromptListDto;
    expect(all.total).toBe(2);
    expect(all.items.map((item) => item.title)).toEqual(['Two', 'One']);
    expect(all.hasMore).toBe(false);

    const coding = (await reader.get('/prompts?category=coding')).body as PromptListDto;
    expect(coding.items.map((item) => item.title)).toEqual(['Two']);

    const tagged = (await reader.get('/prompts?tag=sql')).body as PromptListDto;
    expect(tagged.items.map((item) => item.title)).toEqual(['Two']);
  });

  it('paginates', async () => {
    for (let index = 0; index < 3; index += 1) {
      await create(ada, { visibility: 'public', title: `Prompt ${String(index)}` });
    }
    const reader = await harness.browser();
    const first = (await reader.get('/prompts?sort=new&limit=2')).body as PromptListDto;
    const second = (await reader.get('/prompts?sort=new&limit=2&page=2')).body as PromptListDto;

    expect(first.items).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    expect(second.items).toHaveLength(1);
    expect(second.hasMore).toBe(false);
  });

  it('rejects an unknown sort rather than guessing', async () => {
    const reader = await harness.browser();
    expect((await reader.get('/prompts?sort=random')).status).toBe(400);
  });
});
