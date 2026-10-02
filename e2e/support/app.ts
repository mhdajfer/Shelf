import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

import { createPool } from '@shelf/db';

import { API_URL, E2E_DATABASE_URL } from './env';

/** Direct database access, for the two things a test cannot do through the UI. */
async function sql(text: string, values: unknown[]): Promise<void> {
  const pool = createPool({ connectionString: E2E_DATABASE_URL, max: 1 });
  try {
    await pool.query(text, values);
  } finally {
    await pool.end();
  }
}

/** Stands in for clicking the emailed link, which goes to the API log offline. */
export const verifyEmail = (email: string): Promise<void> =>
  sql('UPDATE users SET email_verified_at = now() WHERE email = $1', [email]);

export const makeAdmin = (email: string): Promise<void> =>
  sql(`UPDATE users SET role = 'admin', email_verified_at = now() WHERE email = $1`, [email]);

let counter = 0;

export interface Account {
  email: string;
  password: string;
}

/** Signs up through the form and lands on the shelf. */
export async function signUp(page: Page, options: { verified?: boolean } = {}): Promise<Account> {
  counter += 1;
  const account = {
    email: `e2e-${String(Date.now())}-${String(counter)}@example.test`,
    password: 'a long enough password',
  };

  await page.goto('/sign-up');
  await page.getByLabel('Email').fill(account.email);
  await page.getByLabel('Password').fill(account.password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL('**/shelf');

  if (options.verified !== false) {
    await verifyEmail(account.email);
    await page.reload();
  }
  return account;
}

export async function signIn(page: Page, account: Account): Promise<void> {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(account.email);
  await page.getByLabel('Password').fill(account.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL('**/shelf');
}

export interface Draft {
  title: string;
  body: string;
  visibility?: 'public' | 'private';
  tags?: string;
}

/** Writes a prompt in the editor and returns its id. */
export async function createPrompt(page: Page, draft: Draft): Promise<string> {
  await page.goto('/new');
  await page.getByLabel('Title').fill(draft.title);
  await page.getByRole('textbox', { name: 'Prompt body' }).click();
  await page.keyboard.insertText(draft.body);
  await page.getByLabel('Category').selectOption('writing');
  if (draft.tags !== undefined) await page.getByLabel('Tags').fill(draft.tags);
  if (draft.visibility === 'public') await page.getByRole('radio', { name: /Public/ }).check();
  await page.getByRole('button', { name: 'Save prompt' }).click();
  await page.waitForURL(/\/p\/[0-9a-f-]{36}$/);
  return page.url().split('/').at(-1) ?? '';
}

/** The id of a seeded public prompt, straight from the API. */
export async function seededPromptId(query = ''): Promise<string> {
  const response = await fetch(`${API_URL}/api/v1/prompts?sort=top_all&limit=1${query}`);
  const list = (await response.json()) as { items: { id: string }[] };
  const id = list.items[0]?.id;
  if (id === undefined) throw new Error('the e2e database has no public prompts');
  return id;
}

/**
 * Fails on any WCAG 2.1 A or AA violation axe can detect on the current page.
 * The message names each rule and the elements it flagged, so a failure reads
 * as a to-do list rather than a JSON dump.
 */
export async function expectAccessible(page: Page): Promise<void> {
  // Next streams the document title in after the first bytes of a dynamic page.
  // Scanning before it lands reports a missing title that no reader would see.
  await expect(page).toHaveTitle(/\S/);

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();

  const summary = results.violations.map(
    (violation) =>
      `${violation.id} (${violation.impact ?? 'unknown'}): ${violation.help}\n` +
      violation.nodes.map((node) => `    ${node.target.join(' ')}`).join('\n'),
  );
  expect(summary, summary.join('\n')).toEqual([]);
}

/** Collects console errors, so a test can assert the page raised none (CSP included). */
export function trackConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(String(error)));
  return errors;
}
