import type { AuthInfo } from '@modelcontextprotocol/server';
import type { NextFunction, Request, Response } from 'express';

import { accessRepo, type Database, type PromptSetScope } from '@shelf/db';
import type { AccessScope } from '@shelf/shared';

import { hashToken } from '../auth/tokens.js';
import { logger } from '../observability/logger.js';
import type { RateLimits } from '../security/rateLimit.js';

/** Who an MCP request acts for, and how far its grant reaches. */
export interface McpGrant {
  grantId: string;
  /**
   * Always the plain user role. An admin's token must not carry the admin's
   * wider read access (hidden public prompts) to wherever the token ends up.
   */
  actor: { type: 'user'; userId: string; role: 'user' };
  scope: PromptSetScope;
  scopes: AccessScope[];
}

const GRANT_KEY = 'shelfGrant';

/** The grant the bearer middleware attached, as the SDK hands it back to the server factory. */
export function grantOf(authInfo: AuthInfo | undefined): McpGrant {
  const grant = authInfo?.extra?.[GRANT_KEY];
  if (grant === undefined) throw new Error('MCP request reached the server without a grant');
  return grant as McpGrant;
}

/**
 * RFC 6750 challenge. Error descriptions are fixed strings, so nothing a
 * client sent is reflected into a header.
 */
function challenge(res: Response, error?: { code: 'invalid_token'; description: string }): void {
  const params = ['realm="shelf"'];
  if (error !== undefined) {
    params.push(`error="${error.code}"`, `error_description="${error.description}"`);
  }
  res
    .status(401)
    .set('WWW-Authenticate', `Bearer ${params.join(', ')}`)
    .json({
      error: error?.code ?? 'invalid_request',
      error_description: error?.description ?? 'Send a Shelf access token as a bearer token.',
    });
}

/**
 * Bearer tokens only. The session cookie is never read here: a browser can be
 * made to send a cookie cross-site but never an Authorization header, which is
 * what makes it safe for this endpoint to skip the CSRF check.
 */
export function bearerAuth(deps: { db: Database; limits: RateLimits }) {
  const { db, limits } = deps;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const header = req.get('authorization');
    const match = header === undefined ? null : /^Bearer\s+(\S+)\s*$/i.exec(header);
    const token = match?.[1];
    if (token === undefined) {
      challenge(res);
      return;
    }

    const grant = await accessRepo.resolve(db, hashToken(token));
    if (grant === null) {
      challenge(res, {
        code: 'invalid_token',
        description: 'The token is unknown, expired, or revoked.',
      });
      return;
    }

    await limits.consume('mcp', grant.grantId);

    const resolved: McpGrant = {
      grantId: grant.grantId,
      actor: { type: 'user', userId: grant.userId, role: 'user' },
      scope: {
        userId: grant.userId,
        promptSet: grant.promptSet,
        collectionId: grant.collectionId,
      },
      scopes: grant.scopes,
    };
    req.auth = {
      token,
      clientId: grant.grantId,
      scopes: grant.scopes,
      expiresAt: Math.floor(grant.expiresAt.getTime() / 1000),
      extra: { [GRANT_KEY]: resolved },
    };

    // Bookkeeping must never fail the request it is recording.
    accessRepo.touch(db, grant.grantId).catch((error: unknown) => {
      logger.warn({ err: error, grantId: grant.grantId }, 'could not record token use');
    });
    next();
  };
}
