import { resolve } from 'node:path';

import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

import { DEFAULT_CREDITS } from '@shelf/shared';

// One .env at the repo root serves both apps; a local override wins.
loadDotenv({
  path: [resolve(process.cwd(), '.env'), resolve(process.cwd(), '../../.env')],
  quiet: true,
});

// The default has to be applied to the raw string, before the split, because a
// transform's default is typed as the transform's output.
const csv = (fallback: string) =>
  z
    .string()
    .default(fallback)
    .transform((value) =>
      value
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean),
    );

const port = z.coerce.number().int().min(1).max(65_535);
const positiveInt = z.coerce.number().int().positive();

const DEV_PLACEHOLDER = /^dev-only-/;

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  API_PORT: port.default(4000),
  PUBLIC_WEB_URL: z.url().default('http://localhost:3000'),
  PUBLIC_API_URL: z.url().default('http://localhost:4000'),
  CORS_ALLOWED_ORIGINS: csv('http://localhost:3000'),

  DATABASE_URL: z.string().min(1).default('postgresql://shelf:shelf@localhost:5432/shelf'),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),

  SESSION_SECRET: z.string().min(32).default('dev-only-session-secret-change-me-0000000000'),
  GUEST_SECRET: z.string().min(32).default('dev-only-guest-secret-change-me-00000000000'),
  COOKIE_DOMAIN: z.string().optional(),
  SESSION_TTL_DAYS: positiveInt.default(30),

  GUEST_DAILY_CREATE_CREDITS: positiveInt.default(DEFAULT_CREDITS.guestDailyCreate),
  GUEST_DAILY_RUN_CREDITS: positiveInt.default(DEFAULT_CREDITS.guestDailyRun),
  USER_DAILY_RUN_CREDITS: positiveInt.default(DEFAULT_CREDITS.userDailyRun),
  LLM_GLOBAL_DAILY_CAP: positiveInt.default(2000),

  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default('gemini-2.5-flash'),
  LLM_TIMEOUT_MS: positiveInt.default(20_000),
  LLM_MAX_OUTPUT_TOKENS: positiveInt.default(2048),

  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z.url().optional(),

  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default('Shelf <noreply@shelf.example>'),

  TURNSTILE_SITE_KEY: z.string().default('1x00000000000000000000AA'),
  TURNSTILE_SECRET_KEY: z.string().default('1x0000000000000000000000000000000AA'),

  ADMIN_EMAILS: csv(''),
  CRON_SECRET: z.string().min(8).default('dev-only-cron-secret-change-me'),
});

export type Env = z.infer<typeof schema>;

/** Secrets that must be replaced before the service is exposed publicly. */
const PRODUCTION_SECRETS = ['SESSION_SECRET', 'GUEST_SECRET', 'CRON_SECRET'] as const;

export function parseEnv(source: NodeJS.ProcessEnv): Env {
  const result = schema.safeParse(source);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment:\n${details}`);
  }

  const env = result.data;
  if (env.NODE_ENV === 'production') {
    const unchanged = PRODUCTION_SECRETS.filter((key) => DEV_PLACEHOLDER.test(env[key]));
    if (unchanged.length > 0) {
      throw new Error(`Refusing to start: ${unchanged.join(', ')} still hold development values.`);
    }
  }

  return env;
}

export const env = parseEnv(process.env);

export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
