import { Redis } from 'ioredis';

import { env } from '../config/env.js';
import { logger } from '../observability/logger.js';

export interface RedisConnection {
  client: Redis;
  ping: () => Promise<boolean>;
  close: () => Promise<void>;
}

export function connectRedis(): RedisConnection {
  const client = new Redis(env.REDIS_URL, {
    // Rate limiting and credit checks must fail fast rather than hold a request
    // open; the handler decides what to do when Redis is unavailable.
    maxRetriesPerRequest: 2,
    enableOfflineQueue: false,
  });

  client.on('error', (error: Error) => {
    logger.warn({ err: error }, 'redis error');
  });

  return {
    client,
    ping: async () => {
      try {
        return (await client.ping()) === 'PONG';
      } catch {
        return false;
      }
    },
    close: async () => {
      await client.quit();
    },
  };
}
