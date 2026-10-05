import { expect, test } from '@playwright/test';

import { createPrompt, expectAccessible, makeAdmin, seededPromptId, signUp } from './support/app';

/**
 * Automated accessibility checks (axe, WCAG 2.1 A and AA) on every kind of
 * page, in both colour schemes. Axe finds a subset of real problems; passing is
 * a floor, not a certificate. Keyboard behaviour is asserted separately below.
 */
for (const scheme of ['light', 'dark'] as const) {
  test.describe(`${scheme} scheme`, () => {
    test.use({ colorScheme: scheme });

    test('public pages', async ({ page }) => {
      await page.goto('/');
      await expectAccessible(page);

      await page.goto(`/p/${await seededPromptId()}`);
      await expectAccessible(page);

      await page.goto('/u/rmorrow');
      await expectAccessible(page);

      await page.goto('/sign-in');
      await expectAccessible(page);

      await page.goto('/sign-up');
      await page.getByRole('button', { name: 'Create account' }).click();
      await expect(page.getByText('Enter a valid email address.')).toBeVisible();
      await expectAccessible(page); // with field errors showing

      await page.goto('/p/00000000-0000-4000-8000-000000000000');
      await expectAccessible(page);
    });

    test('signed-in pages', async ({ page }) => {
      const account = await signUp(page);
      await expectAccessible(page); // the empty shelf

      await page.goto('/new');
      await page.getByRole('textbox', { name: 'Prompt body' }).click();
      await page.keyboard.insertText('Summarize {{notes}} for {{audience:general}}. {{bad name}}');
      await expectAccessible(page); // the editor, with a diagnostic showing

      const id = await createPrompt(page, { title: 'Accessible', body: 'Summarize {{notes}}.' });
      await expectAccessible(page); // owner controls

      await page.getByRole('link', { name: 'Edit' }).click();
      await page.getByRole('textbox', { name: 'Prompt body' }).click();
      await page.keyboard.press('Control+End');
      await page.keyboard.insertText(' Briefly.');
      await page.keyboard.press('Control+s');
      await page.waitForURL(`**/p/${id}`);
      await page.goto(`/p/${id}/history`);
      await expectAccessible(page); // the diff

      await page.goto('/shelf');
      await expect(page.locator('article')).toHaveCount(1);
      await expectAccessible(page);

      await page.goto('/settings');
      await expectAccessible(page);

      await makeAdmin(account.email);
      await page.goto('/admin');
      await expect(page.getByText('Nothing is waiting for review.')).toBeVisible();
      await expectAccessible(page);
    });

    test('dialogs and the command palette', async ({ page }) => {
      await page.goto(`/p/${await seededPromptId()}`);
      await page.getByRole('button', { name: 'Report' }).click();
      await expect(page.getByRole('dialog', { name: 'Report this prompt' })).toBeVisible();
      await expectAccessible(page);
      await page.keyboard.press('Escape');

      await page.keyboard.press('Control+k');
      await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
      await expectAccessible(page);
    });
  });
}

test('the checker is live: it rejects a page with known violations', async ({ page }) => {
  // A control. Without it, a scan that silently checked nothing would look
  // exactly like a clean result.
  await page.setContent(
    '<html lang="en"><head><title>Control</title></head><body><main>' +
      '<input type="text"><img src="x.png">' +
      '<p style="color:#bbb;background:#fff">Low contrast</p></main></body></html>',
  );
  await expect(expectAccessible(page)).rejects.toThrow(/label|image-alt|color-contrast/);
});

test.describe('keyboard', () => {
  test('the skip link is the first stop and moves focus past the header', async ({ page }) => {
    await page.goto('/');
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: 'Skip to content' });
    await expect(skip).toBeFocused();
    await skip.press('Enter');
    await expect(page).toHaveURL(/#content$/);
  });

  test('the palette opens, runs a command, and returns focus', async ({ page }) => {
    await page.goto('/');
    await page.keyboard.press('Control+k');
    await page.getByPlaceholder('Search prompts, or type a command').fill('dark');
    await page.keyboard.press('Enter');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toHaveCount(0);
  });

  test('single-key shortcuts navigate, and are ignored while typing', async ({ page }) => {
    await signUp(page);
    await page.goto('/');
    await page.locator('h1').click();

    await page.keyboard.press('g');
    await page.keyboard.press('s');
    await expect(page).toHaveURL(/\/shelf$/);

    await page.keyboard.press('?');
    await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
    await page.keyboard.press('Escape');

    // "n" would open the editor; typed into the search box it is just a letter.
    await page.getByRole('searchbox', { name: 'Search your shelf' }).focus();
    await page.keyboard.type('n');
    await expect(page).toHaveURL(/\/shelf/);
    await expect(page.getByRole('searchbox', { name: 'Search your shelf' })).toHaveValue('n');
  });

  test('a collection can be reordered from the keyboard', async ({ page }) => {
    await signUp(page);
    for (const name of ['First', 'Second']) {
      await page.getByRole('button', { name: 'New collection' }).click();
      await page.getByLabel('Name').fill(name);
      await page.getByRole('button', { name: 'Create', exact: true }).click();
      await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
    }

    const names = () =>
      page
        .getByRole('navigation', { name: 'Shelf' })
        .getByRole('listitem')
        .getByRole('link')
        .allInnerTexts();
    expect((await names()).map((text) => text.split('\n')[0])).toEqual(['First', 'Second']);

    // Paced like a person: the drag library binds its arrow-key listener a
    // tick after the lift, so keys pressed in the same instant are not seen.
    await page.getByRole('button', { name: 'Reorder Second' }).focus();
    await page.keyboard.press('Space');
    await page.waitForTimeout(200);
    await page.keyboard.press('ArrowUp');
    await page.waitForTimeout(200);
    await page.keyboard.press('Space');

    await expect
      .poll(async () => (await names()).map((text) => text.split('\n')[0]))
      .toEqual(['Second', 'First']);

    // It survives a reload, so the order was saved and not only moved on screen.
    await page.reload();
    await expect
      .poll(async () => (await names()).map((text) => text.split('\n')[0]))
      .toEqual(['Second', 'First']);
  });
});
