import { Router } from 'express';

export interface HealthChecks {
  database: () => Promise<boolean>;
  redis: () => Promise<boolean>;
}

const state = (ok: boolean): 'ok' | 'down' => (ok ? 'ok' : 'down');

/**
 * Reports each dependency separately. A platform health probe wants the status
 * code; a human debugging a sleeping free-tier instance wants to know which of
 * the two is the problem.
 */
export function createHealthRouter(checks: HealthChecks): Router {
  const router = Router();

  router.get('/health', async (_req, res) => {
    const [database, redis] = await Promise.all([checks.database(), checks.redis()]);
    const healthy = database && redis;

    res.status(healthy ? 200 : 503).json({
      status: healthy ? 'ok' : 'degraded',
      checks: { database: state(database), redis: state(redis) },
      uptimeSeconds: Math.round(process.uptime()),
    });
  });

  return router;
}
