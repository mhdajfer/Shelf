import { fileURLToPath } from 'node:url';

import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Pool } from 'pg';

import { createDatabase } from './client.js';

/** Resolved relative to this module so it works from dist and from source. */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../migrations', import.meta.url));

export async function runMigrations(pool: Pool): Promise<void> {
  await migrate(createDatabase(pool), { migrationsFolder: MIGRATIONS_FOLDER });
}
