import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { collections } from './collections.js';
import { accessTokenKindEnum, grantKindEnum, oauthClientKindEnum, promptSetEnum } from './enums.js';
import { users } from './users.js';

/**
 * An MCP client known to the authorization server. Either it registered here
 * (RFC 7591), or its client ID is an HTTPS URL to its own metadata document,
 * which is fetched and cached in this row. Nothing here is verified beyond
 * that: the name is whatever the client declared.
 */
export const oauthClients = pgTable(
  'oauth_clients',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** What the client sends as `client_id`: an id issued here, or its metadata URL. */
    clientId: text('client_id').notNull(),
    kind: oauthClientKindEnum('kind').notNull(),
    name: text('name').notNull(),
    redirectUris: text('redirect_uris').array().notNull(),
    /** When a metadata document was last fetched; null for registered clients. */
    metadataFetchedAt: timestamp('metadata_fetched_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('oauth_clients_client_id_key').on(table.clientId),
    check('oauth_clients_redirect_uris_check', sql`cardinality(redirect_uris) BETWEEN 1 AND 10`),
    check(
      'oauth_clients_metadata_check',
      sql`(kind = 'metadata_document') = (metadata_fetched_at IS NOT NULL)`,
    ),
  ],
);

/**
 * Everything that lets something other than the browser act for a user: a
 * personal access token, or an app the user approved over OAuth. The MCP
 * endpoint resolves every credential to one of these and reads only the user,
 * the scopes, and the prompt set from it.
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
    /** The approved client, for an app grant. Deleting the client revokes the grant. */
    clientId: uuid('client_id').references(() => oauthClients.id, { onDelete: 'cascade' }),
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
    check('access_grants_client_check', sql`(kind = 'app') = (client_id IS NOT NULL)`),
    index('access_grants_user_idx').on(table.userId, table.createdAt.desc()),
    index('access_grants_collection_idx').on(table.collectionId),
    // Approving a client again updates its grant rather than adding a second.
    uniqueIndex('access_grants_user_client_key')
      .on(table.userId, table.clientId)
      .where(sql`kind = 'app'`),
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
    index('access_tokens_family_idx').on(table.familyId),
  ],
);

/**
 * One authorization request, from the client's redirect to the code being
 * redeemed. Pending while the user looks at the consent page; once approved it
 * carries the hash of a one-time code bound to the request's PKCE challenge,
 * redirect URI, and resource. The row outlives the code so that a second use
 * of it can be recognised and the tokens it produced revoked.
 */
export const oauthRequests = pgTable(
  'oauth_requests',
  {
    /** Also the handle the consent page is opened with. */
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: uuid('client_id')
      .notNull()
      .references(() => oauthClients.id, { onDelete: 'cascade' }),
    redirectUri: text('redirect_uri').notNull(),
    /** S256 only; the method is not stored because there is no other. */
    codeChallenge: text('code_challenge').notNull(),
    /** What the client asked for. The user may approve less. */
    scopes: text('scopes').array().notNull(),
    /** RFC 8707 resource the tokens will be bound to. */
    resource: text('resource').notNull(),
    state: text('state'),
    /** The consent page must be answered by then. */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** Set on approval: the grant the code redeems into. */
    grantId: uuid('grant_id').references(() => accessGrants.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash'),
    codeExpiresAt: timestamp('code_expires_at', { withTimezone: true }),
    /** Every token issued from this code, so a replayed code can revoke them all. */
    familyId: uuid('family_id'),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('oauth_requests_code_hash_key').on(table.codeHash),
    index('oauth_requests_expires_idx').on(table.expiresAt),
    index('oauth_requests_grant_idx').on(table.grantId),
    check(
      'oauth_requests_code_check',
      sql`(code_hash IS NULL) = (grant_id IS NULL) AND (code_hash IS NULL) = (code_expires_at IS NULL) AND (code_hash IS NULL) = (family_id IS NULL)`,
    ),
  ],
);
