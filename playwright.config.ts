import { defineConfig, devices } from '@playwright/test';

import { API_URL, E2E_DATABASE_URL, WEB_URL } from './e2e/support/env';

const CI = Boolean(process.env.CI);

/**
 * The suite starts its own API and web server on their own ports, against its
 * own database, so it never touches development data and does not care what
 * else is running.
 *
 * The web app is a production build: the nonce CSP, the cross-origin API calls
 * and the shared cookie are the production paths, and those are what a browser
 * test is for. The API runs offline (fake model, console email) with the rate
 * limiters off, so the suite is deterministic and costs nothing.
 */
export default defineConfig({
  testDir: './e2e',
  // One worker, in file order: the tests share a database and a guest
  // allowance keyed on the machine's address.
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: CI ? 1 : 0,
  forbidOnly: CI,
  reporter: CI ? [['github'], ['html', { open: 'never' }]] : 'list',

  use: {
    baseURL: WEB_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // CI installs Playwright's own Chromium. Locally, PLAYWRIGHT_CHANNEL=msedge
        // or =chrome uses a browser that is already on the machine.
        ...(process.env.PLAYWRIGHT_CHANNEL === undefined
          ? {}
          : { channel: process.env.PLAYWRIGHT_CHANNEL }),
      },
    },
  ],

  webServer: [
    {
      // Creates, migrates and seeds the e2e database, then starts the API on it.
      command:
        'pnpm --filter @shelf/shared --filter @shelf/db build && node e2e/support/prepare-db.mjs && pnpm --filter @shelf/api exec tsx src/index.ts',
      url: `${API_URL}/api/v1/health`,
      timeout: 180_000,
      reuseExistingServer: false,
      stdout: 'ignore',
      env: {
        NODE_ENV: 'development',
        API_PORT: new URL(API_URL).port,
        DATABASE_URL: E2E_DATABASE_URL,
        PUBLIC_WEB_URL: WEB_URL,
        PUBLIC_API_URL: API_URL,
        CORS_ALLOWED_ORIGINS: WEB_URL,
        OFFLINE_MODE: 'true',
        RATE_LIMIT_DISABLED: 'true',
        LOG_LEVEL: 'warn',
      },
    },
    {
      command:
        'pnpm --filter @shelf/config build && pnpm --filter @shelf/web exec next build && pnpm --filter @shelf/web exec next start -p ' +
        new URL(WEB_URL).port,
      url: WEB_URL,
      timeout: 300_000,
      reuseExistingServer: false,
      stdout: 'ignore',
      env: {
        // The repo's .env sets NODE_ENV=development for the API. A Next build
        // under any value but "production" bundles development React and fails.
        NODE_ENV: 'production',
        NEXT_DIST_DIR: '.next-e2e',
        PUBLIC_WEB_URL: WEB_URL,
        PUBLIC_API_URL: API_URL,
      },
    },
  ],
});
