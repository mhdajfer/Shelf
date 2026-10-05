import { expect, test } from '@playwright/test';

import { createPrompt, seededPromptId, signUp } from './support/app';

// The suite's API runs with OFFLINE_MODE, so every answer comes from the
// built-in fake model: deterministic, free, and streamed like a real one.

test('a guest runs a public prompt and watches the answer stream in', async ({ page }) => {
  await page.goto(`/p/${await seededPromptId()}`);
  const panel = page.getByRole('region', { name: 'Use this prompt' });

  await expect(panel.getByText('5 of 5 test runs left today')).toBeVisible();
  await expect(panel.getByText('answers here are simulated')).toBeVisible();

  // A prompt with holes in it is not sent.
  const run = panel.getByRole('button', { name: 'Run', exact: true });
  for (const field of await panel.getByRole('textbox').all()) {
    if ((await field.inputValue()) === '') {
      await expect(run).toBeDisabled();
      await field.fill('The login page redirects in a loop after a password reset.');
    }
  }
  await expect(run).toBeEnabled();
  await run.click();

  await expect(panel.getByText('This is a simulated response.')).toBeVisible();
  await expect(panel.getByText(/tokens in, \d+ out · shelf-fake-1/)).toBeVisible();
  await expect(panel.getByText('4 of 5 test runs left today')).toBeVisible();

  // The run is in this visitor's history after a reload.
  await page.reload();
  await page.getByText('Your earlier runs (1)').click();
  await expect(page.getByText('The login page redirects in a loop')).toBeVisible();
});

test('the editor tightens a prompt and offers suggestions', async ({ page }) => {
  await signUp(page);
  await page.goto('/new');
  await page.getByRole('textbox', { name: 'Prompt body' }).click();
  await page.keyboard.insertText('Please   summarize {{notes}} really carefully.');

  await page.getByRole('button', { name: 'Tighten' }).click();
  const dialog = page.getByRole('dialog', { name: 'Tightened version' });
  await expect(dialog).toContainText('summarize {{notes}} carefully.');
  await dialog.getByRole('button', { name: 'Use this version' }).click();
  await expect(page.getByRole('textbox', { name: 'Prompt body' })).toHaveText(
    'summarize {{notes}} carefully.',
  );

  await page.getByRole('button', { name: 'Suggest improvements' }).click();
  const suggestions = page.getByRole('region', { name: 'Suggestions' });
  await expect(suggestions.getByRole('listitem')).toHaveCount(3);
  await expect(page.getByText('48 of 50 test runs left today')).toBeVisible();
});

test('two versions are run side by side on the same input', async ({ page }) => {
  await signUp(page);
  const id = await createPrompt(page, { title: 'Compare me', body: 'Summarize {{notes}}.' });

  await page.getByRole('link', { name: 'Edit' }).click();
  await page.getByRole('textbox', { name: 'Prompt body' }).click();
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText(' Use bullet points.');
  await page.keyboard.press('Control+s');
  await page.waitForURL(`**/p/${id}`);

  await page.goto(`/p/${id}/history`);
  const compare = page.getByRole('region', { name: 'Compare the answers' });
  await expect(compare.getByRole('button', { name: 'Run both versions' })).toBeDisabled();
  await compare.getByRole('textbox').fill('Standup notes from Tuesday.');
  await compare.getByRole('button', { name: 'Run both versions' }).click();

  await expect(compare.getByText(/^Version 1 · /)).toBeVisible();
  await expect(compare.getByText(/^Version 2 · /)).toBeVisible();
  // Each side quotes the prompt it was sent, so the two answers differ.
  const answers = compare.locator('.shelf-prose');
  await expect(answers.filter({ hasText: 'Standup notes from Tuesday.' })).toHaveCount(2);
  await expect(answers.filter({ hasText: 'Use bullet points.' })).toHaveCount(1);
});
