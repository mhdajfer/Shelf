import { Router } from 'express';

import {
  COLLECTION_NAME_CONSTRAINT,
  collectionRepo,
  promptRepo,
  uniqueViolation,
  type CollectionRecord,
  type Database,
} from '@shelf/db';
import {
  collectionOrderSchema,
  collectionSchema,
  type CollectionDto,
  type ShelfSummaryDto,
} from '@shelf/shared';

import { requireUser } from '../auth/identity.js';
import { uuidParam } from '../http/dto.js';
import { AppError, notFound } from '../http/errors.js';
import type { RateLimits } from '../security/rateLimit.js';

const MAX_COLLECTIONS = 100;

const toDto = (collection: CollectionRecord): CollectionDto => ({
  id: collection.id,
  name: collection.name,
  position: collection.position,
  itemCount: collection.itemCount,
});

const nameTaken = (): AppError =>
  new AppError('conflict', 'That collection name is already on your shelf.', {
    details: [{ field: 'name', message: 'That collection name is already on your shelf.' }],
  });

/**
 * Collections are private to their owner and have no public surface. Every
 * route requires a session and scopes its query by the session's user id, so
 * another user's collection id behaves exactly like one that does not exist.
 */
export function createCollectionRouter(deps: { db: Database; limits: RateLimits }): Router {
  const { db, limits } = deps;
  const router = Router();

  /** The sidebar in one request. */
  router.get('/shelf/summary', async (req, res) => {
    const user = requireUser(req);
    const [counts, collections] = await Promise.all([
      promptRepo.shelfCounts(db, user.id),
      collectionRepo.listCollections(db, req.actor),
    ]);
    const body: ShelfSummaryDto = { counts, collections: collections.map(toDto) };
    res.json(body);
  });

  router.post('/collections', async (req, res) => {
    const user = requireUser(req);
    const { name } = collectionSchema.parse(req.body);
    await limits.consume('write', user.id);

    if ((await collectionRepo.listCollections(db, req.actor)).length >= MAX_COLLECTIONS) {
      throw new AppError('conflict', `A shelf can hold ${String(MAX_COLLECTIONS)} collections.`);
    }

    try {
      const id = await collectionRepo.createCollection(db, user.id, name);
      const created = await collectionRepo.findCollection(db, req.actor, id);
      if (created === null) throw notFound();
      res.status(201).json({ collection: toDto(created) });
    } catch (error) {
      if (uniqueViolation(error) === COLLECTION_NAME_CONSTRAINT) throw nameTaken();
      throw error;
    }
  });

  // Registered before /collections/:id so "order" is not read as an id.
  router.put('/collections/order', async (req, res) => {
    const user = requireUser(req);
    const { ids } = collectionOrderSchema.parse(req.body);
    await limits.consume('write', user.id);
    await collectionRepo.reorder(db, user.id, ids);
    res.json({ ok: true });
  });

  router.patch('/collections/:id', async (req, res) => {
    const user = requireUser(req);
    const { name } = collectionSchema.parse(req.body);
    await limits.consume('write', user.id);

    try {
      const renamed = await collectionRepo.rename(db, user.id, uuidParam(req, 'id'), name);
      if (!renamed) throw notFound('That collection does not exist.');
    } catch (error) {
      if (uniqueViolation(error) === COLLECTION_NAME_CONSTRAINT) throw nameTaken();
      throw error;
    }
    res.json({ ok: true });
  });

  router.delete('/collections/:id', async (req, res) => {
    const user = requireUser(req);
    await limits.consume('write', user.id);
    const removed = await collectionRepo.remove(db, user.id, uuidParam(req, 'id'));
    if (!removed) throw notFound('That collection does not exist.');
    res.status(204).end();
  });

  router.put('/collections/:id/prompts/:promptId', async (req, res) => {
    const user = requireUser(req);
    await limits.consume('write', user.id);
    const added = await collectionRepo.addItem(
      db,
      user.id,
      uuidParam(req, 'id'),
      uuidParam(req, 'promptId'),
    );
    // One answer whether the collection, the prompt, or the ownership is wrong.
    if (!added) throw notFound('That collection or prompt does not exist.');
    res.json({ ok: true });
  });

  router.delete('/collections/:id/prompts/:promptId', async (req, res) => {
    const user = requireUser(req);
    await limits.consume('write', user.id);
    await collectionRepo.removeItem(db, user.id, uuidParam(req, 'id'), uuidParam(req, 'promptId'));
    res.status(204).end();
  });

  router.get('/prompts/:id/collections', async (req, res) => {
    const user = requireUser(req);
    const collectionIds = await collectionRepo.collectionIdsForPrompt(
      db,
      user.id,
      uuidParam(req, 'id'),
    );
    res.json({ collectionIds });
  });

  return router;
}
