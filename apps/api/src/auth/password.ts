import { hash, verify } from '@node-rs/argon2';

import { isTest } from '../config/env.js';

/**
 * OWASP's argon2id baseline: 19 MiB, two passes, one lane.
 *
 * Tests use a token cost. They hash hundreds of passwords and assert nothing
 * about strength, and at the full memory cost the native module intermittently
 * killed vitest's forked workers on Windows (exit 0xC0000409, roughly half of
 * all runs). The same settings survived 400 concurrent verifies in the real API
 * process, so the fault appears specific to the test runner's workers.
 */
const OPTIONS = isTest
  ? ({ memoryCost: 1024, timeCost: 1, parallelism: 1 } as const)
  : ({ memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const);

export const hashPassword = (password: string): Promise<string> => hash(password, OPTIONS);

let dummyHash: Promise<string> | undefined;

/**
 * Verifies against a throwaway hash when the account has no password, so the
 * response time does not reveal whether an email is registered.
 */
export async function verifyPassword(
  passwordHash: string | null | undefined,
  password: string,
): Promise<boolean> {
  if (passwordHash == null) {
    dummyHash ??= hashPassword('shelf-timing-equaliser');
    await verify(await dummyHash, password).catch(() => false);
    return false;
  }
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}
