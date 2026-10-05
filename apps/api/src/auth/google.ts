import { decodeIdToken, generateCodeVerifier, generateState, Google } from 'arctic';

import { env } from '../config/env.js';

export interface OAuthProfile {
  subject: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
}

/** The seam tests replace, so the OAuth flow can be exercised without Google. */
export interface OAuthProvider {
  createAuthorizationUrl: (state: string, codeVerifier: string) => URL;
  exchange: (code: string, codeVerifier: string) => Promise<OAuthProfile>;
}

export const newOAuthState = (): { state: string; codeVerifier: string } => ({
  state: generateState(),
  codeVerifier: generateCodeVerifier(),
});

interface GoogleClaims {
  sub?: unknown;
  email?: unknown;
  email_verified?: unknown;
  name?: unknown;
}

/** Null when the Google credentials are not configured. */
export function createGoogleProvider(): OAuthProvider | null {
  if (
    env.OFFLINE_MODE ||
    !env.GOOGLE_CLIENT_ID ||
    !env.GOOGLE_CLIENT_SECRET ||
    !env.GOOGLE_REDIRECT_URI
  ) {
    return null;
  }

  const google = new Google(
    env.GOOGLE_CLIENT_ID,
    env.GOOGLE_CLIENT_SECRET,
    env.GOOGLE_REDIRECT_URI,
  );

  return {
    createAuthorizationUrl: (state, codeVerifier) =>
      google.createAuthorizationURL(state, codeVerifier, ['openid', 'profile', 'email']),

    exchange: async (code, codeVerifier) => {
      const tokens = await google.validateAuthorizationCode(code, codeVerifier);
      const claims = decodeIdToken(tokens.idToken()) as GoogleClaims;
      if (typeof claims.sub !== 'string' || typeof claims.email !== 'string') {
        throw new Error('Google id token is missing sub or email');
      }
      return {
        subject: claims.sub,
        email: claims.email.toLowerCase(),
        emailVerified: claims.email_verified === true,
        name: typeof claims.name === 'string' ? claims.name : null,
      };
    },
  };
}
