import { Router } from 'express';

import { oauthRepo, type Database, type OAuthClientRecord } from '@shelf/db';
import {
  oauthDecisionSchema,
  type AccessScope,
  type OAuthDecisionDto,
  type OAuthRequestDto,
} from '@shelf/shared';

import { AUTHORIZATION_CODE_PREFIX, issueToken } from '../auth/accessTokens.js';
import { requireUser } from '../auth/identity.js';
import { uuidParam } from '../http/dto.js';
import { badRequest, notFound } from '../http/errors.js';
import type { OAuthConfig } from '../oauth/config.js';
import { describeRedirect, withParams } from '../oauth/redirects.js';
import type { RateLimits } from '../security/rateLimit.js';

/** Long enough to switch back to the terminal; short enough that a leaked code is worthless. */
const CODE_TTL_MS = 60 * 1000;

const GONE = 'This request expired or was already answered. Start again from your app.';

/** The host that served a client's metadata document: the one thing about it that was checked. */
export const publishedBy = (client: Pick<OAuthClientRecord, 'kind' | 'clientId'>): string | null =>
  client.kind === 'metadata_document' ? new URL(client.clientId).host : null;

/**
 * The consent page's half of the OAuth flow. The browser arrives here from the
 * authorize endpoint with a request id; the user, signed in with the ordinary
 * session and CSRF token, approves or denies it, and the answer is where to
 * send the browser next.
 */
export function createOAuthConsentRouter(deps: {
  db: Database;
  limits: RateLimits;
  oauth: OAuthConfig;
}): Router {
  const { db, limits, oauth } = deps;
  const router = Router();

  router.get('/oauth/requests/:id', async (req, res) => {
    const user = requireUser(req);
    const pending = await oauthRepo.findPendingRequest(db, uuidParam(req, 'id'));
    if (pending === null) throw notFound(GONE);

    const current = await oauthRepo.findAppGrant(db, user.id, pending.client.id);
    const body: OAuthRequestDto = {
      id: pending.id,
      client: { name: pending.client.name, publishedBy: publishedBy(pending.client) },
      redirect: describeRedirect(pending.redirectUri),
      scopes: pending.scopes,
      current,
      expiresAt: pending.expiresAt.toISOString(),
    };
    res.json(body);
  });

  router.post('/oauth/requests/:id/decision', async (req, res) => {
    const user = requireUser(req);
    const requestId = uuidParam(req, 'id');
    const input = oauthDecisionSchema.parse(req.body);
    await limits.consume('write', user.id);

    if (!input.approve) {
      const denied = await oauthRepo.denyRequest(db, requestId);
      if (denied === null) throw notFound(GONE);
      const body: OAuthDecisionDto = {
        redirectTo: withParams(denied.redirectUri, {
          error: 'access_denied',
          error_description: 'The user declined.',
          state: denied.state,
          iss: oauth.issuer,
        }),
      };
      res.json(body);
      return;
    }

    const pending = await oauthRepo.findPendingRequest(db, requestId);
    if (pending === null) throw notFound(GONE);

    // Never more than the client asked for.
    const scopes: AccessScope[] =
      input.write && pending.scopes.includes('prompts:write')
        ? ['prompts:read', 'prompts:write']
        : ['prompts:read'];
    const code = issueToken(AUTHORIZATION_CODE_PREFIX);
    const approved = await oauthRepo.approveRequest(db, requestId, {
      userId: user.id,
      scopes,
      promptSet: input.promptSet,
      collectionId: input.collectionId ?? null,
      codeHash: code.hash,
      codeExpiresAt: new Date(Date.now() + CODE_TTL_MS),
    });
    if (approved === null) {
      // The request was pending a moment ago, so the collection is what failed,
      // unless a second tab answered in between.
      if (input.collectionId !== undefined) {
        throw badRequest('That collection does not exist.', [
          { field: 'collectionId', message: 'That collection does not exist.' },
        ]);
      }
      throw notFound(GONE);
    }

    const body: OAuthDecisionDto = {
      redirectTo: withParams(approved.redirectUri, {
        code: code.secret,
        state: approved.state,
        iss: oauth.issuer,
      }),
    };
    res.json(body);
  });

  return router;
}
