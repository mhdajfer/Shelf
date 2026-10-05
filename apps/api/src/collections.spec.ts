import type { PromptDetailDto, PromptListDto, ShelfSummaryDto } from '@shelf/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createApiHarness,
  signedInBrowser,
  type ApiHarness,
  type Browser,
} from './testing/harness.js';

let harness: ApiHarness;
let ada: Browser;
let grace: Browser;

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
  grace = await signedInBrowser(harness, 'grace@example.test');
});

async function createPrompt(browser: Browser, title: string): Promise<string> {
  const response = await browser.post('/prompts', {
    title,
    category: 'writing',
    body: 'Summarize {{text}}.',
  });
  return (response.body as { prompt: PromptDetailDto }).prompt.id;
}

async function createCollection(browser: Browser, name: string): Promise<string> {
  const response = await browser.post('/collections', { name });
  return (response.body as { collection: { id: string } }).collection.id;
}

const summary = async (browser: Browser): Promise<ShelfSummaryDto> =>
  (await browser.get('/shelf/summary')).body as ShelfSummaryDto;

describe('collections', () => {
  it('creates, lists with counts, renames, reorders, and deletes', async () => {
    const drafts = await createCollection(ada, 'Drafts');
    const work = await createCollection(ada, 'Work');
    const promptId = await createPrompt(ada, 'One');
    await ada.put(`/collections/${drafts}/prompts/${promptId}`);

    let shelf = await summary(ada);
    expect(shelf.counts).toEqual({ total: 1, pinned: 0, public: 0 });
    expect(shelf.collections.map((c) => [c.name, c.itemCount])).toEqual([
      ['Drafts', 1],
      ['Work', 0],
    ]);

    await ada.patch(`/collections/${drafts}`, { name: 'Ideas' });
    await ada.put('/collections/order', { ids: [work, drafts] });
    shelf = await summary(ada);
    expect(shelf.collections.map((c) => c.name)).toEqual(['Work', 'Ideas']);

    expect((await ada.delete(`/collections/${drafts}`)).status).toBe(204);
    // Deleting a collection leaves the prompt on the shelf.
    expect((await summary(ada)).counts.total).toBe(1);
  });

  it('refuses a duplicate name with a field error', async () => {
    await createCollection(ada, 'Drafts');
    const response = await ada.post('/collections', { name: 'Drafts' });
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ error: { details: [{ field: 'name' }] } });
  });

  it('filters the shelf by collection, and reports membership for a prompt', async () => {
    const drafts = await createCollection(ada, 'Drafts');
    const inside = await createPrompt(ada, 'Inside');
    await createPrompt(ada, 'Outside');
    await ada.put(`/collections/${drafts}/prompts/${inside}`);

    const list = (await ada.get(`/shelf/prompts?collection=${drafts}`)).body as PromptListDto;
    expect(list.items.map((item) => item.title)).toEqual(['Inside']);

    const membership = await ada.get(`/prompts/${inside}/collections`);
    expect(membership.body).toEqual({ collectionIds: [drafts] });

    await ada.delete(`/collections/${drafts}/prompts/${inside}`);
    expect((await ada.get(`/prompts/${inside}/collections`)).body).toEqual({ collectionIds: [] });
  });

  it('requires an account', async () => {
    const visitor = await harness.browser();
    expect((await visitor.get('/shelf/summary')).status).toBe(401);
    expect((await visitor.post('/collections', { name: 'Mine' })).status).toBe(401);
  });
});

describe("someone else's collection", () => {
  let adaCollection: string;
  let adaPrompt: string;

  beforeEach(async () => {
    adaCollection = await createCollection(ada, 'Internal');
    adaPrompt = await createPrompt(ada, 'Secret plan');
    await ada.put(`/collections/${adaCollection}/prompts/${adaPrompt}`);
  });

  it('cannot be renamed, deleted, or listed', async () => {
    expect((await grace.patch(`/collections/${adaCollection}`, { name: 'Taken' })).status).toBe(
      404,
    );
    expect((await grace.delete(`/collections/${adaCollection}`)).status).toBe(404);

    const list = (await grace.get(`/shelf/prompts?collection=${adaCollection}`))
      .body as PromptListDto;
    expect(list.items).toEqual([]);
    expect((await summary(grace)).collections).toEqual([]);
  });

  it('cannot be filled with, or emptied of, prompts', async () => {
    const gracePrompt = await createPrompt(grace, 'Mine');

    // Her prompt into Ada's collection, and Ada's prompt into her own collection.
    expect((await grace.put(`/collections/${adaCollection}/prompts/${gracePrompt}`)).status).toBe(
      404,
    );
    const graceCollection = await createCollection(grace, 'Borrowed');
    expect((await grace.put(`/collections/${graceCollection}/prompts/${adaPrompt}`)).status).toBe(
      404,
    );

    await grace.delete(`/collections/${adaCollection}/prompts/${adaPrompt}`);
    expect((await ada.get(`/prompts/${adaPrompt}/collections`)).body).toEqual({
      collectionIds: [adaCollection],
    });
  });

  it('is not reordered by an order request that names it', async () => {
    const second = await createCollection(ada, 'Second');
    await grace.put('/collections/order', { ids: [second, adaCollection] });
    expect((await summary(ada)).collections.map((c) => c.name)).toEqual(['Internal', 'Second']);
  });

  it("does not reveal which collections another user's prompt is in", async () => {
    expect((await grace.get(`/prompts/${adaPrompt}/collections`)).body).toEqual({
      collectionIds: [],
    });
  });
});
