import { Pool } from 'pg';

export interface PoolOptions {
  connectionString: string;
  /** Neon and Upstash terminate TLS; a local docker Postgres does not. */
  ssl?: boolean;
  max?: number;
  /** Fail fast rather than queueing behind an unreachable database. */
  connectionTimeoutMillis?: number;
}

export function createPool(options: PoolOptions): Pool {
  return new Pool({
    connectionString: options.connectionString,
    max: options.max ?? 10,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 5_000,
    ...(options.ssl === true ? { ssl: { rejectUnauthorized: true } } : {}),
  });
}

/** Backs the database half of /api/v1/health. */
export async function pingDatabase(pool: Pool): Promise<boolean> {
  try {
    await pool.query('select 1');
    return true;
  } catch {
    return false;
  }
}
