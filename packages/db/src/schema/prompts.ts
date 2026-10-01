import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { CATEGORIES, type TemplateVariable } from '@shelf/shared';

import { promptStatusEnum, tsvector, visibilityEnum } from './enums.js';
import { users } from './users.js';

const CATEGORY_LIST = CATEGORIES.map((category) => `'${category}'`).join(', ');

export const prompts = pgTable(
  'prompts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Exactly one of owner_id / guest_id is set; see the check below. */
    ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'cascade' }),
    guestId: text('guest_id'),
    /**
     * Display name for guest-authored prompts, e.g. "guest-7fk2". Stored rather
     * than derived from guest_id so the shared package stays free of crypto and
     * safe to bundle for the browser.
     */
    guestHandle: text('guest_handle'),
    visibility: visibilityEnum('visibility').notNull(),
    status: promptStatusEnum('status').notNull().default('active'),
    title: text('title').notNull(),
    description: text('description'),
    category: text('category').notNull(),
    modelHint: text('model_hint'),
    /**
     * Nullable because prompts and prompt_versions reference each other. A
     * create inserts the prompt, inserts version 1, then points at it, all in
     * one transaction.
     */
    currentVersionId: uuid('current_version_id').references((): AnyPgColumn => promptVersions.id, {
      onDelete: 'set null',
    }),
    forkedFromId: uuid('forked_from_id').references((): AnyPgColumn => prompts.id, {
      onDelete: 'set null',
    }),
    upvoteCount: integer('upvote_count').notNull().default(0),
    forkCount: integer('fork_count').notNull().default(0),
    /** Owner-only favourite marker, surfaced as "Pinned" in the sidebar. */
    pinnedAt: timestamp('pinned_at', { withTimezone: true }),
    /**
     * Recomputed on a schedule. Stored because sorting by the decay formula at
     * query time cannot use an index.
     */
    trendingScore: real('trending_score').notNull().default(0),
    /** Maintained by trigger from title, tags, description, and current body. */
    searchVector: tsvector('search_vector'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('prompts_single_actor_check', sql`(owner_id IS NULL) <> (guest_id IS NULL)`),
    check('prompts_guest_handle_check', sql`(guest_id IS NULL) = (guest_handle IS NULL)`),
    // A guest has no shelf to keep anything on, so guest content is always public.
    check('prompts_guest_is_public_check', sql`guest_id IS NULL OR visibility = 'public'`),
    check('prompts_category_check', sql.raw(`category IN (${CATEGORY_LIST})`)),

    index('prompts_search_idx').using('gin', table.searchVector),
    index('prompts_public_new_idx').on(table.visibility, table.status, table.createdAt.desc()),
    index('prompts_public_top_idx').on(table.visibility, table.status, table.upvoteCount.desc()),
    index('prompts_public_trending_idx').on(
      table.visibility,
      table.status,
      table.trendingScore.desc(),
    ),
    index('prompts_owner_idx').on(table.ownerId, table.updatedAt.desc()),
    index('prompts_guest_idx').on(table.guestId),
    index('prompts_forked_from_idx').on(table.forkedFromId),
  ],
);

export const promptVersions = pgTable(
  'prompt_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    promptId: uuid('prompt_id')
      .notNull()
      .references(() => prompts.id, { onDelete: 'cascade' }),
    number: integer('number').notNull(),
    body: text('body').notNull(),
    /** Parser output at save time, so a version renders without re-parsing. */
    variables: jsonb('variables').$type<TemplateVariable[]>().notNull().default([]),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('prompt_versions_number_key').on(table.promptId, table.number),
    index('prompt_versions_prompt_idx').on(table.promptId, table.number.desc()),
  ],
);

export const tags = pgTable(
  'tags',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Normalised to lowercase before insert. */
    name: text('name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('tags_name_key').on(table.name)],
);

export const promptTags = pgTable(
  'prompt_tags',
  {
    promptId: uuid('prompt_id')
      .notNull()
      .references(() => prompts.id, { onDelete: 'cascade' }),
    tagId: uuid('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
  },
  (table) => [
    primaryKey({ name: 'prompt_tags_pkey', columns: [table.promptId, table.tagId] }),
    index('prompt_tags_tag_idx').on(table.tagId),
  ],
);
