import { describe, expect, it } from 'vitest';

import { parseEnv } from './env.js';

describe('parseEnv', () => {
  it('fills every value from defaults so a fresh clone starts', () => {
    const env = parseEnv({});
    expect(env.NODE_ENV).toBe('development');
    expect(env.API_PORT).toBe(4000);
    expect(env.GUEST_DAILY_CREATE_CREDITS).toBe(3);
  });

  it('splits comma separated origins and drops blanks', () => {
    const env = parseEnv({ CORS_ALLOWED_ORIGINS: 'http://a.test, http://b.test ,' });
    expect(env.CORS_ALLOWED_ORIGINS).toEqual(['http://a.test', 'http://b.test']);
  });

  it('coerces numeric vars', () => {
    expect(parseEnv({ USER_DAILY_RUN_CREDITS: '120' }).USER_DAILY_RUN_CREDITS).toBe(120);
  });

  it('rejects a session secret that is too short to sign with', () => {
    expect(() => parseEnv({ SESSION_SECRET: 'short' })).toThrow(/SESSION_SECRET/);
  });

  it('rejects a non-numeric port', () => {
    expect(() => parseEnv({ API_PORT: 'http' })).toThrow(/API_PORT/);
  });

  it('refuses to run in production with the development secrets', () => {
    expect(() => parseEnv({ NODE_ENV: 'production' })).toThrow(/still hold development values/);
  });

  it('accepts production once the secrets are replaced', () => {
    const env = parseEnv({
      NODE_ENV: 'production',
      SESSION_SECRET: 'x'.repeat(48),
      GUEST_SECRET: 'y'.repeat(48),
      CRON_SECRET: 'z'.repeat(32),
    });
    expect(env.NODE_ENV).toBe('production');
  });

  it('leaves optional model and email keys unset', () => {
    const env = parseEnv({});
    expect(env.GEMINI_API_KEY).toBeUndefined();
    expect(env.RESEND_API_KEY).toBeUndefined();
  });
});
