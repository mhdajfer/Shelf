import { expect, test } from '@playwright/test';

import { seededPromptId, trackConsoleErrors } from './support/app';

test.describe('the public shelf', () => {
  test('lists the seeded prompts and raises no console errors under the CSP', async ({ page }) => {
    const errors = trackConsoleErrors(page);
    const response = await page.goto('/');

    // A nonce, and no blanket allowance for inline scripts.
    const csp = response?.headers()['content-security-policy'] ?? '';
    expect(csp).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/);
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(csp).not.toContain("'unsafe-eval'");

    await expect(page.getByRole('heading', { level: 1, name: 'The public shelf' })).toBeVisible();
    await expect(page.getByText('48 prompts')).toBeVisible();
    await expect(page.locator('article')).toHaveCount(24);
    expect(errors).toEqual([]);
  });

  test('searches, and says how many results there are', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('searchbox', { name: 'Search the public shelf' }).fill('sql');
    await page.getByRole('button', { name: 'Search' }).click();

    await expect(page).toHaveURL(/[?&]q=sql/);
    await expect(page.getByText(/results? for “sql”/)).toBeVisible();
    await expect(page.locator('article').first()).toContainText(/sql/i);
  });

  test('filters by category and sorts, as plain links', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('navigation', { name: 'Category' })
      .getByRole('link', { name: /Coding/ })
      .click();
    await expect(page).toHaveURL(/category=coding/);
    await expect(page.locator('article').first()).toContainText('Coding');

    await page.getByRole('navigation', { name: 'Sort' }).getByRole('link', { name: 'New' }).click();
    await expect(page).toHaveURL(/sort=new/);
    await expect(page).toHaveURL(/category=coding/);
  });

  test('pages through the listing', async ({ page }) => {
    await page.goto('/');
    await page
      .getByRole('navigation', { name: 'Pages' })
      .getByRole('link', { name: 'Next' })
      .click();
    await expect(page).toHaveURL(/page=2/);
    await expect(page.getByText('Page 2 of 2')).toBeVisible();
    await expect(page.locator('article')).toHaveCount(24);
  });

  test('works with JavaScript turned off', async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    await page.goto('/?q=changelog');
    await expect(page.locator('article').first()).toBeVisible();
    await page
      .getByRole('navigation', { name: 'Category' })
      .getByRole('link', { name: 'All' })
      .click();
    await expect(page.locator('article').first()).toBeVisible();
    await context.close();
  });
});

test.describe('a prompt page', () => {
  test('fills in variables and shows the result', async ({ page }) => {
    await page.goto(`/p/${await seededPromptId('&q=changelog')}`);

    const panel = page.getByRole('region', { name: 'Use this prompt' });
    const field = panel.getByRole('textbox').first();
    await field.fill('Fixed the login redirect loop.');
    await expect(panel.locator('pre')).toContainText('Fixed the login redirect loop.');
  });

  test('lets a guest upvote, once', async ({ page }) => {
    await page.goto(`/p/${await seededPromptId()}`);
    const vote = page.getByRole('button', { name: /upvote/i }).first();
    const before = Number((await vote.textContent())?.trim());

    await vote.click();
    await expect(page.getByRole('button', { name: /^Remove upvote/ }).first()).toHaveText(
      String(before + 1),
    );

    // Still counted after a reload, and attributed to this visitor.
    await page.reload();
    await expect(page.getByRole('button', { name: /^Remove upvote/ }).first()).toHaveText(
      String(before + 1),
    );
  });

  test('has a share image for a public prompt', async ({ page, request }) => {
    const id = await seededPromptId();
    await page.goto(`/p/${id}`);
    const image = await page.locator('meta[property="og:image"]').getAttribute('content');
    expect(image).toContain(`/p/${id}/opengraph-image`);

    const response = await request.get(`/p/${id}/opengraph-image`);
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toBe('image/png');
  });

  test('answers 404 for a prompt that does not exist', async ({ page }) => {
    const response = await page.goto('/p/00000000-0000-4000-8000-000000000000');
    expect(response?.status()).toBe(404);
    await expect(page.getByRole('heading', { name: 'Not on the shelf' })).toBeVisible();
  });
});

test('the sitemap lists public prompts and robots points at it', async ({ request }) => {
  const sitemap = await (await request.get('/sitemap.xml')).text();
  expect(sitemap.match(/<loc>/g)?.length).toBeGreaterThan(40);

  const robots = await (await request.get('/robots.txt')).text();
  expect(robots).toContain('Sitemap:');
  expect(robots).toContain('Disallow: /shelf');
});
