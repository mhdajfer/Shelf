import { afterEach, describe, expect, it } from 'vitest';

import { createPool } from './pool.js';

const LOCAL = 'postgresql://shelf:shelf@localhost:5432/shelf';

const pools: { end: () => Promise<void> }[] = [];
const build = (...args: Parameters<typeof createPool>) => {
  const pool = createPool(...args);
  pools.push(pool);
  return pool;
};

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.end()));
});

describe('createPool', () => {
  it('applies conservative defaults', () => {
    const pool = build({ connectionString: LOCAL });
    expect(pool.options.max).toBe(10);
    expect(pool.options.connectionTimeoutMillis).toBe(5_000);
  });

  it('leaves TLS off so a local docker Postgres connects', () => {
    expect(build({ connectionString: LOCAL }).options.ssl).toBeUndefined();
    expect(build({ connectionString: LOCAL, ssl: false }).options.ssl).toBeUndefined();
  });

  it('verifies the certificate when TLS is requested', () => {
    // A managed Postgres with `ssl: true` and no verification would accept any
    // certificate, which is the failure mode worth guarding here.
    expect(build({ connectionString: LOCAL, ssl: true }).options.ssl).toEqual({
      rejectUnauthorized: true,
    });
  });

  it('honours explicit overrides', () => {
    const pool = build({ connectionString: LOCAL, max: 3, connectionTimeoutMillis: 250 });
    expect(pool.options.max).toBe(3);
    expect(pool.options.connectionTimeoutMillis).toBe(250);
  });
});
