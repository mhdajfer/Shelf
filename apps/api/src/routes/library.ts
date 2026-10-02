import { Router } from 'express';

import { promptRepo, sessionRepo, userRepo, type Database } from '@shelf/db';
import { handleSchema } from '@shelf/shared';

import { safeEqual } from '../auth/tokens.js';
import { env } from '../config/env.js';
import { notFound, unauthorized } from '../http/errors.js';
import { logger } from '../observability/logger.js';

/** The read-only surfaces around the public shelf, plus the job that ranks it. */
export function createLibraryRouter(deps: { db: Database }): Router {
  const { db } = deps;
  const router = Router();

  router.get('/tags', async (_req, res) => {
    res.json({ tags: await promptRepo.listTopTags(db) });
  });

  router.get('/users/:handle', async (req, res) => {
    const handle = handleSchema.safeParse(req.params.handle);
    const profile = handle.success ? await userRepo.findPublicProfile(db, handle.data) : null;
    if (profile === null) throw notFound('That profile does not exist.');

    res.json({
      profile: {
        handle: profile.handle,
        name: profile.name,
        joinedAt: profile.joinedAt.toISOString(),
        publicPromptCount: profile.publicPromptCount,
      },
    });
  });

  router.get('/sitemap', async (_req, res) => {
    const entries = await promptRepo.listSitemapEntries(db);
    res.json({
      entries: entries.map((entry) => ({
        id: entry.id,
        updatedAt: entry.updatedAt.toISOString(),
      })),
    });
  });

  /**
   * For a platform scheduler when the API runs somewhere that sleeps and the
   * in-process cron cannot be relied on. Authenticated by bearer secret, which
   * is why the CSRF middleware exempts /cron/.
   */
  router.post('/cron/trending', async (req, res) => {
    const header = req.get('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
    if (!safeEqual(token, env.CRON_SECRET)) throw unauthorized('Invalid cron credentials.');

    const rescored = await promptRepo.recomputeTrending(db);
    await sessionRepo.removeExpired(db);
    logger.info({ rescored }, 'trending recomputed');
    res.json({ ok: true, rescored });
  });

  return router;
}
