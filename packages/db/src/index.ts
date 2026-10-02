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
  type UpdatePromptInput,
  type ViewerState,
} from './repositories/promptRepo.js';

export {
  creditRepo,
  reportRepo,
  voteRepo,
  type CreditActor,
  type CreditPool,
  type Participant,
  type ReportedPrompt,
  type ReportOutcome,
  type SpendResult,
} from './repositories/activityRepo.js';

export {
  collectionRepo,
  COLLECTION_NAME_CONSTRAINT,
  type CollectionRecord,
} from './repositories/collectionRepo.js';

export {
  userRepo,
  USER_EMAIL_CONSTRAINT,
  USER_HANDLE_CONSTRAINT,
  type CreateUserInput,
  type PublicProfile,
  type UserRecord,
} from './repositories/userRepo.js';

export { sessionRepo, type SessionRecord } from './repositories/sessionRepo.js';

export { uniqueViolation } from './errors.js';
