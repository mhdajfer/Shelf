import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';

import * as schema from './schema/index.js';

export type Database = NodePgDatabase<typeof schema>;

/**
 * The transaction handle Drizzle hands to a `db.transaction` callback. Derived
 * from Database so it cannot drift, and used wherever a repository helper must
 * work both standalone and inside a transaction.
 */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export type Executor = Database | Transaction;

export function createDatabase(pool: Pool): Database {
  return drizzle(pool, { schema });
}
