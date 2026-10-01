import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    setupFiles: ['./vitest.integration.setup.ts'],
    // Own database, so turbo can run this suite alongside @shelf/db's.
    env: { TEST_DB_SUFFIX: 'api' },
    fileParallelism: false,
    hookTimeout: 60_000,
    testTimeout: 20_000,
  },
});
