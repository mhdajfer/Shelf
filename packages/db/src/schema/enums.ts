import { customType, pgEnum } from 'drizzle-orm/pg-core';

export const visibilityEnum = pgEnum('visibility', ['public', 'private']);
export const promptStatusEnum = pgEnum('prompt_status', ['active', 'hidden', 'deleted']);
export const userRoleEnum = pgEnum('user_role', ['user', 'admin']);
export const actorTypeEnum = pgEnum('actor_type', ['user', 'guest']);
export const creditKindEnum = pgEnum('credit_kind', ['create', 'run', 'tool', 'refund']);
export const runStatusEnum = pgEnum('run_status', ['ok', 'error', 'timeout']);
export const emailTokenKindEnum = pgEnum('email_token_kind', ['verify_email', 'reset_password']);

/**
 * Drizzle has no native tsvector. The column is never written from application
 * code — a trigger owns it — so the TS side only needs to know it exists.
 */
export const tsvector = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'tsvector';
  },
});
