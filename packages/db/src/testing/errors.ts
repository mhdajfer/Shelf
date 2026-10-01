export interface DatabaseError {
  message: string;
  /** Set for constraint violations: the exact constraint that rejected the row. */
  constraint: string | undefined;
  /** Postgres SQLSTATE, e.g. 23514 for a check violation. */
  code: string | undefined;
}

type PgErrorShape = Error & { constraint?: string; code?: string };

const isPgError = (value: unknown): value is PgErrorShape =>
  value instanceof Error &&
  ((value as PgErrorShape).code !== undefined || (value as PgErrorShape).constraint !== undefined);

/**
 * Drizzle wraps driver failures, so the constraint name sits on `cause` rather
 * than on the thrown error. Walking the chain lets a test assert the exact
 * constraint instead of pattern-matching a wrapper message.
 */
export async function captureDatabaseError(run: () => Promise<unknown>): Promise<DatabaseError> {
  try {
    await run();
  } catch (thrown) {
    let current: unknown = thrown;
    while (current instanceof Error) {
      if (isPgError(current)) {
        return { message: current.message, constraint: current.constraint, code: current.code };
      }
      current = current.cause;
    }
    const error = thrown as Error;
    return { message: error.message, constraint: undefined, code: undefined };
  }

  throw new Error('Expected the query to fail, but it succeeded.');
}

/** SQLSTATE codes the schema relies on. */
export const SQLSTATE = {
  restrictViolation: '23001',
  uniqueViolation: '23505',
  checkViolation: '23514',
} as const;
