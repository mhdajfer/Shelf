import type { PromptDetailDto, PromptListDto } from '@shelf/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createApiHarness,
  signedInBrowser,
  type ApiHarness,
  type Browser,
} from './testing/harness.js';

/**
 * privacy.spec.ts asserts the rule at the repository. This asserts it again at
 * the HTTP boundary, where the actor comes from cookies and a route could, in
 * principle, pass the wrong one. Same rule: nobody but Alice can learn that her
 * private prompt exists.
 */
let harness: ApiHarness;
let alice: Browser;
let secretId: string;
let publicId: string;

const SECRET = {
  title: 'Quarterly earnings narrative',
  description: 'Internal only.',
  category: 'writing',
  body: 'Draft the narrative for {{quarter}} using {{figures}}.',
  tags: ['finance', 'internal'],
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
  alice = await signedInBrowser(harness, 'alice@example.test');

  const secret = await alice.post('/prompts', SECRET);
  secretId = (secret.body as { prompt: PromptDetailDto }).prompt.id;
  const open = await alice.post('/prompts', {
    ...SECRET,
    title: 'Summarize a changelog',
    tags: ['changelog'],
    visibility: 'public',
  });
  publicId = (open.body as { prompt: PromptDetailDto }).prompt.id;
});

async function makeAdmin(): Promise<Browser> {
  const browser = await signedInBrowser(harness, 'root@example.test');
  await harness.database.pool.query(`UPDATE users SET role = 'admin' WHERE email = $1`, [
    'root@example.test',
  ]);
  return browser;
}

const OUTSIDERS: [string, () => Promise<Browser>][] = [
  ['a visitor with no cookies', () => harness.browser()],
  ['another signed-in user', () => signedInBrowser(harness, 'bob@example.test')],
  ['an admin', makeAdmin],
  [
    'a guest who has posted',
    async () => {
      const guest = await harness.browser();
      await guest.post('/prompts', { ...SECRET, title: 'Guest post', tags: [] });
      return guest;
    },
  ],
];

const NOT_FOUND = { error: { code: 'not_found', message: 'That prompt does not exist.' } };

describe.each(OUTSIDERS)('%s', (_label, open) => {
  let outsider: Browser;
  beforeEach(async () => {
    outsider = await open();
  });

  it('gets 404, not 403, for the private prompt, identical to a prompt that never existed', async () => {
    const hidden = await outsider.get(`/prompts/${secretId}`);
    const absent = await outsider.get('/prompts/00000000-0000-4000-8000-000000000000');

    expect(hidden.status).toBe(404);
    expect(hidden.body).toEqual(NOT_FOUND);
    expect(absent.status).toBe(404);
    expect(absent.body).toEqual(hidden.body);
  });

  it('never sees it in the public listing, under any sort', async () => {
    for (const sort of ['trending', 'new', 'top_week', 'top_all']) {
      const list = (await outsider.get(`/prompts?sort=${sort}&limit=50`)).body as PromptListDto;
      const ids = list.items.map((item) => item.id);
      expect(ids).not.toContain(secretId);
      expect(ids).toContain(publicId);
    }
  });

  it('never finds it by search, by title, body, or tag', async () => {
    for (const q of ['quarterly earnings', 'narrative figures', 'internal']) {
      const list = (await outsider.get(`/prompts?q=${encodeURIComponent(q)}`))
        .body as PromptListDto;
      expect(list.items.map((item) => item.id)).not.toContain(secretId);
    }
    const tagged = (await outsider.get('/prompts?tag=internal')).body as PromptListDto;
    expect(tagged.items).toEqual([]);
    expect(tagged.total).toBe(0);
  });

  it('cannot read its versions or a diff', async () => {
    expect((await outsider.get(`/prompts/${secretId}/versions`)).status).toBe(404);
    expect((await outsider.get(`/prompts/${secretId}/diff`)).status).toBe(404);
  });

  it('cannot fork, vote on, or report it, and learns nothing from trying', async () => {
    for (const response of [
      await outsider.post(`/prompts/${secretId}/fork`),
      await outsider.put(`/prompts/${secretId}/vote`),
      await outsider.post(`/prompts/${secretId}/report`, { reason: 'I should not see this.' }),
      await outsider.get(`/prompts/${secretId}/forks`),
    ]) {
      // 401 is allowed where the route demands an account before it looks at
      // the id at all; what must never appear is a 2xx or a 403.
      expect([401, 404]).toContain(response.status);
    }
  });

  it('cannot edit or delete it', async () => {
    expect((await outsider.patch(`/prompts/${secretId}`, { title: 'x' })).status).toBe(404);
    expect((await outsider.delete(`/prompts/${secretId}`)).status).toBe(404);
  });
});

describe('the owner', () => {
  it('reads her private prompt and finds it on her shelf', async () => {
    expect((await alice.get(`/prompts/${secretId}`)).status).toBe(200);
    const shelf = (await alice.get('/shelf/prompts')).body as PromptListDto;
    expect(shelf.items.map((item) => item.id)).toEqual(
      expect.arrayContaining([secretId, publicId]),
    );
  });

  it('finds it with a shelf search, which nobody else can run against her shelf', async () => {
    const mine = (await alice.get('/shelf/prompts?q=earnings')).body as PromptListDto;
    expect(mine.items.map((item) => item.id)).toEqual([secretId]);

    const bob = await signedInBrowser(harness, 'bob@example.test');
    const theirs = (await bob.get('/shelf/prompts?q=earnings')).body as PromptListDto;
    expect(theirs.items).toEqual([]);
  });
});

describe('a signed-out visitor', () => {
  it('has no shelf to list', async () => {
    const visitor = await harness.browser();
    expect((await visitor.get('/shelf/prompts')).status).toBe(401);
  });
});
