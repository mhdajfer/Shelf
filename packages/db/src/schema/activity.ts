import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { actorTypeEnum, creditKindEnum, runStatusEnum } from './enums.js';
import { prompts, promptVersions } from './prompts.js';
import { users } from './users.js';

export const votes = pgTable(
  'votes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    promptId: uuid('prompt_id')
      .notNull()
      .references(() => prompts.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    guestId: text('guest_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('votes_single_actor_check', sql`(user_id IS NULL) <> (guest_id IS NULL)`),
    // One unique index per voter kind: a single index over both nullable columns
    // would let the same voter insert repeatedly, because NULLs never collide.
    uniqueIndex('votes_user_key')
      .on(table.promptId, table.userId)
      .where(sql`user_id IS NOT NULL`),
    uniqueIndex('votes_guest_key')
      .on(table.promptId, table.guestId)
      .where(sql`guest_id IS NOT NULL`),
  ],
);

export const runs = pgTable(
  'runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    promptVersionId: uuid('prompt_version_id')
      .notNull()
      .references(() => promptVersions.id, { onDelete: 'cascade' }),
    actorType: actorTypeEnum('actor_type').notNull(),
    actorId: text('actor_id').notNull(),
    inputs: jsonb('inputs').$type<Record<string, string>>().notNull().default({}),
    output: text('output'),
    tokensIn: integer('tokens_in'),
    tokensOut: integer('tokens_out'),
    latencyMs: integer('latency_ms'),
    status: runStatusEnum('status').notNull(),
    /** Set when status is not 'ok', for support questions after the fact. */
    errorCode: text('error_code'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('runs_version_idx').on(table.promptVersionId, table.createdAt.desc()),
    index('runs_actor_idx').on(table.actorType, table.actorId, table.createdAt.desc()),
  ],
);

/**
 * Append-only. Debits are negative, grants and refunds positive, and a balance
 * is the sum over the actor's current UTC day. A failed model call is corrected
 * with a compensating 'refund' entry rather than by deleting the debit, so the
 * attempt stays auditable. Triggers reject UPDATE and DELETE.
 */
export const creditLedger = pgTable(
  'credit_ledger',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    actorType: actorTypeEnum('actor_type').notNull(),
    actorId: text('actor_id').notNull(),
    /**
     * Guests are additionally rate-limited by address, so an entry carries both
     * identities and whichever allowance runs out first blocks the action.
     */
    ipHash: text('ip_hash'),
    kind: creditKindEnum('kind').notNull(),
    amount: integer('amount').notNull(),
    /** The debit a refund reverses. */
    refId: bigint('ref_id', { mode: 'number' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('credit_ledger_amount_nonzero_check', sql`amount <> 0`),
    index('credit_ledger_actor_idx').on(table.actorType, table.actorId, table.createdAt),
    index('credit_ledger_ip_idx')
      .on(table.ipHash, table.createdAt)
      .where(sql`ip_hash IS NOT NULL`),
    index('credit_ledger_day_idx').on(table.createdAt),
  ],
);

export const reports = pgTable(
  'reports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    promptId: uuid('prompt_id')
      .notNull()
      .references(() => prompts.id, { onDelete: 'cascade' }),
    reporterUserId: uuid('reporter_user_id').references(() => users.id, { onDelete: 'set null' }),
    reporterGuestId: text('reporter_guest_id'),
    reason: text('reason').notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedBy: uuid('resolved_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'reports_single_reporter_check',
      sql`(reporter_user_id IS NULL) <> (reporter_guest_id IS NULL)`,
    ),
    // Without these one person could trip the auto-hide threshold alone.
    uniqueIndex('reports_user_key')
      .on(table.promptId, table.reporterUserId)
      .where(sql`reporter_user_id IS NOT NULL`),
    uniqueIndex('reports_guest_key')
      .on(table.promptId, table.reporterGuestId)
      .where(sql`reporter_guest_id IS NOT NULL`),
    index('reports_open_idx')
      .on(table.createdAt)
      .where(sql`resolved_at IS NULL`),
  ],
);
