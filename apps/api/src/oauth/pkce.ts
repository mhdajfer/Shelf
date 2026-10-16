import { createHash } from 'node:crypto';

import { ACCESS_SCOPES, type AccessScope } from '@shelf/shared';

import { safeEqual } from '../auth/tokens.js';

/** RFC 7636: an S256 challenge is 32 bytes of SHA-256 in unpadded base64url. */
export const CODE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const CODE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

/** Whether the verifier the client redeems with hashes to the challenge it started with. */
export function verifyPkce(verifier: string, challenge: string): boolean {
  if (!CODE_VERIFIER.test(verifier)) return false;
  return safeEqual(createHash('sha256').update(verifier).digest('base64url'), challenge);
}

/**
 * The scopes a request may ask for. Read always comes along, unknown scopes
 * (`offline_access`, `openid`) are ignored rather than refused, and asking for
 * nothing asks for read.
 */
export function requestedScopes(scope: string | undefined): AccessScope[] {
  const asked = new Set((scope ?? '').split(' ').filter(Boolean));
  return ACCESS_SCOPES.filter((name) => name === 'prompts:read' || asked.has(name));
}
