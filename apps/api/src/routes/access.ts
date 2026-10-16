import { Router } from 'express';

import {
  accessRepo,
  type AccessTokenRecord,
  type ConnectedAppRecord,
  type Database,
} from '@shelf/db';
import {
  createAccessTokenSchema,
  LIMITS,
  type AccessScope,
  type AccessTokenDto,
  type ConnectedAppDto,
  type CreatedAccessTokenDto,
} from '@shelf/shared';

import { issuePersonalAccessToken } from '../auth/accessTokens.js';
import { requireUser } from '../auth/identity.js';
import { uuidParam } from '../http/dto.js';
import { AppError, badRequest, notFound } from '../http/errors.js';
import type { RateLimits } from '../security/rateLimit.js';
import { publishedBy } from './oauth.js';

const DAY_MS = 24 * 60 * 60 * 1000;

const toDto = (token: AccessTokenRecord): AccessTokenDto => ({
  id: token.id,
  name: token.name,
  scopes: token.scopes,
  promptSet: token.promptSet,
  collection: token.collection,
  display: token.display,
  createdAt: token.createdAt.toISOString(),
  expiresAt: token.expiresAt.toISOString(),
  lastUsedAt: token.lastUsedAt?.toISOString() ?? null,
});

const toAppDto = (app: ConnectedAppRecord): ConnectedAppDto => ({
  id: app.id,
  name: app.name,
  publishedBy: publishedBy({ kind: app.clientKind, clientId: app.clientId }),
  scopes: app.scopes,
  promptSet: app.promptSet,
  collection: app.collection,
  createdAt: app.createdAt.toISOString(),
  lastUsedAt: app.lastUsedAt?.toISOString() ?? null,
  expiresAt: app.expiresAt.toISOString(),
});

/**
 * Personal access tokens and connected apps, managed from Settings with the
 * browser session. The credentials themselves authenticate only the MCP
 * endpoint, never these routes, so a token cannot mint or revoke tokens.
 */
export function createAccessRouter(deps: { db: Database; limits: RateLimits }): Router {
  const { db, limits } = deps;
  const router = Router();

  router.get('/access/tokens', async (req, res) => {
    const user = requireUser(req);
    const tokens = await accessRepo.listTokens(db, user.id);
    res.json({ tokens: tokens.map(toDto) });
  });

  router.post('/access/tokens', async (req, res) => {
    const user = requireUser(req);
    const input = createAccessTokenSchema.parse(req.body);
    await limits.consume('write', user.id);

    if ((await accessRepo.countTokens(db, user.id)) >= LIMITS.maxAccessTokensPerUser) {
      throw new AppError(
        'conflict',
        `You have ${String(LIMITS.maxAccessTokensPerUser)} tokens. Revoke one you no longer use first.`,
      );
    }

    const scopes: AccessScope[] = input.write
      ? ['prompts:read', 'prompts:write']
      : ['prompts:read'];
    const issued = issuePersonalAccessToken();
    const grantId = await accessRepo.createToken(db, {
      userId: user.id,
      name: input.name,
      scopes,
      promptSet: input.promptSet,
      collectionId: input.collectionId ?? null,
      tokenHash: issued.hash,
      display: issued.display,
      expiresAt: new Date(Date.now() + input.expiresInDays * DAY_MS),
    });
    // Unknown and someone else's collection answer alike.
    if (grantId === null) {
      throw badRequest('That collection does not exist.', [
        { field: 'collectionId', message: 'That collection does not exist.' },
      ]);
    }

    const created = (await accessRepo.listTokens(db, user.id)).find(
      (token) => token.id === grantId,
    );
    if (created === undefined) throw new Error('created token is not listed');
    const body: CreatedAccessTokenDto = { token: toDto(created), secret: issued.secret };
    res.status(201).json(body);
  });

  router.delete('/access/tokens/:id', async (req, res) => {
    const user = requireUser(req);
    const grantId = uuidParam(req, 'id');
    await limits.consume('write', user.id);
    if (!(await accessRepo.revokeToken(db, user.id, grantId))) {
      throw notFound('That token does not exist.');
    }
    res.status(204).end();
  });

  router.get('/access/apps', async (req, res) => {
    const user = requireUser(req);
    const apps = await accessRepo.listApps(db, user.id);
    res.json({ apps: apps.map(toAppDto) });
  });

  router.delete('/access/apps/:id', async (req, res) => {
    const user = requireUser(req);
    const grantId = uuidParam(req, 'id');
    await limits.consume('write', user.id);
    if (!(await accessRepo.revokeApp(db, user.id, grantId))) {
      throw notFound('That app is not connected.');
    }
    res.status(204).end();
  });

  return router;
}
