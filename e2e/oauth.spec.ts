import { createHash, randomBytes } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';

import { expectAccessible, signUp } from './support/app';
import { API_URL } from './support/env';

/**
 * An MCP client connecting through the browser: what `claude mcp add` followed
 * by "Authenticate" does. The client's half (registration, PKCE, the token
 * request) is done here with plain requests; the user's half is the real
 * consent page in a real browser.
 */
const REDIRECT = 'http://127.0.0.1:43110/callback';
const ISSUER = new URL(API_URL).origin;

interface PendingClient {
  clientId: string;
  verifier: string;
  authorizeUrl: string;
}

async function startClient(name = 'E2E client'): Promise<PendingClient> {
  const registered = await fetch(`${API_URL}/api/v1/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: name, redirect_uris: [REDIRECT] }),
  });
  expect(registered.status).toBe(201);
  const { client_id: clientId } = (await registered.json()) as { client_id: string };

  const verifier = randomBytes(32).toString('base64url');
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    resource: `${API_URL}/mcp`,
    scope: 'prompts:read prompts:write',
    state: 'e2e-state',
  });
  return { clientId, verifier, authorizeUrl: `${API_URL}/api/v1/oauth/authorize?${query}` };
}

/** Stands in for the client's loopback listener, and reports where the browser was sent. */
async function catchRedirect(page: Page): Promise<() => URL | undefined> {
  let caught: URL | undefined;
  await page.route(`${new URL(REDIRECT).origin}/**`, async (route) => {
    caught = new URL(route.request().url());
    await route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><title>Connected</title><p>Connected. Return to your terminal.</p>',
    });
  });
  return () => caught;
}

async function redeem(client: PendingClient, code: string): Promise<string> {
  const response = await fetch(`${API_URL}/api/v1/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client.clientId,
      redirect_uri: REDIRECT,
      code_verifier: client.verifier,
      code,
      resource: `${API_URL}/mcp`,
    }),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { access_token: string }).access_token;
}

/** A 2025-era handshake, the simplest exchange that proves a token is accepted. */
function initialize(token: string): Promise<Response> {
  return fetch(`${API_URL}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
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

test.describe('connecting an MCP client', () => {
  test('is approved on the consent page and disconnected from Settings', async ({ page }) => {
    await signUp(page);
    const client = await startClient();
    const redirected = await catchRedirect(page);

    await page.goto(client.authorizeUrl);
    await expect(page.getByRole('heading', { name: 'Connect an app to your shelf' })).toBeVisible();
    await expect(page.getByText('E2E client', { exact: true })).toBeVisible();
    await expect(page.getByText('Shelf has not verified this app')).toBeVisible();
    await expect(page.getByText('an app on this computer')).toBeVisible();
    await page.getByRole('button', { name: 'Approve' }).click();

    await expect.poll(() => redirected()?.searchParams.get('code') ?? null).not.toBeNull();
    const back = redirected() ?? new URL(REDIRECT);
    expect(back.searchParams.get('iss')).toBe(ISSUER);
    expect(back.searchParams.get('state')).toBe('e2e-state');

    const token = await redeem(client, back.searchParams.get('code') ?? '');
    expect((await initialize(token)).status).toBe(200);

    await page.goto('/settings');
    await expect(page.getByText('E2E client')).toBeVisible();
    await page.getByRole('button', { name: 'Disconnect' }).click();
    await page
      .getByRole('dialog', { name: 'Disconnect “E2E client”?' })
      .getByRole('button', { name: 'Disconnect' })
      .click();
    await expect(page.getByText('No apps yet.', { exact: false })).toBeVisible();
    expect((await initialize(token)).status).toBe(401);
  });

  test('sends a signed-out user through sign-in and back, and reports a denial', async ({
    page,
  }) => {
    const account = await signUp(page);
    await page.context().clearCookies();
    const client = await startClient('Second client');
    const redirected = await catchRedirect(page);

    await page.goto(client.authorizeUrl);
    await page.waitForURL('**/sign-in?next=*');
    await page.getByLabel('Email').fill(account.email);
    await page.getByLabel('Password').fill(account.password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();

    await expect(page.getByText('Second client', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Deny' }).click();
    await expect.poll(() => redirected()?.searchParams.get('error') ?? null).toBe('access_denied');
    expect(redirected()?.searchParams.has('code')).toBe(false);
  });

  test('explains a request from an app Shelf does not know', async ({ page }) => {
    await signUp(page);
    await page.goto(
      `${API_URL}/api/v1/oauth/authorize?client_id=00000000-0000-4000-8000-000000000000&redirect_uri=${encodeURIComponent(REDIRECT)}`,
    );
    await expect(page.getByRole('heading', { name: 'This app cannot connect' })).toBeVisible();
  });
});

test('the setup guide gives each client its own instructions', async ({ page }) => {
  await page.goto('/docs/mcp');
  await expect(page.getByRole('heading', { name: 'Connect an MCP client' })).toBeVisible();
  await expect(
    page.getByText(`claude mcp add --transport http --scope user shelf ${API_URL}/mcp`, {
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole('tab', { name: 'Codex CLI' }).click();
  await expect(page.getByText('codex mcp login shelf', { exact: false })).toBeVisible();
});

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`${scheme} scheme`, () => {
    test.use({ colorScheme: scheme });

    test('the setup guide is accessible', async ({ page }) => {
      await page.goto('/docs/mcp');
      await expectAccessible(page);
      await page.getByRole('tab', { name: 'VS Code' }).click();
      await page.getByText('No browser where it runs? Use an access token').click();
      await expectAccessible(page);
    });

    test('the consent page and connected apps are accessible', async ({ page }) => {
      await signUp(page);
      const client = await startClient('Scanner');
      const redirected = await catchRedirect(page);

      await page.goto(client.authorizeUrl);
      await expect(page.getByText('Scanner', { exact: true })).toBeVisible();
      await expectAccessible(page);

      await page.getByRole('button', { name: 'Approve' }).click();
      await expect.poll(() => redirected()?.searchParams.get('code') ?? null).not.toBeNull();
      await redeem(client, redirected()?.searchParams.get('code') ?? '');

      await page.goto('/settings');
      await expect(page.getByText('Scanner')).toBeVisible();
      await expectAccessible(page);
      await page.getByRole('button', { name: 'Disconnect' }).click();
      await expect(page.getByRole('dialog', { name: 'Disconnect “Scanner”?' })).toBeVisible();
      await expectAccessible(page);
    });
  });
}
