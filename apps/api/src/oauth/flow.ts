import { randomUUID } from 'node:crypto';

import express, { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { oauthRepo, type Database } from '@shelf/db';
import type { AccessScope } from '@shelf/shared';

import { ACCESS_TOKEN_PREFIX, issueToken, REFRESH_TOKEN_PREFIX } from '../auth/accessTokens.js';
import { hashToken } from '../auth/tokens.js';
import type { RateLimits } from '../security/rateLimit.js';
import { cleanClientName, resolveClient, supportsCodeFlow } from './clients.js';
import {
  AUTHORIZATION_SERVER_METADATA_PATH,
  OAUTH_PREFIX,
  PROTECTED_RESOURCE_METADATA_PATH,
  sameResource,
  type OAuthConfig,
} from './config.js';
import { authorizationServerMetadata, protectedResourceMetadata } from './metadata.js';
import { CODE_CHALLENGE, requestedScopes, verifyPkce } from './pkce.js';
import { matchesRegistered, parseRedirectUri, withParams } from './redirects.js';

const MINUTE_MS = 60 * 1000;
const REQUEST_TTL_MS = 10 * MINUTE_MS;
const ACCESS_TOKEN_TTL_S = 60 * 60;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * MINUTE_MS;
const STATE_MAX = 1024;

/** The paths whose answers any origin may read: nothing here is cookie-authenticated. */
export const OPEN_CORS_PATHS = new Set([
  PROTECTED_RESOURCE_METADATA_PATH,
  '/.well-known/oauth-protected-resource',
  AUTHORIZATION_SERVER_METADATA_PATH,
  `${OAUTH_PREFIX}/token`,
  `${OAUTH_PREFIX}/register`,
  `${OAUTH_PREFIX}/revoke`,
]);

export interface OAuthDeps {
  db: Database;
  limits: RateLimits;
  oauth: OAuthConfig;
}

/** One string value, or nothing. A repeated parameter is as good as a missing one. */
function param(source: unknown, name: string): string | undefined {
  const value = (source as Record<string, unknown> | undefined)?.[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** RFC 6749 §5.2. Descriptions are fixed strings, never input echoed back. */
function oauthError(res: Response, status: number, error: string, description: string): void {
  res.status(status).json({ error, error_description: description });
}

const clientKey = (req: Request): string => req.ip ?? 'unknown';

/**
 * Body of a dynamic registration (RFC 7591). Everything a client may say about
 * itself beyond its redirect URIs and name is accepted and ignored, except a
 * flow other than the authorization code flow, which is refused.
 */
const registrationSchema = z.looseObject({
  redirect_uris: z.array(z.string()).min(1).max(10),
  client_name: z.string().max(1000).optional(),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
});

/**
 * The OAuth 2.1 authorization server, per the MCP authorization spec. None of
 * these endpoints reads the session cookie: the user is only ever identified on
 * the consent page, through the session routes in `routes/oauth.ts`.
 */
export function createOAuthRouter(deps: OAuthDeps): Router {
  const { db, limits, oauth } = deps;
  const router = Router();
  const form = express.urlencoded({ extended: false, limit: '16kb' });

  // ---------------------------------------------------------------- discovery

  const discovery = (document: object) => (_req: Request, res: Response) => {
    res.set('Cache-Control', 'public, max-age=300').json(document);
  };
  // The root form is for clients that look there before trying the path-aware one.
  router.get(
    [PROTECTED_RESOURCE_METADATA_PATH, '/.well-known/oauth-protected-resource'],
    discovery(protectedResourceMetadata(oauth)),
  );
  router.get(AUTHORIZATION_SERVER_METADATA_PATH, discovery(authorizationServerMetadata(oauth)));

  // ------------------------------------------------------------- registration

  router.post(`${OAUTH_PREFIX}/register`, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    await limits.consume('oauthRegister', clientKey(req));

    const parsed = registrationSchema.safeParse(req.body);
    if (!parsed.success) {
      oauthError(res, 400, 'invalid_client_metadata', 'Send redirect_uris: one to ten URIs.');
      return;
    }
    const input = parsed.data;
    if (input.redirect_uris.some((uri) => parseRedirectUri(uri) === null)) {
      oauthError(
        res,
        400,
        'invalid_redirect_uri',
        'Redirect URIs must be HTTPS, HTTP to a loopback address, or an app’s own scheme, without a fragment.',
      );
      return;
    }
    if (!supportsCodeFlow(input)) {
      oauthError(
        res,
        400,
        'invalid_client_metadata',
        'Only the authorization code flow is supported.',
      );
      return;
    }

    const client = await oauthRepo.registerClient(db, {
      clientId: randomUUID(),
      name: cleanClientName(input.client_name, 'An unnamed app'),
      redirectUris: input.redirect_uris,
    });
    // A public client whatever it asked for: no secret is ever issued.
    res.status(201).json({
      client_id: client.clientId,
      client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
      client_name: client.name,
      redirect_uris: client.redirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });
  });

  // ---------------------------------------------------------------- authorize

  router.get(`${OAUTH_PREFIX}/authorize`, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    await limits.consume('oauthAuthorize', clientKey(req));

    // Until the client and its redirect URI check out, nothing is sent back to
    // that URI: the browser goes to Shelf's own page to say what went wrong.
    const refuse = (error: 'invalid_client' | 'invalid_redirect_uri') => {
      res.redirect(302, `${oauth.consentUrl}?error=${error}`);
    };

    const clientId = param(req.query, 'client_id');
    const redirectUri = param(req.query, 'redirect_uri');
    const client =
      clientId === undefined ? null : await resolveClient(db, oauth.fetchClientMetadata, clientId);
    if (client === null) {
      refuse('invalid_client');
      return;
    }
    if (redirectUri === undefined || !matchesRegistered(client.redirectUris, redirectUri)) {
      refuse('invalid_redirect_uri');
      return;
    }

    const rawState = param(req.query, 'state');
    const state = rawState !== undefined && rawState.length <= STATE_MAX ? rawState : undefined;
    const fail = (error: string, description: string) => {
      res.redirect(
        302,
        withParams(redirectUri, {
          error,
          error_description: description,
          state,
          iss: oauth.issuer,
        }),
      );
    };

    if (rawState !== undefined && state === undefined) {
      fail('invalid_request', 'The state parameter is too long.');
      return;
    }
    if (param(req.query, 'response_type') !== 'code') {
      fail('unsupported_response_type', 'Only response_type=code is supported.');
      return;
    }
    const challenge = param(req.query, 'code_challenge');
    if (param(req.query, 'code_challenge_method') !== 'S256' || challenge === undefined) {
      fail('invalid_request', 'PKCE with code_challenge_method=S256 is required.');
      return;
    }
    if (!CODE_CHALLENGE.test(challenge)) {
      fail('invalid_request', 'The code_challenge is not an S256 challenge.');
      return;
    }
    const resource = param(req.query, 'resource');
    if (resource === undefined || !sameResource(resource, oauth.resource)) {
      fail('invalid_target', `The resource parameter must be ${oauth.resource}.`);
      return;
    }

    const requestId = await oauthRepo.createRequest(db, {
      clientId: client.id,
      redirectUri,
      codeChallenge: challenge,
      scopes: requestedScopes(param(req.query, 'scope')),
      resource: oauth.resource,
      state: state ?? null,
      expiresAt: new Date(Date.now() + REQUEST_TTL_MS),
    });
    res.redirect(302, `${oauth.consentUrl}?request=${requestId}`);
  });

  // -------------------------------------------------------------------- token

  /** A fresh access and refresh token in the family, as the token response. */
  async function issuePair(
    res: Response,
    grant: { grantId: string; familyId: string; resource: string; scopes: AccessScope[] },
  ): Promise<void> {
    const access = issueToken(ACCESS_TOKEN_PREFIX);
    const refresh = issueToken(REFRESH_TOKEN_PREFIX);
    await oauthRepo.issueTokens(db, {
      grantId: grant.grantId,
      familyId: grant.familyId,
      resource: grant.resource,
      access: {
        hash: access.hash,
        display: access.display,
        expiresAt: new Date(Date.now() + ACCESS_TOKEN_TTL_S * 1000),
      },
      refresh: {
        hash: refresh.hash,
        display: refresh.display,
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
      },
    });
    res.json({
      access_token: access.secret,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_S,
      refresh_token: refresh.secret,
      scope: grant.scopes.join(' '),
    });
  }

  router.post(`${OAUTH_PREFIX}/token`, form, async (req, res) => {
    res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache' });
    await limits.consume('oauthToken', clientKey(req));

    const clientId = param(req.body, 'client_id');
    const client = clientId === undefined ? null : await oauthRepo.findClient(db, clientId);
    if (client === null) {
      oauthError(res, 401, 'invalid_client', 'Send the client_id this server knows the client by.');
      return;
    }
    const resource = param(req.body, 'resource');
    const grantType = param(req.body, 'grant_type');

    if (grantType === 'authorization_code') {
      const code = param(req.body, 'code');
      const verifier = param(req.body, 'code_verifier');
      const redirectUri = param(req.body, 'redirect_uri');
      if (code === undefined || verifier === undefined || redirectUri === undefined) {
        oauthError(res, 400, 'invalid_request', 'Send code, code_verifier, and redirect_uri.');
        return;
      }

      const redeemed = await oauthRepo.redeemCode(db, hashToken(code));
      if (redeemed.status === 'replayed') {
        // Someone else may have redeemed it first: nothing it produced can be trusted.
        await oauthRepo.revokeFamily(db, redeemed.familyId);
      }
      if (redeemed.status !== 'ok') {
        oauthError(res, 400, 'invalid_grant', 'The code is invalid, expired, or already used.');
        return;
      }

      const { code: grant } = redeemed;
      if (
        grant.clientId !== client.id ||
        grant.redirectUri !== redirectUri ||
        !verifyPkce(verifier, grant.codeChallenge)
      ) {
        oauthError(res, 400, 'invalid_grant', 'The code was not issued for this request.');
        return;
      }
      if (resource !== undefined && !sameResource(resource, grant.resource)) {
        oauthError(res, 400, 'invalid_target', 'The code was issued for another resource.');
        return;
      }
      const scopes = await oauthRepo.grantScopes(db, grant.grantId);
      if (scopes === null) {
        oauthError(res, 400, 'invalid_grant', 'Access was revoked before the code was redeemed.');
        return;
      }
      await issuePair(res, { ...grant, scopes });
      return;
    }

    if (grantType === 'refresh_token') {
      const token = param(req.body, 'refresh_token');
      if (token === undefined) {
        oauthError(res, 400, 'invalid_request', 'Send refresh_token.');
        return;
      }

      const rotated = await oauthRepo.rotateRefresh(db, hashToken(token));
      if (rotated.status === 'reused') {
        // A refresh token is single use. A second use, beyond a concurrent
        // refresh, means it was copied.
        await oauthRepo.revokeFamily(db, rotated.familyId);
      }
      if (rotated.status !== 'ok') {
        oauthError(
          res,
          400,
          'invalid_grant',
          'The refresh token is invalid, expired, or already used.',
        );
        return;
      }

      const { refresh } = rotated;
      if (refresh.clientId !== client.id) {
        // Presented by a client it was not issued to: treated as stolen.
        await oauthRepo.revokeFamily(db, refresh.familyId);
        oauthError(res, 400, 'invalid_grant', 'The refresh token was not issued to this client.');
        return;
      }
      if (resource !== undefined && !sameResource(resource, refresh.resource)) {
        oauthError(
          res,
          400,
          'invalid_target',
          'The refresh token was issued for another resource.',
        );
        return;
      }
      await issuePair(res, refresh);
      return;
    }

    oauthError(
      res,
      400,
      'unsupported_grant_type',
      'Use grant_type=authorization_code or grant_type=refresh_token.',
    );
  });

  // ------------------------------------------------------------------- revoke

  /** RFC 7009. Answers 200 whether or not there was anything to revoke. */
  router.post(`${OAUTH_PREFIX}/revoke`, form, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    await limits.consume('oauthToken', clientKey(req));

    const clientId = param(req.body, 'client_id');
    const client = clientId === undefined ? null : await oauthRepo.findClient(db, clientId);
    if (client === null) {
      oauthError(res, 401, 'invalid_client', 'Send the client_id this server knows the client by.');
      return;
    }
    const token = param(req.body, 'token');
    if (token === undefined) {
      oauthError(res, 400, 'invalid_request', 'Send the token to revoke.');
      return;
    }

    const familyId = await oauthRepo.findFamilyForClient(db, hashToken(token), client.id);
    if (familyId !== null) await oauthRepo.revokeFamily(db, familyId);
    res.status(200).end();
  });

  return router;
}
