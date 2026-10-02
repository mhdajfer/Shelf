import { expect, test } from '@playwright/test';

import { createPrompt, signIn, signUp } from './support/app';

test.describe('signing up and keeping a shelf', () => {
  test('shows field errors, then creates the account and lands on an empty shelf', async ({
    page,
  }) => {
    await page.goto('/sign-up');
    await page.getByLabel('Email').fill('not-an-email');
    await page.getByLabel('Password').fill('short');
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByText('Enter a valid email address.')).toBeVisible();
    await expect(page.getByText('Use at least 8 characters.')).toBeVisible();

    await signUp(page, { verified: false });
    await expect(page.getByText('Your shelf is empty.')).toBeVisible();
    await expect(page.getByText('Confirm your email address to publish')).toBeVisible();
  });

  test('signs out and back in', async ({ page }) => {
    const account = await signUp(page);
    await page.getByRole('button', { name: 'Account menu' }).click();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
    await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();

    // The shelf sends a signed-out visitor to sign in, and back afterwards.
    await page.goto('/shelf');
    await expect(page).toHaveURL(/\/sign-in\?next=%2Fshelf/);
    await signIn(page, account);
    await expect(page.getByRole('heading', { name: 'All prompts' })).toBeVisible();
  });

  test('refuses a wrong password without saying which part was wrong', async ({ page }) => {
    const account = await signUp(page);
    await page.context().clearCookies();
    await page.goto('/sign-in');
    await page.getByLabel('Email').fill(account.email);
    await page.getByLabel('Password').fill('definitely not it');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    // Next's route announcer is also role="alert", so match on the text.
    await expect(
      page.getByRole('alert').filter({ hasText: 'Email or password is incorrect.' }),
    ).toBeVisible();
  });
});

test.describe('the life of a prompt', () => {
  test('write, edit into a second version, compare, restore, pin, file, delete', async ({
    page,
  }) => {
    await signUp(page);

    // Write. The editor marks variables and flags a malformed one as it is typed.
    await page.goto('/new');
    await page.getByLabel('Title').fill('Release notes from a changelog');
    await page.getByRole('textbox', { name: 'Prompt body' }).click();
    await page.keyboard.insertText(
      'Summarize {{changelog}} for a {{audience:general}} reader. {{bad name}}',
    );
    await expect(page.locator('.cm-content .shelf-variable')).toHaveCount(2);
    await expect(page.getByText('"bad name" is not a valid variable name.')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Variables' })).toContainText('audience');
    await expect(page.getByRole('region', { name: 'Variables' })).toContainText(
      'default "general"',
    );

    await page.getByLabel('Category').selectOption('writing');
    await page.getByLabel('Tags').fill('release-notes, Changelog');
    await page.getByRole('button', { name: 'Save prompt' }).click();
    await page.waitForURL(/\/p\/[0-9a-f-]{36}$/);
    const promptUrl = page.url();
    await expect(page.getByText('Version 1', { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: '#changelog' })).toBeVisible();

    // Edit: Ctrl+S saves, and a changed body becomes version 2 with its note.
    await page.getByRole('link', { name: 'Edit' }).click();
    await page.getByRole('textbox', { name: 'Prompt body' }).click();
    await page.keyboard.press('Control+End');
    await page.keyboard.insertText('\nUse plain language.');
    await page.getByLabel('What changed?').fill('Ask for plain language');
    await page.keyboard.press('Control+s');
    await page.waitForURL(promptUrl);
    await expect(page.getByText('Version 2', { exact: true })).toBeVisible();

    // History: the diff shows exactly the added line.
    await page.getByRole('link', { name: 'History' }).click();
    await expect(page.getByText('Ask for plain language')).toBeVisible();
    await expect(page.getByText('1 line added, 0 removed')).toBeVisible();

    // Restore appends rather than rewinds.
    await page.getByRole('button', { name: /^Version 1/ }).click();
    await page.getByRole('button', { name: 'Restore version 1' }).click();
    await expect(page.getByRole('button', { name: /^Version 3/ })).toContainText(
      'Restored version 1',
    );

    // Pin it and file it in a new collection.
    await page.goto(promptUrl);
    await page.getByRole('button', { name: 'Pin', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Unpin' })).toBeVisible();

    await page.goto('/shelf');
    await page.getByRole('button', { name: 'New collection' }).click();
    await page.getByLabel('Name').fill('Drafts');
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page.getByText('This collection is empty.')).toBeVisible();

    await page.goto(promptUrl);
    await page.getByRole('button', { name: 'Collections' }).click();
    await page.getByRole('menuitemcheckbox', { name: 'Drafts' }).click();
    await page.keyboard.press('Escape');

    await page.goto('/shelf');
    const sidebar = page.getByRole('navigation', { name: 'Shelf' });
    await expect(sidebar.getByRole('link', { name: /Pinned/ })).toContainText('1');
    await sidebar.getByRole('link', { name: /Drafts/ }).click();
    await expect(page.locator('article')).toHaveCount(1);

    // Shelf search reads the current body.
    await page.getByRole('searchbox', { name: 'Search your shelf' }).fill('changelog');
    await expect(page).toHaveURL(/q=changelog/);
    await expect(page.locator('article')).toHaveCount(1);

    // Delete, with a confirmation that says what goes.
    await page.goto(promptUrl);
    await page.getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByRole('dialog')).toContainText('its 3 versions');
    await page.getByRole('button', { name: 'Delete prompt' }).click();
    await page.waitForURL('**/shelf');
    await expect(page.getByText('Your shelf is empty.')).toBeVisible();
  });

  test('an unverified account can save privately but not publish', async ({ page }) => {
    await signUp(page, { verified: false });
    await page.goto('/new');
    await page.getByLabel('Title').fill('Not yet public');
    await page.getByRole('textbox', { name: 'Prompt body' }).click();
    await page.keyboard.insertText('Summarize {{text}}.');
    await page.getByLabel('Category').selectOption('writing');
    await page.getByRole('radio', { name: /Public/ }).check();
    await page.getByRole('button', { name: 'Save prompt' }).click();
    await expect(
      page.getByRole('alert').filter({ hasText: 'Confirm your email address' }),
    ).toBeVisible();

    await page.getByRole('radio', { name: /Private/ }).check();
    await page.getByRole('button', { name: 'Save prompt' }).click();
    await page.waitForURL(/\/p\/[0-9a-f-]{36}$/);
  });

  test('forking copies a public prompt into the editor, private', async ({ page, browser }) => {
    await signUp(page);
    const id = await createPrompt(page, {
      title: 'Forkable',
      body: 'Explain {{topic}} simply.',
      visibility: 'public',
    });

    const other = await browser.newContext();
    const visitor = await other.newPage();
    await signUp(visitor);
    await visitor.goto(`/p/${id}`);
    await visitor.getByRole('button', { name: 'Fork' }).click();
    await visitor.waitForURL(/\/p\/[0-9a-f-]{36}\/edit$/);
    await expect(visitor.getByLabel('Title')).toHaveValue('Forkable');
    await expect(visitor.getByRole('radio', { name: /Private/ })).toBeChecked();

    // On the fork's own page there is no Fork button: it is already theirs, and
    // forking it again is how a shelf used to fill with copies.
    await visitor.goto(visitor.url().replace(/\/edit$/, ''));
    await expect(visitor.getByRole('link', { name: 'Edit' })).toBeVisible();
    await expect(visitor.getByRole('button', { name: 'Fork', exact: true })).toHaveCount(0);

    // Back on the original there is nothing left to fork: the button now leads
    // to the copy, so the same prompt cannot land on a shelf twice.
    await visitor.goto(`/p/${id}`);
    await expect(visitor.getByRole('button', { name: 'Fork', exact: true })).toHaveCount(0);
    await expect(visitor.getByRole('link', { name: 'Your fork' })).toBeVisible();

    // Reverting removes the copy and brings the Fork button back.
    await visitor.getByRole('button', { name: 'Remove fork' }).click();
    await visitor.getByRole('dialog').getByRole('button', { name: 'Remove fork' }).click();
    await expect(visitor.getByRole('button', { name: 'Fork', exact: true })).toBeVisible();
    await visitor.goto('/shelf');
    await expect(visitor.getByText('Your shelf is empty.')).toBeVisible();
    await other.close();

    await page.reload();
    await expect(page.getByText('1 public fork')).toHaveCount(0); // the fork is private
  });
});

test.describe('guests', () => {
  test('can post publicly on an allowance that is shown up front', async ({ page }) => {
    await page.goto('/new');
    await expect(page.getByText(/You are posting as a guest\..*3 of 3 left today/)).toBeVisible();
    await expect(page.getByRole('radio', { name: /Private/ })).toHaveCount(0);

    await page.getByLabel('Title').fill('A guest contribution');
    await page.getByRole('textbox', { name: 'Prompt body' }).click();
    await page.keyboard.insertText('Rewrite {{sentence}} in the active voice.');
    await page.getByLabel('Category').selectOption('writing');
    await page.getByRole('button', { name: 'Save prompt' }).click();
    await page.waitForURL(/\/p\/[0-9a-f-]{36}$/);

    await expect(page.getByText(/By Guest guest-[0-9a-f]{4}/)).toBeVisible();
    await expect(page.getByRole('link', { name: 'Edit' })).toBeVisible();

    await page.goto('/new');
    await expect(page.getByText(/2 of 3 left today/)).toBeVisible();
  });
});
