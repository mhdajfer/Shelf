import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import type { Database } from '../client.js';
import { collectionItems, collections } from '../schema/collections.js';
import { prompts } from '../schema/prompts.js';
import type { Actor } from './actor.js';
import { promptRepo, type PromptSummary } from './promptRepo.js';

export interface CollectionRecord {
  id: string;
  name: string;
  position: number;
  itemCount: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Collections are owner-scoped with no public surface, so every read here is
 * keyed on the actor's own id. A non-user actor gets nothing.
 */
async function listCollections(db: Database, actor: Actor): Promise<CollectionRecord[]> {
  if (actor.type !== 'user') return [];

  return db
    .select({
      id: collections.id,
      name: collections.name,
      position: collections.position,
      itemCount: sql<number>`(
        SELECT count(*)::int FROM collection_items ci WHERE ci.collection_id = ${collections.id}
      )`,
      createdAt: collections.createdAt,
      updatedAt: collections.updatedAt,
    })
    .from(collections)
    .where(eq(collections.ownerId, actor.userId))
    .orderBy(asc(collections.position), asc(collections.name));
}

async function findCollection(
  db: Database,
  actor: Actor,
  collectionId: string,
): Promise<CollectionRecord | null> {
  const all = await listCollections(db, actor);
  return all.find((collection) => collection.id === collectionId) ?? null;
}

/**
 * Null when the collection is not the actor's, so the route 404s instead of
 * revealing that the id exists. Items are then resolved through
 * promptRepo.listOwned, which re-applies the prompt visibility rule rather than
 * trusting collection membership.
 */
async function listItems(
  db: Database,
  actor: Actor,
  collectionId: string,
): Promise<PromptSummary[] | null> {
  if ((await findCollection(db, actor, collectionId)) === null) return null;
  return promptRepo.listOwned(db, actor, { collectionId, limit: 50 });
}

async function createCollection(db: Database, ownerId: string, name: string): Promise<string> {
  const [row] = await db
    .select({ next: sql<number>`coalesce(max(position), -1) + 1` })
    .from(collections)
    .where(eq(collections.ownerId, ownerId));

  const [created] = await db
    .insert(collections)
    .values({ ownerId, name, position: row?.next ?? 0 })
    .returning({ id: collections.id });

  if (created === undefined) throw new Error('collection insert returned no row');
  return created.id;
}

/**
 * Adds a prompt to a collection, but only when the same user owns both. Returns
 * false otherwise, so a route cannot be used to file someone else's prompt, or
 * to probe whether a collection or prompt id exists.
 */
async function addItem(
  db: Database,
  ownerId: string,
  collectionId: string,
  promptId: string,
): Promise<boolean> {
  const [owned] = await db
    .select({ id: collections.id })
    .from(collections)
    .innerJoin(prompts, eq(prompts.ownerId, collections.ownerId))
    .where(
      and(
        eq(collections.id, collectionId),
        eq(collections.ownerId, ownerId),
        eq(prompts.id, promptId),
        sql`${prompts.status} <> 'deleted'`,
      ),
    )
    .limit(1);
  if (owned === undefined) return false;

  const [row] = await db
    .select({ next: sql<number>`coalesce(max(position), -1) + 1` })
    .from(collectionItems)
    .where(eq(collectionItems.collectionId, collectionId));

  await db
    .insert(collectionItems)
    .values({ collectionId, promptId, position: row?.next ?? 0 })
    .onConflictDoNothing();
  return true;
}

async function removeItem(
  db: Database,
  ownerId: string,
  collectionId: string,
  promptId: string,
): Promise<void> {
  await db.delete(collectionItems).where(
    and(
      eq(collectionItems.promptId, promptId),
      // Scoped through the owner, so only the collection's owner can empty it.
      inArray(
        collectionItems.collectionId,
        db
          .select({ id: collections.id })
          .from(collections)
          .where(and(eq(collections.id, collectionId), eq(collections.ownerId, ownerId))),
      ),
    ),
  );
}

export const COLLECTION_NAME_CONSTRAINT = 'collections_owner_name_key';

/** False when the collection is not the caller's. Throws a unique violation on a taken name. */
async function rename(db: Database, ownerId: string, id: string, name: string): Promise<boolean> {
  const rows = await db
    .update(collections)
    .set({ name })
    .where(and(eq(collections.id, id), eq(collections.ownerId, ownerId)))
    .returning({ id: collections.id });
  return rows.length > 0;
}

/** Deletes the collection, not the prompts in it. */
async function remove(db: Database, ownerId: string, id: string): Promise<boolean> {
  const rows = await db
    .delete(collections)
    .where(and(eq(collections.id, id), eq(collections.ownerId, ownerId)))
    .returning({ id: collections.id });
  return rows.length > 0;
}

/** Sets sidebar order to the given sequence. Ids that are not the owner's are ignored. */
async function reorder(db: Database, ownerId: string, orderedIds: string[]): Promise<void> {
  await db.transaction(async (tx) => {
    for (const [position, id] of orderedIds.entries()) {
      await tx
        .update(collections)
        .set({ position })
        .where(and(eq(collections.id, id), eq(collections.ownerId, ownerId)));
    }
  });
}

/** Which of the owner's collections a prompt sits in. */
async function collectionIdsForPrompt(
  db: Database,
  ownerId: string,
  promptId: string,
): Promise<string[]> {
  const rows = await db
    .select({ id: collectionItems.collectionId })
    .from(collectionItems)
    .innerJoin(collections, eq(collections.id, collectionItems.collectionId))
    .where(and(eq(collectionItems.promptId, promptId), eq(collections.ownerId, ownerId)));
  return rows.map((row) => row.id);
}

export const collectionRepo = {
  listCollections,
  findCollection,
  listItems,
  createCollection,
  addItem,
  removeItem,
  rename,
  remove,
  reorder,
  collectionIdsForPrompt,
};
