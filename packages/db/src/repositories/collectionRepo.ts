import { and, asc, eq, sql } from 'drizzle-orm';

import type { Database } from '../client.js';
import { collectionItems, collections } from '../schema/collections.js';
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

async function addItem(db: Database, collectionId: string, promptId: string): Promise<void> {
  const [row] = await db
    .select({ next: sql<number>`coalesce(max(position), -1) + 1` })
    .from(collectionItems)
    .where(eq(collectionItems.collectionId, collectionId));

  await db
    .insert(collectionItems)
    .values({ collectionId, promptId, position: row?.next ?? 0 })
    .onConflictDoNothing();
}

async function removeItem(db: Database, collectionId: string, promptId: string): Promise<void> {
  await db
    .delete(collectionItems)
    .where(
      and(eq(collectionItems.collectionId, collectionId), eq(collectionItems.promptId, promptId)),
    );
}

export const collectionRepo = {
  listCollections,
  findCollection,
  listItems,
  createCollection,
  addItem,
  removeItem,
};
