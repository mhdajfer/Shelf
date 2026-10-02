import { and, asc, desc, eq, inArray, type SQL, sql } from 'drizzle-orm';

import {
  TRENDING,
  type Category,
  type PromptStatus,
  type PublicSort,
  type TemplateVariable,
  type Visibility,
} from '@shelf/shared';

import type { Database, Executor } from '../client.js';
import { promptTags, promptVersions, prompts, tags } from '../schema/prompts.js';
import { users } from '../schema/users.js';
import type { Actor } from './actor.js';

export interface PromptAuthor {
  kind: 'user' | 'guest';
  handle: string;
  name: string | null;
}

export interface PromptSummary {
  id: string;
  title: string;
  description: string | null;
  category: string;
  modelHint: string | null;
  visibility: Visibility;
  status: PromptStatus;
  body: string;
  variables: TemplateVariable[];
  versionNumber: number;
  currentVersionId: string | null;
  tags: string[];
  upvoteCount: number;
  forkCount: number;
  forkedFromId: string | null;
  trendingScore: number;
  pinnedAt: Date | null;
  author: PromptAuthor;
  createdAt: Date;
  updatedAt: Date;
}

export interface PromptVersionRecord {
  id: string;
  promptId: string;
  number: number;
  body: string;
  variables: TemplateVariable[];
  note: string | null;
  createdAt: Date;
}

export const MAX_PAGE_SIZE = 50;

/**
 * THE visibility rule. Every read in this module composes this predicate, and
 * nothing outside this package can reach the prompts table, so a route cannot
 * accidentally skip it.
 *
 * Private prompts are visible to their owner and to nobody else — admins
 * included. The admin clause widens access only to public prompts that
 * moderation has hidden, which is the entire scope of /admin/reports.
 */
function readableBy(actor: Actor): SQL {
  const publicActive = sql`(${prompts.visibility} = 'public' AND ${prompts.status} = 'active')`;

  switch (actor.type) {
    case 'anonymous':
      return publicActive;

    case 'guest':
      return sql`(${publicActive} OR (${prompts.guestId} = ${actor.guestId} AND ${prompts.status} <> 'deleted'))`;

    case 'user':
      return actor.role === 'admin'
        ? sql`(${publicActive}
            OR (${prompts.ownerId} = ${actor.userId} AND ${prompts.status} <> 'deleted')
            OR (${prompts.visibility} = 'public' AND ${prompts.status} = 'hidden'))`
        : sql`(${publicActive} OR (${prompts.ownerId} = ${actor.userId} AND ${prompts.status} <> 'deleted'))`;
  }
}

/** Public listings never widen beyond this, regardless of who is asking. */
const PUBLIC_ONLY = sql`(${prompts.visibility} = 'public' AND ${prompts.status} = 'active')`;

const tagNames = sql<string[]>`coalesce((
  SELECT array_agg(t.name ORDER BY t.name)
  FROM prompt_tags pt
  JOIN tags t ON t.id = pt.tag_id
  WHERE pt.prompt_id = ${prompts.id}
), ARRAY[]::text[])`;

const summaryColumns = {
  id: prompts.id,
  title: prompts.title,
  description: prompts.description,
  category: prompts.category,
  modelHint: prompts.modelHint,
  visibility: prompts.visibility,
  status: prompts.status,
  currentVersionId: prompts.currentVersionId,
  forkedFromId: prompts.forkedFromId,
  upvoteCount: prompts.upvoteCount,
  forkCount: prompts.forkCount,
  trendingScore: prompts.trendingScore,
  pinnedAt: prompts.pinnedAt,
  createdAt: prompts.createdAt,
  updatedAt: prompts.updatedAt,
  guestHandle: prompts.guestHandle,
  ownerHandle: users.handle,
  ownerName: users.name,
  versionNumber: promptVersions.number,
  body: promptVersions.body,
  variables: promptVersions.variables,
  tags: tagNames,
};

const baseSelect = (db: Executor) =>
  db
    .select(summaryColumns)
    .from(prompts)
    .leftJoin(promptVersions, eq(promptVersions.id, prompts.currentVersionId))
    .leftJoin(users, eq(users.id, prompts.ownerId));

/** Inferred from the query itself, so adding a column cannot desync the mapper. */
type SummaryRow = Awaited<ReturnType<typeof baseSelect>>[number];

function toSummary(row: SummaryRow): PromptSummary {
  const author: PromptAuthor =
    row.ownerHandle === null
      ? { kind: 'guest', handle: row.guestHandle ?? 'guest', name: null }
      : { kind: 'user', handle: row.ownerHandle, name: row.ownerName };

  return {
    id: row.id,
    title: row.title,
    description: row.description,
    category: row.category,
    modelHint: row.modelHint,
    visibility: row.visibility,
    status: row.status,
    body: row.body ?? '',
    variables: row.variables ?? [],
    versionNumber: row.versionNumber ?? 0,
    currentVersionId: row.currentVersionId,
    tags: row.tags,
    upvoteCount: row.upvoteCount,
    forkCount: row.forkCount,
    forkedFromId: row.forkedFromId,
    trendingScore: row.trendingScore,
    pinnedAt: row.pinnedAt,
    author,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export interface PublicListOptions {
  sort?: PublicSort;
  category?: Category;
  tags?: string[];
  modelHint?: string;
  /** Restricts to one signed-up author, for their public profile. */
  authorHandle?: string;
  limit?: number;
  offset?: number;
}

export interface OwnedListOptions {
  limit?: number;
  offset?: number;
  pinnedOnly?: boolean;
  collectionId?: string;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return 20;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_PAGE_SIZE);
}

/** One EXISTS per tag, so a filter means "has all of these". */
function tagFilters(names: string[]): SQL[] {
  return names.map(
    (name) => sql`EXISTS (
      SELECT 1 FROM prompt_tags pt
      JOIN tags t ON t.id = pt.tag_id
      WHERE pt.prompt_id = ${prompts.id} AND t.name = ${name.toLowerCase()}
    )`,
  );
}

function publicFilters(options: PublicListOptions): SQL[] {
  const clauses: SQL[] = [PUBLIC_ONLY];
  if (options.category !== undefined) clauses.push(sql`${prompts.category} = ${options.category}`);
  if (options.modelHint !== undefined && options.modelHint.trim() !== '') {
    clauses.push(sql`${prompts.modelHint} ILIKE ${`%${options.modelHint.trim()}%`}`);
  }
  if (options.authorHandle !== undefined) {
    clauses.push(sql`${users.handle} = ${options.authorHandle.toLowerCase()}`);
  }
  clauses.push(...tagFilters(options.tags ?? []));
  return clauses;
}

function publicOrdering(sort: PublicSort): SQL[] {
  switch (sort) {
    case 'trending':
      return [desc(prompts.trendingScore), desc(prompts.createdAt)];
    case 'new':
      return [desc(prompts.createdAt)];
    case 'top_week':
    case 'top_all':
      return [desc(prompts.upvoteCount), desc(prompts.createdAt)];
  }
}

async function findVisible(db: Database, actor: Actor, id: string): Promise<PromptSummary | null> {
  const rows = await baseSelect(db)
    .where(and(sql`${prompts.id} = ${id}`, readableBy(actor)))
    .limit(1);
  const row = rows[0];
  return row === undefined ? null : toSummary(row);
}

async function listPublic(db: Database, options: PublicListOptions = {}): Promise<PromptSummary[]> {
  const sort = options.sort ?? 'trending';
  const clauses = publicFilters(options);
  if (sort === 'top_week') {
    clauses.push(sql`${prompts.createdAt} > now() - interval '7 days'`);
  }

  const rows = await baseSelect(db)
    .where(and(...clauses))
    .orderBy(...publicOrdering(sort))
    .limit(clampLimit(options.limit))
    .offset(options.offset ?? 0);

  return rows.map(toSummary);
}

export interface SearchOptions extends PublicListOptions {
  query: string;
}

/**
 * websearch_to_tsquery rather than plainto_tsquery: it accepts quoted phrases
 * and `-exclusion` without throwing on punctuation a user might type.
 */
const matchQuery = (query: string): SQL =>
  sql`${prompts.searchVector} @@ websearch_to_tsquery('english', ${query})`;

const matchRank = (query: string): SQL<number> =>
  sql<number>`ts_rank_cd(${prompts.searchVector}, websearch_to_tsquery('english', ${query}))`;

async function searchPublic(db: Database, options: SearchOptions): Promise<PromptSummary[]> {
  const query = options.query.trim();
  if (query === '') return [];

  const rows = await baseSelect(db)
    .where(and(...publicFilters(options), matchQuery(query)))
    .orderBy(desc(matchRank(query)), desc(prompts.upvoteCount))
    .limit(clampLimit(options.limit))
    .offset(options.offset ?? 0);

  return rows.map(toSummary);
}

/** Empty for anyone who is not a signed-in user: guests have no shelf. */
async function listOwned(
  db: Database,
  actor: Actor,
  options: OwnedListOptions = {},
): Promise<PromptSummary[]> {
  if (actor.type !== 'user') return [];

  const clauses: SQL[] = [
    sql`${prompts.ownerId} = ${actor.userId}`,
    sql`${prompts.status} <> 'deleted'`,
  ];
  if (options.pinnedOnly === true) clauses.push(sql`${prompts.pinnedAt} IS NOT NULL`);
  if (options.collectionId !== undefined) {
    clauses.push(sql`EXISTS (
      SELECT 1 FROM collection_items ci
      JOIN collections c ON c.id = ci.collection_id
      WHERE ci.prompt_id = ${prompts.id}
        AND ci.collection_id = ${options.collectionId}
        AND c.owner_id = ${actor.userId}
    )`);
  }

  const rows = await baseSelect(db)
    .where(and(...clauses))
    .orderBy(desc(prompts.updatedAt))
    .limit(clampLimit(options.limit))
    .offset(options.offset ?? 0);

  return rows.map(toSummary);
}

async function searchOwned(
  db: Database,
  actor: Actor,
  options: { query: string; limit?: number; offset?: number },
): Promise<PromptSummary[]> {
  if (actor.type !== 'user') return [];
  const query = options.query.trim();
  if (query === '') return [];

  const rows = await baseSelect(db)
    .where(
      and(
        sql`${prompts.ownerId} = ${actor.userId}`,
        sql`${prompts.status} <> 'deleted'`,
        matchQuery(query),
      ),
    )
    .orderBy(desc(matchRank(query)), desc(prompts.updatedAt))
    .limit(clampLimit(options.limit))
    .offset(options.offset ?? 0);

  return rows.map(toSummary);
}

/**
 * Null when the prompt is not readable, so callers return 404 rather than
 * distinguishing "absent" from "someone else's".
 */
async function listVersions(
  db: Database,
  actor: Actor,
  promptId: string,
): Promise<PromptVersionRecord[] | null> {
  if ((await findVisible(db, actor, promptId)) === null) return null;

  return db
    .select({
      id: promptVersions.id,
      promptId: promptVersions.promptId,
      number: promptVersions.number,
      body: promptVersions.body,
      variables: promptVersions.variables,
      note: promptVersions.note,
      createdAt: promptVersions.createdAt,
    })
    .from(promptVersions)
    .where(eq(promptVersions.promptId, promptId))
    .orderBy(desc(promptVersions.number));
}

async function findVersion(
  db: Database,
  actor: Actor,
  promptId: string,
  versionId: string,
): Promise<PromptVersionRecord | null> {
  const versions = await listVersions(db, actor, promptId);
  return versions?.find((version) => version.id === versionId) ?? null;
}

/** Forks are only listed when they are public; private forks stay invisible. */
async function listForks(db: Database, promptId: string, limit = 20): Promise<PromptSummary[]> {
  const rows = await baseSelect(db)
    .where(and(PUBLIC_ONLY, sql`${prompts.forkedFromId} = ${promptId}`))
    .orderBy(desc(prompts.createdAt))
    .limit(clampLimit(limit));
  return rows.map(toSummary);
}

async function countOwned(db: Database, userId: string): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(prompts)
    .where(and(eq(prompts.ownerId, userId), sql`${prompts.status} <> 'deleted'`));
  return rows[0]?.count ?? 0;
}

export interface CreatePromptInput {
  author:
    { type: 'user'; userId: string } | { type: 'guest'; guestId: string; guestHandle: string };
  visibility: Visibility;
  title: string;
  description?: string | null;
  category: Category;
  modelHint?: string | null;
  body: string;
  variables: TemplateVariable[];
  tags?: string[];
  forkedFromId?: string | null;
  note?: string | null;
}

async function replaceTags(db: Executor, promptId: string, names: string[]): Promise<void> {
  const normalised = [
    ...new Set(names.map((name) => name.trim().toLowerCase()).filter(Boolean)),
  ].sort();

  const current = await db
    .select({ name: tags.name })
    .from(promptTags)
    .innerJoin(tags, eq(tags.id, promptTags.tagId))
    .where(eq(promptTags.promptId, promptId))
    .orderBy(asc(tags.name));

  // Rewriting an unchanged set would still fire the triggers that refresh the
  // search vector and bump updated_at.
  if (
    current.length === normalised.length &&
    current.every((tag, index) => tag.name === normalised[index])
  ) {
    return;
  }

  await db.delete(promptTags).where(eq(promptTags.promptId, promptId));
  if (normalised.length === 0) return;

  const inserted = await db
    .insert(tags)
    .values(normalised.map((name) => ({ name })))
    .onConflictDoNothing({ target: tags.name })
    .returning({ id: tags.id, name: tags.name });

  // onConflictDoNothing returns no row for a name that already existed.
  const missing = normalised.filter((name) => !inserted.some((tag) => tag.name === name));
  const existing =
    missing.length === 0
      ? []
      : await db
          .select({ id: tags.id, name: tags.name })
          .from(tags)
          .where(inArray(tags.name, missing));

  await db
    .insert(promptTags)
    .values([...inserted, ...existing].map((tag) => ({ promptId, tagId: tag.id })))
    .onConflictDoNothing();
}

/**
 * The prompt row and version 1 reference each other, so both inserts and the
 * back-pointer happen in one transaction. A crash halfway cannot leave a prompt
 * with no body.
 */
async function create(db: Database, input: CreatePromptInput): Promise<string> {
  return db.transaction(async (tx) => {
    const [prompt] = await tx
      .insert(prompts)
      .values({
        ownerId: input.author.type === 'user' ? input.author.userId : null,
        guestId: input.author.type === 'guest' ? input.author.guestId : null,
        guestHandle: input.author.type === 'guest' ? input.author.guestHandle : null,
        visibility: input.visibility,
        title: input.title,
        description: input.description ?? null,
        category: input.category,
        modelHint: input.modelHint ?? null,
        forkedFromId: input.forkedFromId ?? null,
      })
      .returning({ id: prompts.id });

    if (prompt === undefined) throw new Error('prompt insert returned no row');

    const [version] = await tx
      .insert(promptVersions)
      .values({
        promptId: prompt.id,
        number: 1,
        body: input.body,
        variables: input.variables,
        note: input.note ?? null,
      })
      .returning({ id: promptVersions.id });

    if (version === undefined) throw new Error('version insert returned no row');

    await tx.update(prompts).set({ currentVersionId: version.id }).where(eq(prompts.id, prompt.id));

    await replaceTags(tx, prompt.id, input.tags ?? []);

    if (input.forkedFromId != null) {
      await tx
        .update(prompts)
        .set({ forkCount: sql`${prompts.forkCount} + 1` })
        .where(eq(prompts.id, input.forkedFromId));
    }

    return prompt.id;
  });
}

export interface AddVersionInput {
  body: string;
  variables: TemplateVariable[];
  note?: string | null;
}

async function addVersion(
  db: Database,
  promptId: string,
  input: AddVersionInput,
): Promise<PromptVersionRecord> {
  return db.transaction(async (tx) => {
    const [last] = await tx
      .select({ number: promptVersions.number })
      .from(promptVersions)
      .where(eq(promptVersions.promptId, promptId))
      .orderBy(desc(promptVersions.number))
      .limit(1);

    const [version] = await tx
      .insert(promptVersions)
      .values({
        promptId,
        number: (last?.number ?? 0) + 1,
        body: input.body,
        variables: input.variables,
        note: input.note ?? null,
      })
      .returning();

    if (version === undefined) throw new Error('version insert returned no row');

    await tx.update(prompts).set({ currentVersionId: version.id }).where(eq(prompts.id, promptId));

    return version;
  });
}

/** The actor's own prompts, as a predicate. Null for an actor who can own nothing. */
function ownedBy(actor: Actor): SQL | null {
  switch (actor.type) {
    case 'user':
      return sql`${prompts.ownerId} = ${actor.userId}`;
    case 'guest':
      return sql`${prompts.guestId} = ${actor.guestId}`;
    case 'anonymous':
      return null;
  }
}

/**
 * The prompt, but only if the actor wrote it. Every write path starts here, so
 * "can read" never quietly becomes "can edit". An admin is not an owner.
 */
async function findOwned(db: Database, actor: Actor, id: string): Promise<PromptSummary | null> {
  const owner = ownedBy(actor);
  if (owner === null) return null;

  const rows = await baseSelect(db)
    .where(and(sql`${prompts.id} = ${id}`, owner, sql`${prompts.status} <> 'deleted'`))
    .limit(1);
  const row = rows[0];
  return row === undefined ? null : toSummary(row);
}

export interface ViewerState {
  isOwner: boolean;
  hasVoted: boolean;
}

/** What the listed prompts are to this actor, in one query for the whole page. */
async function viewerStates(
  db: Database,
  actor: Actor,
  ids: string[],
): Promise<Map<string, ViewerState>> {
  const states = new Map<string, ViewerState>();
  if (ids.length === 0 || actor.type === 'anonymous') return states;

  const owner = ownedBy(actor) ?? sql`false`;
  const voter =
    actor.type === 'user' ? sql`v.user_id = ${actor.userId}` : sql`v.guest_id = ${actor.guestId}`;

  // Drizzle leaves column names unqualified in a single-table select, so the
  // correlated subquery names the outer table explicitly; a bare "id" inside it
  // would resolve to votes.id.
  const rows = await db
    .select({
      id: prompts.id,
      isOwner: sql<boolean>`${owner}`,
      hasVoted: sql<boolean>`EXISTS (
        SELECT 1 FROM votes v WHERE v.prompt_id = "prompts"."id" AND ${voter}
      )`,
    })
    .from(prompts)
    .where(inArray(prompts.id, ids));

  for (const row of rows) states.set(row.id, { isOwner: row.isOwner, hasVoted: row.hasVoted });
  return states;
}

async function countPublic(db: Database, options: PublicListOptions = {}): Promise<number> {
  const clauses = publicFilters(options);
  if (options.sort === 'top_week') {
    clauses.push(sql`${prompts.createdAt} > now() - interval '7 days'`);
  }
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(prompts)
    .leftJoin(users, eq(users.id, prompts.ownerId))
    .where(and(...clauses));
  return rows[0]?.count ?? 0;
}

async function countSearchPublic(db: Database, options: SearchOptions): Promise<number> {
  const query = options.query.trim();
  if (query === '') return 0;
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(prompts)
    .leftJoin(users, eq(users.id, prompts.ownerId))
    .where(and(...publicFilters(options), matchQuery(query)));
  return rows[0]?.count ?? 0;
}

export interface UpdatePromptInput {
  title?: string;
  description?: string | null;
  category?: Category;
  modelHint?: string | null;
  visibility?: Visibility;
  pinned?: boolean;
  tags?: string[];
}

/** Callers establish ownership with findOwned first; this does not check it. */
async function updateMeta(db: Database, id: string, input: UpdatePromptInput): Promise<void> {
  await db.transaction(async (tx) => {
    const values: Partial<typeof prompts.$inferInsert> = {};
    if (input.title !== undefined) values.title = input.title;
    if (input.description !== undefined) values.description = input.description;
    if (input.category !== undefined) values.category = input.category;
    if (input.modelHint !== undefined) values.modelHint = input.modelHint;
    if (input.visibility !== undefined) values.visibility = input.visibility;
    if (input.pinned !== undefined) values.pinnedAt = input.pinned ? new Date() : null;

    if (Object.keys(values).length > 0) {
      await tx.update(prompts).set(values).where(eq(prompts.id, id));
    }
    if (input.tags !== undefined) await replaceTags(tx, id, input.tags);
  });
}

async function setStatus(db: Database, promptId: string, status: PromptStatus): Promise<void> {
  await db.update(prompts).set({ status }).where(eq(prompts.id, promptId));
}

async function listCategoriesWithCounts(
  db: Database,
): Promise<{ category: string; count: number }[]> {
  return db
    .select({ category: prompts.category, count: sql<number>`count(*)::int` })
    .from(prompts)
    .where(PUBLIC_ONLY)
    .groupBy(prompts.category)
    .orderBy(asc(prompts.category));
}

/**
 * The same formula as `trendingScore` in @shelf/shared, evaluated in SQL so the
 * whole public shelf is rescored in one statement. The constants come from the
 * shared module, so the two cannot drift apart.
 */
async function recomputeTrending(db: Database): Promise<number> {
  const result = await db.execute(sql`
    UPDATE prompts
    SET trending_score = (
      (upvote_count + ${TRENDING.forkWeight} * fork_count)::double precision
      / power(
          GREATEST(extract(epoch FROM (now() - created_at)) / 3600.0, 0) + ${TRENDING.timeOffsetHours},
          ${TRENDING.gravity}::double precision
        )
    )::real
    WHERE visibility = 'public' AND status = 'active'
  `);
  return result.rowCount ?? 0;
}

/** The most used tags on the public shelf, for the filter chips. */
async function listTopTags(db: Database, limit = 16): Promise<{ name: string; count: number }[]> {
  const result = await db.execute<{ name: string; count: number }>(sql`
    SELECT t.name, count(*)::int AS count
    FROM prompt_tags pt
    JOIN tags t ON t.id = pt.tag_id
    JOIN prompts p ON p.id = pt.prompt_id
    WHERE p.visibility = 'public' AND p.status = 'active'
    GROUP BY t.name
    ORDER BY count DESC, t.name
    LIMIT ${Math.min(Math.max(limit, 1), 50)}
  `);
  return result.rows;
}

/** Everything a crawler may be told about: public, active prompts only. */
async function listSitemapEntries(
  db: Database,
  limit = 5000,
): Promise<{ id: string; updatedAt: Date }[]> {
  return db
    .select({ id: prompts.id, updatedAt: prompts.updatedAt })
    .from(prompts)
    .where(PUBLIC_ONLY)
    .orderBy(desc(prompts.updatedAt))
    .limit(limit);
}

export const promptRepo = {
  findVisible,
  findOwned,
  viewerStates,
  countPublic,
  countSearchPublic,
  updateMeta,
  recomputeTrending,
  listTopTags,
  listSitemapEntries,
  listPublic,
  searchPublic,
  listOwned,
  searchOwned,
  listVersions,
  findVersion,
  listForks,
  countOwned,
  listCategoriesWithCounts,
  create,
  addVersion,
  replaceTags,
  setStatus,
};
