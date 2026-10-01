import { resolve } from 'node:path';

import { config as loadDotenv } from 'dotenv';
import { defineConfig } from 'drizzle-kit';

loadDotenv({ path: [resolve(process.cwd(), '../../.env')], quiet: true });

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './migrations',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgresql://shelf:shelf@localhost:5432/shelf',
  },
  strict: true,
  verbose: true,
});
