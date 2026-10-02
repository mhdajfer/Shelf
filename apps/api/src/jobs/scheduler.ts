import cron from 'node-cron';

import { promptRepo, sessionRepo, type Database } from '@shelf/db';

import { logger } from '../observability/logger.js';

/**
 * Scores go stale as prompts age, not only when they are voted on, so they are
 * recomputed on a clock rather than on write. Fifteen minutes is far finer than
 * the decay curve needs and cheap at this size.
 */
export function startScheduler(db: Database): () => void {
  const recompute = async (): Promise<void> => {
    try {
      const rescored = await promptRepo.recomputeTrending(db);
      logger.debug({ rescored }, 'trending recomputed');
    } catch (error) {
      logger.error({ err: error }, 'trending recompute failed');
    }
  };

  const trending = cron.schedule('*/15 * * * *', () => void recompute());
  const cleanup = cron.schedule('17 * * * *', () => {
    sessionRepo.removeExpired(db).catch((error: unknown) => {
      logger.error({ err: error }, 'session cleanup failed');
    });
  });

  // Once at boot, so a freshly seeded or just-woken instance ranks correctly
  // without waiting for the first tick.
  void recompute();

  return () => {
    void trending.stop();
    void cleanup.stop();
  };
}
