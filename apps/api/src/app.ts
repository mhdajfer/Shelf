import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import swaggerUi from 'swagger-ui-express';

import type { Database } from '@shelf/db';

import { csrfProtection } from './auth/csrf.js';
import type { OAuthProvider } from './auth/google.js';
import { identity } from './auth/identity.js';
import { env } from './config/env.js';
import { buildOpenApiDocument } from './docs/openapi.js';
import type { EmailTransport } from './email/transport.js';
import { AppError, errorHandler, notFoundHandler } from './http/errors.js';
import type { LlmProvider } from './llm/provider.js';
import { httpLogger } from './observability/logger.js';
import { createAdminRouter } from './routes/admin.js';
import { createAuthRouter } from './routes/auth.js';
import { createCollectionRouter } from './routes/collections.js';
import { createHealthRouter, type HealthChecks } from './routes/health.js';
import { createLibraryRouter } from './routes/library.js';
import { createPromptRouter } from './routes/prompts.js';
import { createRunRouter } from './routes/runs.js';
import { createTransferRouter } from './routes/transfer.js';
import type { BotCheck } from './security/botCheck.js';
import type { RateLimits } from './security/rateLimit.js';

export const API_PREFIX = '/api/v1';

export interface AppDeps {
  health: HealthChecks;
  db: Database;
  email: EmailTransport;
  limits: RateLimits;
  botCheck: BotCheck;
  /** Null when Google credentials are not configured. */
  google: OAuthProvider | null;
  llm: LlmProvider;
}

/**
 * Built as a factory over injected dependencies so integration tests can drive
 * the app through supertest, and unit tests can run without a datastore.
 */
export function createApp(deps: AppDeps): Express {
  const app = express();

  // The API sits behind one proxy in every deployment target; without this the
  // rate limiters and IP hashing would see the proxy address for everyone.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(
    helmet({
      // The API serves JSON and SSE only; a document CSP belongs to the web app.
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );

  app.use(
    cors({
      origin(origin, callback) {
        // Same-origin and non-browser callers send no Origin header.
        if (origin === undefined || env.CORS_ALLOWED_ORIGINS.includes(origin)) {
          callback(null, true);
          return;
        }
        callback(new AppError('forbidden', 'Origin not allowed.'));
      },
      credentials: true,
      maxAge: 600,
    }),
  );

  // An export file is far larger than any other request body. Its parser runs
  // first; the general one below then sees the body already parsed and skips.
  app.use(`${API_PREFIX}/import`, express.json({ limit: '8mb' }));
  app.use(express.json({ limit: '64kb' }));
  app.use(cookieParser());
  app.use(httpLogger);

  app.use(API_PREFIX, createHealthRouter(deps.health));

  // The API described for consumers other than the web app. Public: it says
  // nothing a reader of the repository could not already see.
  const openApi = buildOpenApiDocument(env.PUBLIC_API_URL);
  app.get(`${API_PREFIX}/openapi.json`, (_req, res) => {
    res.json(openApi);
  });
  app.use(`${API_PREFIX}/docs`, swaggerUi.serve, swaggerUi.setup(openApi));

  // Everything past this point can depend on who is asking, so none of it may
  // be stored by a shared cache.
  app.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  // Everything below knows who is asking and refuses forged writes.
  app.use(identity(deps.db));
  app.use(csrfProtection);

  app.use(`${API_PREFIX}/auth`, createAuthRouter(deps));
  // Before the prompt router: /collections/order must not be read as an id.
  app.use(API_PREFIX, createCollectionRouter(deps));
  app.use(API_PREFIX, createPromptRouter(deps));
  app.use(API_PREFIX, createLibraryRouter(deps));
  app.use(API_PREFIX, createRunRouter(deps));
  app.use(API_PREFIX, createTransferRouter(deps));
  app.use(API_PREFIX, createAdminRouter(deps));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
