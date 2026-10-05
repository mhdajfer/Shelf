import type { Redis } from 'ioredis';
import {
  RateLimiterMemory,
  RateLimiterRedis,
  RateLimiterRes,
  type RateLimiterAbstract,
} from 'rate-limiter-flexible';

import { AppError } from '../http/errors.js';
import { logger } from '../observability/logger.js';

/** points per duration (seconds). */
const BUCKETS = {
  login: { points: 10, duration: 15 * 60 },
  signup: { points: 5, duration: 60 * 60 },
  passwordReset: { points: 5, duration: 60 * 60 },
  verification: { points: 5, duration: 60 * 60 },
  write: { points: 60, duration: 60 },
  vote: { points: 120, duration: 60 },
  report: { points: 10, duration: 60 * 60 },
  // Generous: server-rendered searches all arrive from the web host's address.
  search: { points: 300, duration: 60 },
  model: { points: 20, duration: 60 },
} as const;

export type Bucket = keyof typeof BUCKETS;

export interface RateLimits {
  /** Throws `rate_limited` once `key` has spent the bucket's allowance. */
  consume: (bucket: Bucket, key: string) => Promise<void>;
}

/** For tests that are not about rate limiting. */
export const noRateLimits: RateLimits = { consume: () => Promise.resolve() };

function formatWait(seconds: number): string {
  if (seconds < 90) return `${String(seconds)} seconds`;
  return `${String(Math.ceil(seconds / 60))} minutes`;
}

/**
 * Redis-backed so the limit holds across instances, with an in-memory limiter
 * as insurance: if Redis is unreachable the API degrades to per-process limits
 * instead of either failing every request or dropping the limit entirely.
 */
export function createRateLimits(redis: Redis | null): RateLimits {
  const limiters = new Map<Bucket, RateLimiterAbstract>();

  for (const name of Object.keys(BUCKETS) as Bucket[]) {
    const options = BUCKETS[name];
    const memory = new RateLimiterMemory({ keyPrefix: `rl:${name}`, ...options });
    limiters.set(
      name,
      redis === null
        ? memory
        : new RateLimiterRedis({
            storeClient: redis,
            keyPrefix: `rl:${name}`,
            insuranceLimiter: memory,
            ...options,
          }),
    );
  }

  return {
    consume: async (bucket, key) => {
      const limiter = limiters.get(bucket);
      if (limiter === undefined) return;
      try {
        await limiter.consume(key);
      } catch (rejection) {
        if (rejection instanceof RateLimiterRes) {
          const seconds = Math.max(1, Math.ceil(rejection.msBeforeNext / 1000));
          throw new AppError(
            'rate_limited',
            `Too many attempts. Try again in ${formatWait(seconds)}.`,
          );
        }
        // A store failure the insurance limiter could not absorb. Let the request
        // through: availability matters more than this one check.
        logger.warn({ err: rejection, bucket }, 'rate limiter unavailable');
      }
    },
  };
}
