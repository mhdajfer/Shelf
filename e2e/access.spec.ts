import { expect, test, type Page } from '@playwright/test';

import { createPrompt, expectAccessible, signUp } from './support/app';
import { API_URL } from './support/env';

/** A 2025-era handshake, the simplest exchange that proves a token is accepted. */
function initialize(secret: string): Promise<Response> {
  return fetch(`${API_URL}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'e2e', version: '1' },
      },
    }),
  });
}

async function createToken(page: Page, name: string): Promise<string> {
  await page.goto('/settings');
  await page.getByLabel('Token name').fill(name);
  await page.getByRole('button', { name: 'Create token' }).click();
  const panel = page.getByRole('status').filter({ hasText: 'It will not be shown again' });
  await expect(panel).toBeVisible();
  return (await panel.locator('code').first().textContent()) ?? '';
}

test.describe('access tokens', () => {
  test('are shown once, work against /mcp, and stop working when revoked', async ({ page }) => {
    await signUp(page);
    const secret = await createToken(page, 'Work laptop');
    expect(secret).toMatch(/^shelf_pat_/);
    await expect(page.getByText(`--header "Authorization: Bearer ${secret}"`)).toBeVisible();

    const accepted = await initialize(secret);
    expect(accepted.status).toBe(200);

    // Gone after a reload; the list shows only the recognisable prefix.
    await page.reload();
    await expect(page.getByText(secret)).toHaveCount(0);
    await expect(page.getByText('Work laptop')).toBeVisible();

    await page.getByRole('button', { name: 'Revoke' }).click();
    await page.getByRole('button', { name: 'Revoke token' }).click();
    await expect(page.getByText('No tokens yet.')).toBeVisible();
    expect((await initialize(secret)).status).toBe(401);
  });

  test('the prompt page shows the owner the command to run it', async ({ page }) => {
    await signUp(page);
    await createPrompt(page, { title: 'Release notes', body: 'Summarise {{changes}}.' });
    await expect(page.getByText('/mcp__shelf__release-notes')).toBeVisible();
  });
});

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`${scheme} scheme`, () => {
    test.use({ colorScheme: scheme });

    test('the access section is accessible', async ({ page }) => {
      await signUp(page);
      await createToken(page, 'Scanner');
      await expectAccessible(page); // the one-time secret panel and the token list

      await page.getByRole('button', { name: 'Revoke' }).click();
      await expect(page.getByRole('dialog', { name: 'Revoke “Scanner”?' })).toBeVisible();
      await expectAccessible(page);
    });
  });
}
