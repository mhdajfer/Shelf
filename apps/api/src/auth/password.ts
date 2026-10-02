import { hash, verify } from '@node-rs/argon2';

// OWASP's argon2id baseline: 19 MiB, two passes, one lane.
const OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

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
