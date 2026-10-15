import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { collections } from './collections.js';
import { accessTokenKindEnum, grantKindEnum, promptSetEnum } from './enums.js';
import { users } from './users.js';

/**
 * Everything that lets something other than the browser act for a user: a
 * personal access token, or (later) an app the user approved over OAuth. The
 * MCP endpoint resolves every credential to one of these and reads only the
 * user, the scopes, and the prompt set from it.
 */
export const accessGrants = pgTable(
  'access_grants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: grantKindEnum('kind').notNull(),
    /** The token's name, or the client's name when the user approved it. */
    name: text('name').notNull(),
    scopes: text('scopes').array().notNull(),
    promptSet: promptSetEnum('prompt_set').notNull().default('all'),
    /**
     * CASCADE, not SET NULL: deleting the collection must not quietly widen the
     * grant to the whole shelf.
     */
    collectionId: uuid('collection_id').references(() => collections.id, { onDelete: 'cascade' }),
    /** Written at most every few minutes, so a busy client is not a write per call. */
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'access_grants_collection_check',
      sql`(prompt_set = 'collection') = (collection_id IS NOT NULL)`,
    ),
    check(
      'access_grants_scopes_check',
      sql`scopes <@ ARRAY['prompts:read', 'prompts:write']::text[] AND 'prompts:read' = ANY (scopes)`,
    ),
    index('access_grants_user_idx').on(table.userId, table.createdAt.desc()),
    index('access_grants_collection_idx').on(table.collectionId),
  ],
);

export const accessTokens = pgTable(
  'access_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    grantId: uuid('grant_id')
      .notNull()
      .references(() => accessGrants.id, { onDelete: 'cascade' }),
    kind: accessTokenKindEnum('kind').notNull(),
    /** SHA-256 of the secret, for the same reason as sessions.id. */
    tokenHash: text('token_hash').notNull(),
    /** The prefix and first characters, so the user can tell tokens apart. */
    display: text('display').notNull(),
    /** Refresh-token rotation: every token descended from one authorization. */
    familyId: uuid('family_id'),
    /** RFC 8707 audience the token was issued for. */
    resource: text('resource'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** Set when a refresh token is rotated; reusing it then revokes the family. */
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('access_tokens_hash_key').on(table.tokenHash),
    index('access_tokens_grant_idx').on(table.grantId),
    index('access_tokens_expires_idx').on(table.expiresAt),
  ],
);
