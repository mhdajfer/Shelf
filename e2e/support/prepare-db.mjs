// Run by Playwright before the API starts: makes sure the e2e database exists,
// migrates it, and reseeds it, so every run begins from the same shelf with a
// clean credit ledger.
import { spawnSync } from 'node:child_process';

import { createPool, runMigrations } from '@shelf/db';

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined || !new URL(databaseUrl).pathname.includes('e2e')) {
  // The seed truncates every table. It must never be pointed anywhere else.
  throw new Error(`Refusing to prepare "${databaseUrl ?? ''}": not an e2e database.`);
}

const name = new URL(databaseUrl).pathname.slice(1);
const maintenanceUrl = new URL(databaseUrl);
maintenanceUrl.pathname = '/postgres';

const maintenance = createPool({ connectionString: maintenanceUrl.toString(), max: 1 });
try {
  await maintenance.query(`CREATE DATABASE "${name}"`);
} catch (error) {
  if (error.code !== '42P04') throw error; // 42P04: it already exists
} finally {
  await maintenance.end();
}

const pool = createPool({ connectionString: databaseUrl, max: 1 });
try {
  await runMigrations(pool);
} finally {
  await pool.end();
}

const seed = spawnSync('pnpm --filter @shelf/db run seed', {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, DATABASE_URL: databaseUrl, NODE_ENV: 'development' },
});
if (seed.status !== 0) process.exit(seed.status ?? 1);
