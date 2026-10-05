import type {
  AdminOverviewDto,
  ImportResultDto,
  PromptDetailDto,
  PromptListDto,
  PromptVersionDto,
  ReportedPromptDto,
  ShelfExport,
  ShelfSummaryDto,
} from '@shelf/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createApiHarness,
  signedInBrowser,
  type ApiHarness,
  type Browser,
} from './testing/harness.js';

let harness: ApiHarness;
let ada: Browser;

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

async function create(browser: Browser, overrides: object = {}): Promise<string> {
  const response = await browser.post('/prompts', {
    title: 'Summarize a changelog',
    category: 'writing',
    body: 'Summarize {{changelog}}.',
    ...overrides,
  });
  return (response.body as { prompt: PromptDetailDto }).prompt.id;
}

const exportOf = async (browser: Browser): Promise<ShelfExport> =>
  (await browser.get('/export')).body as ShelfExport;

describe('export', () => {
  it('contains the whole shelf with its history, tags, pins, and collections', async () => {
    const id = await create(ada, { tags: ['release-notes'], description: 'Notes from a log.' });
    await ada.patch(`/prompts/${id}`, {
      body: 'Summarize {{changelog}} briefly.',
      note: 'Shorter',
    });
    await ada.patch(`/prompts/${id}`, { pinned: true });
    const collection = (
      (await ada.post('/collections', { name: 'Work' })).body as { collection: { id: string } }
    ).collection.id;
    await ada.put(`/collections/${collection}/prompts/${id}`);

    const response = await ada.get('/export');
    expect(response.headers['content-disposition']).toMatch(/attachment; filename="shelf-export-/);

    const file = response.body as ShelfExport;
    expect(file).toMatchObject({ format: 'shelf-export', version: 1 });
    expect(file.prompts).toHaveLength(1);
    expect(file.prompts[0]).toMatchObject({
      title: 'Summarize a changelog',
      description: 'Notes from a log.',
      visibility: 'private',
      pinned: true,
      tags: ['release-notes'],
      collections: ['Work'],
    });
    expect(file.prompts[0]?.versions.map((version) => [version.number, version.note])).toEqual([
      [1, null],
      [2, 'Shorter'],
    ]);
  });

  it("never contains another user's prompts, public or private", async () => {
    await create(ada, { title: 'Ada private' });
    await create(ada, { title: 'Ada public', visibility: 'public' });

    const grace = await signedInBrowser(harness, 'grace@example.test');
    await create(grace, { title: 'Grace only' });

    const titles = (await exportOf(grace)).prompts.map((prompt) => prompt.title);
    expect(titles).toEqual(['Grace only']);
  });

  it('leaves out deleted prompts, and requires an account', async () => {
    const id = await create(ada);
    await ada.delete(`/prompts/${id}`);
    expect((await exportOf(ada)).prompts).toEqual([]);

    const visitor = await harness.browser();
    expect((await visitor.get('/export')).status).toBe(401);
  });

  it('exports one readable prompt as Markdown, fenced safely', async () => {
    const id = await create(ada, {
      visibility: 'public',
      body: 'Wrap the answer in ```json fences.\n{{input}}',
    });
    const visitor = await harness.browser();
    const response = await visitor.get(`/prompts/${id}/export`);

    expect(response.headers['content-type']).toMatch(/text\/markdown/);
    expect(response.headers['content-disposition']).toMatch(/summarize-a-changelog\.md/);
    // A four-backtick fence, because the body contains a run of three.
    expect(response.text).toContain('````text\nWrap the answer in ```json fences.');
  });

  it('refuses to export a prompt the actor cannot read, as a 404', async () => {
    const secret = await create(ada, { title: 'Internal' });
    const grace = await signedInBrowser(harness, 'grace@example.test');
    const visitor = await harness.browser();

    for (const outsider of [grace, visitor]) {
      const response = await outsider.get(`/prompts/${secret}/export`);
      expect(response.status).toBe(404);
      expect(response.text).not.toContain('Internal');
    }
  });
});

describe('import', () => {
  it('round-trips an export into another account, as private prompts with history', async () => {
    const id = await create(ada, { visibility: 'public', tags: ['sql'] });
    await ada.patch(`/prompts/${id}`, {
      body: 'Summarize {{changelog}} briefly.',
      note: 'Shorter',
    });
    const collection = (
      (await ada.post('/collections', { name: 'Work' })).body as { collection: { id: string } }
    ).collection.id;
    await ada.put(`/collections/${collection}/prompts/${id}`);
    const file = await exportOf(ada);

    const grace = await signedInBrowser(harness, 'grace@example.test');
    const response = await grace.post('/import', file);
    expect(response.status).toBe(201);
    expect(response.body).toEqual({ imported: 1, skipped: [] });

    const shelf = (await grace.get('/shelf/prompts')).body as PromptListDto;
    expect(shelf.items).toHaveLength(1);
    // Public in the file, private on arrival.
    expect(shelf.items[0]).toMatchObject({
      visibility: 'private',
      versionNumber: 2,
      tags: ['sql'],
      body: 'Summarize {{changelog}} briefly.',
    });

    const versions = (
      (await grace.get(`/prompts/${shelf.items[0]?.id ?? ''}/versions`)).body as {
        versions: PromptVersionDto[];
      }
    ).versions;
    expect(versions.map((version) => version.note)).toEqual(['Shorter', null]);

    const summary = (await grace.get('/shelf/summary')).body as ShelfSummaryDto;
    expect(summary.collections.map((c) => [c.name, c.itemCount])).toEqual([['Work', 1]]);
  });

  it('skips a malformed entry and imports the rest, saying which and why', async () => {
    const response = await ada.post('/import', {
      format: 'shelf-export',
      version: 1,
      prompts: [
        { title: 'Good', category: 'coding', versions: [{ body: 'Explain {{code}}.' }] },
        { title: 'No body', versions: [{ body: '   ' }] },
        { versions: [{ body: 'No title.' }] },
        {
          title: 'Odd metadata',
          category: 'astrology',
          tags: ['OK', 'not valid!', 7],
          versions: [{ body: 'Hi.' }],
        },
      ],
    });

    const result = response.body as ImportResultDto;
    expect(result.imported).toBe(2);
    expect(result.skipped.map((entry) => [entry.index, entry.title])).toEqual([
      [1, 'No body'],
      [2, null],
    ]);

    const shelf = (await ada.get('/shelf/prompts')).body as PromptListDto;
    const odd = shelf.items.find((item) => item.title === 'Odd metadata');
    expect(odd).toMatchObject({ category: 'other', tags: ['ok'] });
  });

  it('rejects a file that is not a Shelf export', async () => {
    const response = await ada.post('/import', { prompts: [{ title: 'x' }] });
    expect(response.status).toBe(400);
  });

  it('accepts a file larger than the ordinary request limit', async () => {
    const body = 'x'.repeat(15_000);
    const response = await ada.post('/import', {
      format: 'shelf-export',
      version: 1,
      prompts: Array.from({ length: 12 }, (_, index) => ({
        title: `Large ${String(index)}`,
        versions: [{ body }],
      })),
    });
    expect((response.body as ImportResultDto).imported).toBe(12);
  });
});

describe('moderation', () => {
  const reason = { reason: 'This is spam and links to a scam site.' };

  async function makeAdmin(): Promise<Browser> {
    const browser = await signedInBrowser(harness, 'root@example.test');
    await harness.database.pool.query(`UPDATE users SET role = 'admin' WHERE email = $1`, [
      'root@example.test',
    ]);
    return browser;
  }

  async function reportThreeTimes(promptId: string): Promise<void> {
    for (const email of ['r1@example.test', 'r2@example.test', 'r3@example.test']) {
      const reporter = await signedInBrowser(harness, email);
      await reporter.post(`/prompts/${promptId}/report`, reason);
    }
  }

  it('does not exist for a non-admin', async () => {
    const visitor = await harness.browser();
    for (const browser of [ada, visitor]) {
      const expected = browser === ada ? 404 : 401;
      expect((await browser.get('/admin/reports')).status).toBe(expected);
      expect((await browser.get('/admin/overview')).status).toBe(expected);
    }
  });

  it('queues a reported prompt, and restores it to the shelf', async () => {
    const promptId = await create(ada, { visibility: 'public' });
    await reportThreeTimes(promptId);
    const admin = await makeAdmin();

    const { reports } = (await admin.get('/admin/reports')).body as {
      reports: ReportedPromptDto[];
    };
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ promptId, status: 'hidden', openReports: 3 });

    // The moderator can open the hidden prompt to judge it.
    expect((await admin.get(`/prompts/${promptId}`)).status).toBe(200);

    await admin.post(`/admin/reports/${promptId}/resolve`, { action: 'restore' });
    const visitor = await harness.browser();
    expect((await visitor.get(`/prompts/${promptId}`)).status).toBe(200);
    expect(
      ((await admin.get('/admin/reports')).body as { reports: ReportedPromptDto[] }).reports,
    ).toEqual([]);
  });

  it('removes a prompt for good', async () => {
    const promptId = await create(ada, { visibility: 'public' });
    await reportThreeTimes(promptId);
    const admin = await makeAdmin();

    await admin.post(`/admin/reports/${promptId}/resolve`, { action: 'remove' });
    expect((await ada.get(`/prompts/${promptId}`)).status).toBe(404);
  });

  it('cannot be used to touch a private prompt', async () => {
    const secret = await create(ada, { title: 'Internal' });
    const admin = await makeAdmin();
    const response = await admin.post(`/admin/reports/${secret}/resolve`, { action: 'remove' });
    expect(response.status).toBe(404);
    expect((await ada.get(`/prompts/${secret}`)).status).toBe(200);
  });

  it('reports headline counts', async () => {
    await create(ada, { visibility: 'public' });
    await create(ada);
    const admin = await makeAdmin();
    const { overview } = (await admin.get('/admin/overview')).body as {
      overview: AdminOverviewDto;
    };
    expect(overview).toMatchObject({ publicPrompts: 1, privatePrompts: 1, openReports: 0 });
    expect(overview.users).toBe(2);
  });
});

describe('deleting an account', () => {
  it('needs the password, then removes the account and everything it owned', async () => {
    const promptId = await create(ada, { visibility: 'public' });

    const wrong = await ada.post('/auth/delete-account', { password: 'not it' });
    expect(wrong.status).toBe(400);

    const right = await ada.post('/auth/delete-account', { password: 'correct horse battery' });
    expect(right.status).toBe(200);

    const visitor = await harness.browser();
    expect((await visitor.get(`/prompts/${promptId}`)).status).toBe(404);
    expect((await visitor.get('/users/ada')).status).toBe(404);
    expect(
      (
        await visitor.post('/auth/login', {
          email: 'ada@example.test',
          password: 'correct horse battery',
        })
      ).status,
    ).toBe(401);
  });
});
