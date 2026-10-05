// The repo's .env supplies DATABASE_URL (and the port a local Postgres runs
// on). It is optional: CI sets the variable itself.
try {
  process.loadEnvFile('.env');
} catch {
  // No .env file. The defaults below match docker-compose.yml.
}

export const WEB_URL = 'http://localhost:3100';
export const API_URL = 'http://localhost:4100';

const base = process.env.DATABASE_URL ?? 'postgresql://shelf:shelf@localhost:5432/shelf';

/** A sibling of the development database, recreated at the start of every run. */
export const E2E_DATABASE_URL = (() => {
  const url = new URL(base);
  url.pathname = '/shelf_e2e';
  return url.toString();
})();
