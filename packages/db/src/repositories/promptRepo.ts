import { and, asc, desc, eq, gt, inArray, type SQL, sql } from 'drizzle-orm';

import {
  commandNameCandidate,
  slugifyCommandName,
  TRENDING,
  type Category,
  type PromptSet,
  type PromptStatus,
  type PublicSort,
  type TemplateVariable,
  type Visibility,
} from '@shelf/shared';

import type { Database, Executor, Transaction } from '../client.js';
import { uniqueViolation } from '../errors.js';
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
  /** Null for guest prompts, which have no shelf to be addressed in. */
  commandName: string | null;
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
  WHERE pt.prompt_id = "prompts"."id"
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
  commandName: prompts.commandName,
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
    commandName: row.commandName,
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
 * The part of one user's shelf a grant (an access token, a connected app) can
 * see. Every read on behalf of a grant composes `inPromptSet`, so a prompt
 * outside the set is absent from the query, not filtered from its results.
 */
export interface PromptSetScope {
  userId: string;
  promptSet: PromptSet;
  /** Set exactly when `promptSet` is `collection`. */
  collectionId: string | null;
}

function inPromptSet(scope: PromptSetScope): SQL {
  const clauses: SQL[] = [
    sql`${prompts.ownerId} = ${scope.userId}`,
    sql`${prompts.status} <> 'deleted'`,
  ];
  switch (scope.promptSet) {
    case 'all':
      break;
    case 'pinned':
      clauses.push(sql`${prompts.pinnedAt} IS NOT NULL`);
      break;
    case 'collection':
      clauses.push(
        scope.collectionId === null
          ? sql`false`
          : sql`EXISTS (
              SELECT 1 FROM collection_items ci
              JOIN collections c ON c.id = ci.collection_id
              WHERE ci.prompt_id = ${prompts.id}
                AND ci.collection_id = ${scope.collectionId}
                AND c.owner_id = ${scope.userId}
            )`,
      );
      break;
  }
  return sql.join(clauses, sql` AND `);
}

/**
 * The set in command-name order, one page after `after` (exclusive). Keyed on
 * the name rather than an offset, so a prompt saved or deleted between pages
 * cannot shift the next page.
 */
async function listInSet(
  db: Database,
  scope: PromptSetScope,
  options: { after?: string; limit?: number } = {},
): Promise<PromptSummary[]> {
  const rows = await baseSelect(db)
    .where(
      and(
        inPromptSet(scope),
        options.after === undefined ? undefined : gt(prompts.commandName, options.after),
      ),
    )
    .orderBy(asc(prompts.commandName))
    .limit(clampLimit(options.limit));
  return rows.map(toSummary);
}

/** One prompt in the set, by id or by command name. Null for anything else. */
async function findInSet(
  db: Database,
  scope: PromptSetScope,
  key: { id: string } | { commandName: string },
): Promise<PromptSummary | null> {
  const match =
    'id' in key ? sql`${prompts.id} = ${key.id}` : sql`${prompts.commandName} = ${key.commandName}`;
  const rows = await baseSelect(db)
    .where(and(inPromptSet(scope), match))
    .limit(1);
  const row = rows[0];
  return row === undefined ? null : toSummary(row);
}

/**
 * Full-text search within the set, or the set in command-name order when
 * there is no query. Tags narrow either way, all of them required.
 */
async function searchInSet(
  db: Database,
  scope: PromptSetScope,
  options: { query?: string; tags?: string[]; limit?: number },
): Promise<PromptSummary[]> {
  const query = options.query?.trim() ?? '';
  const clauses = [inPromptSet(scope), ...tagFilters(options.tags ?? [])];
  if (query === '') {
    const rows = await baseSelect(db)
      .where(and(...clauses))
      .orderBy(asc(prompts.commandName))
      .limit(clampLimit(options.limit));
    return rows.map(toSummary);
  }

  const rows = await baseSelect(db)
    .where(and(...clauses, matchQuery(query)))
    .orderBy(desc(matchRank(query)), asc(prompts.commandName))
    .limit(clampLimit(options.limit));
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

/** The numbers beside the sidebar's fixed entries. */
async function shelfCounts(
  db: Database,
  userId: string,
): Promise<{ total: number; pinned: number; public: number }> {
  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      pinned: sql<number>`count(*) FILTER (WHERE ${prompts.pinnedAt} IS NOT NULL)::int`,
      public: sql<number>`count(*) FILTER (WHERE ${prompts.visibility} = 'public')::int`,
    })
    .from(prompts)
    .where(and(eq(prompts.ownerId, userId), sql`${prompts.status} <> 'deleted'`));
  return row ?? { total: 0, pinned: 0, public: 0 };
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

export const COMMAND_NAME_CONSTRAINT = 'prompts_owner_command_name_key';

/** Candidates checked per query when looking for a free command name. */
const NAME_BATCH = 20;
/**
 * Creates for one owner are serialised by a lock, so a retry is only needed
 * when a rename takes the chosen name in the same instant.
 */
const NAME_ATTEMPTS = 3;

/**
 * The first of `base`, `base-2`, `base-3`, … that none of the owner's live
 * prompts uses. Only a starting point: the unique index has the final say.
 */
async function freeCommandName(db: Executor, ownerId: string, base: string): Promise<string> {
  // Bounded by the size of the owner's shelf: every batch that is fully taken
  // is NAME_BATCH live prompts.
  for (let start = 1; ; start += NAME_BATCH) {
    const candidates = Array.from({ length: NAME_BATCH }, (_, offset) =>
      commandNameCandidate(base, start + offset),
    );
    const rows = await db
      .select({ name: prompts.commandName })
      .from(prompts)
      .where(
        and(
          eq(prompts.ownerId, ownerId),
          sql`${prompts.status} <> 'deleted'`,
          inArray(prompts.commandName, candidates),
        ),
      );
    const taken = new Set(rows.map((row) => row.name));
    const free = candidates.find((candidate) => !taken.has(candidate));
    if (free !== undefined) return free;
  }
}

/**
 * Inserts a user's prompt row under a free command name.
 *
 * Concurrent creates cannot see each other's uncommitted rows, so without
 * coordination they all pick the same "free" name and all but one fail. A
 * transaction-scoped advisory lock on the owner makes them take turns; it is
 * released at commit and costs nothing for a single create. The insert also
 * runs in a savepoint, so a name taken by a concurrent rename (which does not
 * take the lock) can be retried without abandoning the surrounding transaction.
 */
async function insertOwnedRow(
  tx: Transaction,
  ownerId: string,
  values: typeof prompts.$inferInsert,
): Promise<string> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`prompt_command_name:${ownerId}`}, 0))`,
  );
  const base = slugifyCommandName(values.title);
  for (let attempt = 1; ; attempt += 1) {
    const commandName = await freeCommandName(tx, ownerId, base);
    try {
      const [row] = await tx.transaction((savepoint) =>
        savepoint
          .insert(prompts)
          .values({ ...values, ownerId, commandName })
          .returning({ id: prompts.id }),
      );
      if (row === undefined) throw new Error('prompt insert returned no row');
      return row.id;
    } catch (error) {
      if (attempt < NAME_ATTEMPTS && uniqueViolation(error) === COMMAND_NAME_CONSTRAINT) continue;
      throw error;
    }
  }
}

/**
 * The prompt row and version 1 reference each other, so both inserts and the
 * back-pointer happen in one transaction. A crash halfway cannot leave a prompt
 * with no body.
 */
async function create(db: Database, input: CreatePromptInput): Promise<string> {
  return db.transaction(async (tx) => {
    const values: typeof prompts.$inferInsert = {
      guestId: input.author.type === 'guest' ? input.author.guestId : null,
      guestHandle: input.author.type === 'guest' ? input.author.guestHandle : null,
      visibility: input.visibility,
      title: input.title,
      description: input.description ?? null,
      category: input.category,
      modelHint: input.modelHint ?? null,
      forkedFromId: input.forkedFromId ?? null,
    };

    let promptId: string;
    if (input.author.type === 'user') {
      promptId = await insertOwnedRow(tx, input.author.userId, values);
    } else {
      const [row] = await tx.insert(prompts).values(values).returning({ id: prompts.id });
      if (row === undefined) throw new Error('prompt insert returned no row');
      promptId = row.id;
    }
    const prompt = { id: promptId };

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
  /** Throws a unique violation on COMMAND_NAME_CONSTRAINT when the owner already uses it. */
  commandName?: string;
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
    if (input.commandName !== undefined) values.commandName = input.commandName;

    if (Object.keys(values).length > 0) {
      await tx.update(prompts).set(values).where(eq(prompts.id, id));
    }
    if (input.tags !== undefined) await replaceTags(tx, id, input.tags);
  });
}

export const FORK_CONSTRAINT = 'prompts_one_fork_per_owner_key';

/** The user's live fork of a prompt, if they have one. */
async function findForkId(db: Executor, userId: string, sourceId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: prompts.id })
    .from(prompts)
    .where(
      and(
        eq(prompts.ownerId, userId),
        eq(prompts.forkedFromId, sourceId),
        sql`${prompts.status} <> 'deleted'`,
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

/**
 * Soft-deletes a prompt. If it was a fork, the source's fork count goes down
 * with it, so the count always means forks that still exist. Callers establish
 * ownership first.
 */
async function softDelete(db: Database, promptId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [removed] = await tx
      .update(prompts)
      .set({ status: 'deleted' })
      .where(and(eq(prompts.id, promptId), sql`${prompts.status} <> 'deleted'`))
      .returning({ forkedFromId: prompts.forkedFromId });

    if (removed?.forkedFromId != null) {
      await tx
        .update(prompts)
        .set({ forkCount: sql`GREATEST(${prompts.forkCount} - 1, 0)` })
        .where(eq(prompts.id, removed.forkedFromId));
    }
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

export interface ExportedPromptRecord {
  title: string;
  description: string | null;
  category: string;
  modelHint: string | null;
  visibility: Visibility;
  pinned: boolean;
  tags: string[];
  collections: string[];
  versions: { number: number; body: string; note: string | null; createdAt: Date }[];
}

/**
 * A user's whole shelf with full history, for export. Keyed on the owner id
 * and nothing else, so there is no id a caller could substitute to read
 * someone else's prompt through it.
 */
async function exportOwned(db: Database, userId: string): Promise<ExportedPromptRecord[]> {
  const owned = await db
    .select({
      id: prompts.id,
      title: prompts.title,
      description: prompts.description,
      category: prompts.category,
      modelHint: prompts.modelHint,
      visibility: prompts.visibility,
      pinnedAt: prompts.pinnedAt,
      tags: tagNames,
      collections: sql<string[]>`coalesce((
        SELECT array_agg(c.name ORDER BY c.position, c.name)
        FROM collection_items ci
        JOIN collections c ON c.id = ci.collection_id
        WHERE ci.prompt_id = "prompts"."id" AND c.owner_id = ${userId}
      ), ARRAY[]::text[])`,
    })
    .from(prompts)
    .where(and(eq(prompts.ownerId, userId), sql`${prompts.status} <> 'deleted'`))
    .orderBy(asc(prompts.createdAt));

  if (owned.length === 0) return [];

  const versions = await db
    .select({
      promptId: promptVersions.promptId,
      number: promptVersions.number,
      body: promptVersions.body,
      note: promptVersions.note,
      createdAt: promptVersions.createdAt,
    })
    .from(promptVersions)
    .where(
      inArray(
        promptVersions.promptId,
        owned.map((prompt) => prompt.id),
      ),
    )
    .orderBy(asc(promptVersions.number));

  const byPrompt = new Map<string, ExportedPromptRecord['versions']>();
  for (const { promptId, ...version } of versions) {
    const list = byPrompt.get(promptId) ?? [];
    list.push(version);
    byPrompt.set(promptId, list);
  }

  return owned.map((prompt) => ({
    title: prompt.title,
    description: prompt.description,
    category: prompt.category,
    modelHint: prompt.modelHint,
    visibility: prompt.visibility,
    pinned: prompt.pinnedAt !== null,
    tags: prompt.tags,
    collections: prompt.collections,
    versions: byPrompt.get(prompt.id) ?? [],
  }));
}

export const promptRepo = {
  findVisible,
  findOwned,
  viewerStates,
  countPublic,
  countSearchPublic,
  updateMeta,
  findForkId,
  softDelete,
  recomputeTrending,
  listTopTags,
  listSitemapEntries,
  exportOwned,
  listPublic,
  searchPublic,
  listOwned,
  searchOwned,
  listInSet,
  findInSet,
  searchInSet,
  listVersions,
  findVersion,
  listForks,
  countOwned,
  shelfCounts,
  listCategoriesWithCounts,
  create,
  addVersion,
  replaceTags,
  setStatus,
};
