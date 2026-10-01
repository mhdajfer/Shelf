import { runMigrations } from '../migrate.js';
import { createPool } from '../pool.js';
import { DATABASE_URL, REQUIRES_TLS } from './env.js';

const pool = createPool({ connectionString: DATABASE_URL, ssl: REQUIRES_TLS, max: 1 });

try {
  await runMigrations(pool);
  console.log('migrations applied');
} catch (error) {
  console.error('migration failed');
  console.error(error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
