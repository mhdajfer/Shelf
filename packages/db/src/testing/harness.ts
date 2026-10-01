import type { Pool } from 'pg';

import { createDatabase, type Database } from '../client.js';
import { runMigrations } from '../migrate.js';
import { createPool } from '../pool.js';

const DEFAULT_URL = 'postgresql://shelf:shelf@localhost:5432/shelf';

/**
 * Integration tests run against a sibling database (`shelf_test`) so a run
 * never truncates the database a developer is using.
 *
 * TEST_DB_SUFFIX gives each workspace package its own database, because turbo
 * runs the packages' suites in parallel and they truncate between cases. Within
 * a package, `fileParallelism: false` handles the same problem.
 */
export function testDatabaseUrl(baseUrl = process.env.DATABASE_URL ?? DEFAULT_URL): string {
  const url = new URL(baseUrl);
  const name = url.pathname.replace(/^\//, '') || 'shelf';
  if (name.includes('_test')) return baseUrl;

  const suffix = process.env.TEST_DB_SUFFIX;
  url.pathname = `/${name}_test${suffix === undefined || suffix === '' ? '' : `_${suffix}`}`;
  return url.toString();
}

const DUPLICATE_DATABASE = '42P04';

async function ensureDatabaseExists(url: string): Promise<void> {
  const target = new URL(url);
  const name = target.pathname.replace(/^\//, '');

  const maintenance = new URL(url);
  maintenance.pathname = '/postgres';

  const pool = createPool({ connectionString: maintenance.toString(), max: 1 });
  try {
    // The identifier comes from our own URL, not from user input.
    await pool.query(`CREATE DATABASE "${name}"`);
  } catch (error) {
    if ((error as { code?: string }).code !== DUPLICATE_DATABASE) throw error;
  } finally {
    await pool.end();
  }
}

export interface TestDatabase {
  db: Database;
  pool: Pool;
  truncate: () => Promise<void>;
  close: () => Promise<void>;
}

export async function createTestDatabase(baseUrl?: string): Promise<TestDatabase> {
  const url = testDatabaseUrl(baseUrl);
  await ensureDatabaseExists(url);

  const pool = createPool({ connectionString: url, max: 4 });
  await runMigrations(pool);

  const { rows } = await pool.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
  );
  const tableList = rows.map((row) => `"${row.tablename}"`).join(', ');

  return {
    db: createDatabase(pool),
    pool,
    /**
     * TRUNCATE rather than DELETE: the credit ledger has a trigger that rejects
     * row deletes, and TRUNCATE does not fire row-level triggers.
     */
    truncate: async () => {
      if (tableList === '') return;
      await pool.query(`TRUNCATE TABLE ${tableList} RESTART IDENTITY CASCADE`);
    },
    close: () => pool.end(),
  };
}
