import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';

import { env } from './config/env.js';
import { AppError, errorHandler, notFoundHandler } from './http/errors.js';
import { httpLogger } from './observability/logger.js';
import { healthRouter } from './routes/health.js';

export const API_PREFIX = '/api/v1';

/**
 * Built as a factory so integration tests can drive the app through supertest
 * without binding a port.
 */
export function createApp(): Express {
  const app = express();

  // The API is behind one proxy in every deployment target; without this the
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

  app.use(express.json({ limit: '64kb' }));
  app.use(httpLogger);

  app.use(API_PREFIX, healthRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
