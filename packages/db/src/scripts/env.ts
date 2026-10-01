import { resolve } from 'node:path';

import { config as loadDotenv } from 'dotenv';

import { requiresTls } from '../pool.js';

loadDotenv({ path: [resolve(process.cwd(), '../../.env')], quiet: true });

export const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://shelf:shelf@localhost:5432/shelf';

export const REQUIRES_TLS = requiresTls(DATABASE_URL);
