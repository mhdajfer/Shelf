import { Router } from 'express';

import { adminRepo, reportRepo, type Database } from '@shelf/db';
import { resolveReportSchema, type AdminOverviewDto, type ReportedPromptDto } from '@shelf/shared';

import { requireAdmin } from '../auth/identity.js';
import { env } from '../config/env.js';
import { uuidParam } from '../http/dto.js';
import { notFound } from '../http/errors.js';
import { logger } from '../observability/logger.js';

/**
 * Moderation of the public shelf. Every route answers 404 to a non-admin, the
 * same as a route that does not exist. Nothing here can read private content:
 * the queue is built from reports, and only public prompts can be reported.
 */
export function createAdminRouter(deps: { db: Database }): Router {
  const { db } = deps;
  const router = Router();

  router.get('/admin/overview', async (req, res) => {
    requireAdmin(req);
    const overview: AdminOverviewDto = {
      ...(await adminRepo.overview(db)),
      modelDailyCap: env.LLM_GLOBAL_DAILY_CAP,
    };
    res.json({ overview });
  });

  router.get('/admin/reports', async (req, res) => {
    requireAdmin(req);
    const reported = await reportRepo.listReported(db);
    const reports: ReportedPromptDto[] = reported.map((row) => ({
      ...row,
      lastReportedAt: row.lastReportedAt.toISOString(),
    }));
    res.json({ reports });
  });

  router.post('/admin/reports/:promptId/resolve', async (req, res) => {
    const admin = requireAdmin(req);
    const { action } = resolveReportSchema.parse(req.body);
    const promptId = uuidParam(req, 'promptId');

    const resolved = await reportRepo.resolveReports(db, promptId, admin.id, action);
    if (!resolved) throw notFound('That prompt does not exist.');

    logger.info({ adminId: admin.id, promptId, action }, 'reports resolved');
    res.json({ ok: true });
  });

  return router;
}
