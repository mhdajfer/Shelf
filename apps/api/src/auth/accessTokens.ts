import { generateToken, hashToken } from './tokens.js';

/**
 * Personal access tokens are recognisable on sight: in a leaked file, a log,
 * or a secret scanner's pattern list.
 */
export const PAT_PREFIX = 'shelf_pat_';

/** Characters after the prefix kept for display, enough to tell tokens apart. */
const DISPLAY_CHARS = 6;

export interface IssuedToken {
  /** Shown to the user once and never stored. */
  secret: string;
  hash: string;
  display: string;
}

export function issuePersonalAccessToken(): IssuedToken {
  const random = generateToken(32);
  const secret = `${PAT_PREFIX}${random}`;
  return {
    secret,
    hash: hashToken(secret),
    display: `${PAT_PREFIX}${random.slice(0, DISPLAY_CHARS)}…`,
  };
}
