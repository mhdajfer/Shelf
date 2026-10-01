import { createApp } from './app.js';
import { env } from './config/env.js';
import { connectDatabase } from './infra/database.js';
import { connectRedis } from './infra/redis.js';
import { logger } from './observability/logger.js';

const database = connectDatabase();
const redis = connectRedis();

const server = createApp({
  health: { database: database.ping, redis: redis.ping },
}).listen(env.API_PORT, () => {
  logger.info({ port: env.API_PORT, env: env.NODE_ENV }, 'api listening');
});

let shuttingDown = false;

/** Close datastores only after the last request has drained, not before. */
async function releaseResources(failed: boolean): Promise<void> {
  await Promise.allSettled([database.close(), redis.close()]);
  process.exit(failed ? 1 : 0);
}

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');

  // A held-open SSE stream must not stop the platform's stop signal landing.
  const forceExit = setTimeout(() => {
    logger.warn('shutdown timed out, exiting anyway');
    process.exit(1);
  }, 10_000);
  forceExit.unref();

  server.close((error) => {
    if (error) logger.error({ err: error }, 'server close failed');
    void releaseResources(error !== undefined);
  });
}

process.on('SIGTERM', () => {
  shutdown('SIGTERM');
});
process.on('SIGINT', () => {
  shutdown('SIGINT');
});
