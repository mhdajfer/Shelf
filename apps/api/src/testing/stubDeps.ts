import type { Database } from '@shelf/db';

import type { AppDeps } from '../app.js';
import { createMemoryTransport } from '../email/transport.js';
import { createFakeProvider } from '../llm/provider.js';
import { noBotCheck } from '../security/botCheck.js';
import { noRateLimits } from '../security/rateLimit.js';

/**
 * Dependencies for tests that never reach a datastore. The database is a bare
 * object: touching it is a test bug, and fails loudly as one.
 */
export function stubDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  return {
    health: { database: () => Promise.resolve(true), redis: () => Promise.resolve(true) },
    db: {} as Database,
    email: createMemoryTransport(),
    limits: noRateLimits,
    botCheck: noBotCheck,
    google: null,
    llm: createFakeProvider({ chunkDelayMs: 0 }),
    ...overrides,
  };
}
