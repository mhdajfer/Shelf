import { generateToken, hashToken } from './tokens.js';

/**
 * Every credential that reaches the MCP endpoint is recognisable on sight: in
 * a leaked file, a log, or a secret scanner's pattern list.
 */
export const PAT_PREFIX = 'shelf_pat_';
/** OAuth access tokens: an hour, for one client. */
export const ACCESS_TOKEN_PREFIX = 'shelf_at_';
/** OAuth refresh tokens: single use, rotated on every refresh. */
export const REFRESH_TOKEN_PREFIX = 'shelf_rt_';
/** OAuth authorization codes: a minute, redeemed once. */
export const AUTHORIZATION_CODE_PREFIX = 'shelf_ac_';

/** Characters after the prefix kept for display, enough to tell tokens apart. */
const DISPLAY_CHARS = 6;

export interface IssuedToken {
  /** Handed out once and never stored. */
  secret: string;
  hash: string;
  display: string;
}

export function issueToken(prefix: string): IssuedToken {
  const random = generateToken(32);
  const secret = `${prefix}${random}`;
  return {
    secret,
    hash: hashToken(secret),
    display: `${prefix}${random.slice(0, DISPLAY_CHARS)}…`,
  };
}

export const issuePersonalAccessToken = (): IssuedToken => issueToken(PAT_PREFIX);
