import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

import { createPrompt, makeAdmin, signUp, type Account } from './support/app';

/**
 * The privacy rule, in a real browser against the production build: nobody but
 * the owner can learn that a private prompt exists, on any page or asset.
 * privacy.spec.ts and privacy.http.spec.ts assert it at the repository and at
 * the API; this closes the loop over the web app's own routes.
 */
const TITLE = 'Quarterly earnings narrative';

let ownerContext: BrowserContext;
let owner: Page;
let secretId: string;

test.beforeAll(async ({ browser }) => {
  ownerContext = await browser.newContext();
  owner = await ownerContext.newPage();
  await signUp(owner);
  secretId = await createPrompt(owner, {
    title: TITLE,
    body: 'Draft the narrative for {{quarter}} using {{figures}}.',
    tags: 'finance, internal',
  });
});

test.afterAll(async () => {
  await ownerContext.close();
});

type Outsider = (browser: Browser) => Promise<{ context: BrowserContext; page: Page }>;

async function fresh(browser: Browser) {
  const context = await browser.newContext();
  return { context, page: await context.newPage() };
}

const OUTSIDERS: [string, Outsider][] = [
  ['a signed-out visitor', fresh],
  [
    'another signed-in user',
    async (browser) => {
      const outsider = await fresh(browser);
      await signUp(outsider.page);
      return outsider;
    },
  ],
  [
    'an admin',
    async (browser) => {
      const outsider = await fresh(browser);
      const account: Account = await signUp(outsider.page);
      await makeAdmin(account.email);
      await outsider.page.reload();
      return outsider;
    },
  ],
];

test('the owner sees the prompt, marked private', async () => {
  await owner.goto(`/p/${secretId}`);
  await expect(owner.getByRole('heading', { level: 1, name: TITLE })).toBeVisible();
  await expect(owner.getByText('Private', { exact: false }).first()).toBeVisible();
});

for (const [label, open] of OUTSIDERS) {
  test.describe(label, () => {
    let context: BrowserContext;
    let page: Page;

    test.beforeAll(async ({ browser }) => {
      ({ context, page } = await open(browser));
    });
    test.afterAll(async () => {
      await context.close();
    });

    test('gets a 404 for the page, its editor, and its history', async () => {
      for (const path of ['', '/edit', '/history']) {
        const response = await page.goto(`/p/${secretId}${path}`);
        expect(response?.status(), `/p/:id${path}`).toBe(404);
        await expect(page.getByRole('heading', { name: 'Not on the shelf' })).toBeVisible();
        expect(await page.content()).not.toContain(TITLE);
      }
    });

    test('gets a 404 for the share image', async () => {
      const response = await page.request.get(`/p/${secretId}/opengraph-image`);
      expect(response.status()).toBe(404);
    });

    test('cannot download it as Markdown', async () => {
      const response = await page.request.get(
        `http://localhost:4100/api/v1/prompts/${secretId}/export`,
      );
      expect(response.status()).toBe(404);
    });

    test('does not find it by search, in the library or the command palette', async () => {
      await page.goto('/?q=quarterly+earnings');
      await expect(page.getByText('0 results')).toBeVisible();
      expect(await page.content()).not.toContain(TITLE);

      await page.keyboard.press('Control+k');
      await page.getByPlaceholder('Search prompts, or type a command').fill('quarterly earnings');
      await expect(page.getByText('Nothing matches that.')).toBeVisible();
    });

    test('does not find it in the sitemap', async () => {
      const sitemap = await (await page.request.get('/sitemap.xml')).text();
      expect(sitemap).not.toContain(secretId);
    });
  });
}

test("the owner's share image is refused too, because share images are public", async () => {
  // Crawlers and chat apps cache these, so one must never exist for a private
  // prompt, whoever asks.
  const response = await owner.request.get(`/p/${secretId}/opengraph-image`);
  expect(response.status()).toBe(404);
});
