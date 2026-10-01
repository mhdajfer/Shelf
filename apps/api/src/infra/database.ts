import { createDatabase, createPool, pingDatabase, requiresTls, type Database } from '@shelf/db';

import { env } from '../config/env.js';

export interface DatabaseConnection {
  db: Database;
  ping: () => Promise<boolean>;
  close: () => Promise<void>;
}

/**
 * Created once by the server entry point and passed down, rather than being a
 * module-level singleton, so tests can run without opening a connection.
 *
 * The pool itself is not exposed: which driver @shelf/db uses is its business.
 */
export function connectDatabase(): DatabaseConnection {
  const pool = createPool({
    connectionString: env.DATABASE_URL,
    ssl: requiresTls(env.DATABASE_URL),
  });

  return {
    db: createDatabase(pool),
    ping: () => pingDatabase(pool),
    close: () => pool.end(),
  };
}
