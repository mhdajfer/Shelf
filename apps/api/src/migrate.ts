import { createPool, requiresTls, runMigrations } from '@shelf/db';

import { env } from './config/env.js';
import { logger } from './observability/logger.js';

/**
 * Applies pending migrations, then exits. The container runs this before the
 * server starts. Migrations are forward-only and recorded in the database, so
 * a second instance booting at the same time finds nothing left to do.
 */
const pool = createPool({
  connectionString: env.DATABASE_URL,
  ssl: requiresTls(env.DATABASE_URL),
  max: 1,
});

try {
  await runMigrations(pool);
  logger.info('migrations applied');
} catch (error) {
  logger.fatal({ err: error }, 'migration failed');
  process.exitCode = 1;
} finally {
  await pool.end();
}
