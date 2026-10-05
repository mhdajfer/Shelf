const UNIQUE_VIOLATION = '23505';

type PgErrorShape = Error & { constraint?: string; code?: string };

/**
 * The constraint name when `error` is a unique violation, otherwise null.
 *
 * Drizzle wraps driver failures, so the Postgres fields sit on `cause`. Callers
 * use the name to turn a race-safe insert into a specific message ("that email
 * is already registered") without a check-then-insert window.
 */
export function uniqueViolation(error: unknown): string | null {
  let current: unknown = error;
  while (current instanceof Error) {
    const pg = current as PgErrorShape;
    if (pg.code === UNIQUE_VIOLATION) return pg.constraint ?? '';
    current = current.cause;
  }
  return null;
}
