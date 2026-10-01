/**
 * The public surface of @shelf/db. Table definitions are deliberately absent:
 * they live behind `@shelf/db/schema`, which only this package, the seed script
 * and tests may import. Application code reaches prompts through the
 * repositories, so the visibility filter cannot be bypassed by writing a query.
 */
export { createPool, pingDatabase, requiresTls, type PoolOptions } from './pool.js';
export { createDatabase, type Database, type Executor, type Transaction } from './client.js';
export { runMigrations, MIGRATIONS_FOLDER } from './migrate.js';

export { ANONYMOUS, guestActor, isAdmin, userActor, type Actor } from './repositories/actor.js';

export {
  promptRepo,
  MAX_PAGE_SIZE,
  type AddVersionInput,
  type CreatePromptInput,
  type OwnedListOptions,
  type PromptAuthor,
  type PromptSummary,
  type PromptVersionRecord,
  type PublicListOptions,
  type SearchOptions,
} from './repositories/promptRepo.js';

export { collectionRepo, type CollectionRecord } from './repositories/collectionRepo.js';
