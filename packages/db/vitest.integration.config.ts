import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    setupFiles: ['./vitest.integration.setup.ts'],
    // Own database, so turbo can run this package's suite alongside the API's.
    env: { TEST_DB_SUFFIX: 'db' },
    /**
     * Every file shares one test database and truncates between cases, so
     * running files in parallel would have them clearing each other's fixtures.
     */
    fileParallelism: false,
    hookTimeout: 60_000,
    testTimeout: 20_000,
  },
});
