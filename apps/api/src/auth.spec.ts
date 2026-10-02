import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { OAuthProvider } from './auth/google.js';
import { createRateLimits } from './security/rateLimit.js';
import {
  createApiHarness,
  openBrowser,
  signedInBrowser,
  tokenFromLastEmail,
  url,
  type ApiHarness,
} from './testing/harness.js';

let harness: ApiHarness;

const EMAIL = 'ada@example.test';
const PASSWORD = 'correct horse battery';

beforeAll(async () => {
  harness = await createApiHarness();
}, 60_000);

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  await harness.database.truncate();
  harness.outbox.length = 0;
});

interface MeBody {
  user: { email: string; handle: string; emailVerified: boolean; role: string } | null;
}

describe('signup', () => {
  it('creates the account, signs the browser in, and emails a verification link', async () => {
    const browser = await harness.browser();
    const response = await browser.post('/auth/signup', { email: EMAIL, password: PASSWORD });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      user: { email: EMAIL, handle: 'ada', emailVerified: false, role: 'user' },
    });
    expect(harness.outbox).toHaveLength(1);
    expect(harness.outbox[0]?.to).toBe(EMAIL);

    const me = await browser.get('/auth/me');
    expect((me.body as MeBody).user?.email).toBe(EMAIL);
  });

  it('never returns the password hash', async () => {
    const browser = await harness.browser();
    const response = await browser.post('/auth/signup', { email: EMAIL, password: PASSWORD });
    expect(JSON.stringify(response.body)).not.toMatch(/argon2|passwordHash/);
  });

  it('normalises the address, so a second signup with different casing conflicts', async () => {
    const first = await harness.browser();
    await first.post('/auth/signup', { email: EMAIL, password: PASSWORD });

    const second = await harness.browser();
    const response = await second.post('/auth/signup', {
      email: '  ADA@Example.test ',
      password: PASSWORD,
    });
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      error: { code: 'conflict', details: [{ field: 'email' }] },
    });
  });

  it('gives two people with the same local part different handles', async () => {
    const first = await harness.browser();
    await first.post('/auth/signup', { email: 'sam@one.test', password: PASSWORD });
    const second = await harness.browser();
    const response = await second.post('/auth/signup', {
      email: 'sam@two.test',
      password: PASSWORD,
    });

    expect(response.status).toBe(201);
    const { handle } = (response.body as { user: { handle: string } }).user;
    expect(handle).toMatch(/^sam_\d{4}$/);
  });

  it('reports field errors in the envelope', async () => {
    const browser = await harness.browser();
    const response = await browser.post('/auth/signup', { email: 'nope', password: 'short' });
    expect(response.status).toBe(400);
    const fields = (response.body as { error: { details: { field: string }[] } }).error.details.map(
      (detail) => detail.field,
    );
    expect(fields).toEqual(expect.arrayContaining(['email', 'password']));
  });
});

describe('login and logout', () => {
  beforeEach(async () => {
    const browser = await harness.browser();
    await browser.post('/auth/signup', { email: EMAIL, password: PASSWORD });
  });

  it('signs in with the right password', async () => {
    const browser = await harness.browser();
    const response = await browser.post('/auth/login', { email: EMAIL, password: PASSWORD });
    expect(response.status).toBe(200);
    expect(((await browser.get('/auth/me')).body as MeBody).user?.email).toBe(EMAIL);
  });

  it('gives the same answer for a wrong password and an unknown address', async () => {
    const browser = await harness.browser();
    const wrong = await browser.post('/auth/login', { email: EMAIL, password: 'not the one' });
    const unknown = await browser.post('/auth/login', {
      email: 'nobody@example.test',
      password: PASSWORD,
    });

    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(unknown.body).toEqual(wrong.body);
  });

  it('sets the session cookie HttpOnly and SameSite=Lax', async () => {
    const browser = await harness.browser();
    const response = await browser.post('/auth/login', { email: EMAIL, password: PASSWORD });
    const cookies = response.headers['set-cookie'] as unknown as string[];
    const session = cookies.find((cookie) => cookie.startsWith('shelf_session='));
    expect(session).toMatch(/HttpOnly/);
    expect(session).toMatch(/SameSite=Lax/);
  });

  it('ends the session on logout, server-side', async () => {
    const browser = await harness.browser();
    const login = await browser.post('/auth/login', { email: EMAIL, password: PASSWORD });
    const cookies = login.headers['set-cookie'] as unknown as string[];
    const sessionCookie = cookies.find((cookie) => cookie.startsWith('shelf_session='));

    await browser.post('/auth/logout');
    expect(((await browser.get('/auth/me')).body as MeBody).user).toBeNull();

    // Replaying the old cookie must not work: the row is gone, not just the cookie.
    const replay = await request(harness.app)
      .get(url('/auth/me'))
      .set('Cookie', (sessionCookie ?? '').split(';')[0] ?? '');
    expect((replay.body as MeBody).user).toBeNull();
  });
});

describe('csrf', () => {
  it('rejects a write with no token', async () => {
    const response = await request(harness.app)
      .post(url('/auth/login'))
      .send({ email: EMAIL, password: PASSWORD });
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ error: { code: 'forbidden' } });
  });

  it('rejects a header that does not match the cookie', async () => {
    const browser = await harness.browser();
    const response = await browser.agent
      .post(url('/auth/login'))
      .set('x-csrf-token', `${browser.csrf}x`)
      .send({ email: EMAIL, password: PASSWORD });
    expect(response.status).toBe(403);
  });

  it('rejects a matching pair that was not signed by the server', async () => {
    const response = await request(harness.app)
      .post(url('/auth/login'))
      .set('Cookie', 'shelf_csrf=forged.value')
      .set('x-csrf-token', 'forged.value')
      .send({ email: EMAIL, password: PASSWORD });
    expect(response.status).toBe(403);
  });
});

describe('email verification', () => {
  it('verifies with the emailed token, once', async () => {
    const browser = await harness.browser();
    await browser.post('/auth/signup', { email: EMAIL, password: PASSWORD });
    const token = tokenFromLastEmail(harness.outbox);

    expect((await browser.post('/auth/verify-email', { token })).status).toBe(200);
    expect(((await browser.get('/auth/me')).body as MeBody).user?.emailVerified).toBe(true);

    expect((await browser.post('/auth/verify-email', { token })).status).toBe(400);
  });

  it('retires the earlier link when a new one is requested', async () => {
    const browser = await harness.browser();
    await browser.post('/auth/signup', { email: EMAIL, password: PASSWORD });
    const first = tokenFromLastEmail(harness.outbox);

    await browser.post('/auth/resend-verification');
    const second = tokenFromLastEmail(harness.outbox);
    expect(second).not.toBe(first);

    expect((await browser.post('/auth/verify-email', { token: first })).status).toBe(400);
    expect((await browser.post('/auth/verify-email', { token: second })).status).toBe(200);
  });

  it('requires a session to resend', async () => {
    const browser = await harness.browser();
    expect((await browser.post('/auth/resend-verification')).status).toBe(401);
  });
});

describe('password reset', () => {
  beforeEach(async () => {
    const browser = await harness.browser();
    await browser.post('/auth/signup', { email: EMAIL, password: PASSWORD });
    harness.outbox.length = 0;
  });

  it('answers the same for a known and an unknown address, and only emails the known one', async () => {
    const browser = await harness.browser();
    const known = await browser.post('/auth/forgot-password', { email: EMAIL });
    const unknown = await browser.post('/auth/forgot-password', { email: 'nobody@example.test' });

    expect(known.status).toBe(200);
    expect(unknown.body).toEqual(known.body);
    expect(harness.outbox).toHaveLength(1);
  });

  it('sets the new password, signs every session out, and retires the link', async () => {
    const existing = await harness.browser();
    await existing.post('/auth/login', { email: EMAIL, password: PASSWORD });

    const browser = await harness.browser();
    await browser.post('/auth/forgot-password', { email: EMAIL });
    const token = tokenFromLastEmail(harness.outbox);

    const reset = await browser.post('/auth/reset-password', {
      token,
      password: 'a brand new passphrase',
    });
    expect(reset.status).toBe(200);

    expect(((await existing.get('/auth/me')).body as MeBody).user).toBeNull();
    expect((await browser.post('/auth/login', { email: EMAIL, password: PASSWORD })).status).toBe(
      401,
    );
    expect(
      (await browser.post('/auth/login', { email: EMAIL, password: 'a brand new passphrase' }))
        .status,
    ).toBe(200);
    expect(
      (await browser.post('/auth/reset-password', { token, password: 'yet another one' })).status,
    ).toBe(400);
  });
});

describe('profile', () => {
  it('changes the handle and reports a taken one against the field', async () => {
    const ada = await signedInBrowser(harness, EMAIL);
    await signedInBrowser(harness, 'grace@example.test');

    const renamed = await ada.patch('/auth/me', { handle: 'Countess', name: 'Ada L.' });
    expect(renamed.body).toMatchObject({ user: { handle: 'countess', name: 'Ada L.' } });

    const taken = await ada.patch('/auth/me', { handle: 'grace' });
    expect(taken.status).toBe(409);
    expect(taken.body).toMatchObject({ error: { details: [{ field: 'handle' }] } });
  });

  it('changes the password only when the current one is supplied', async () => {
    const ada = await signedInBrowser(harness, EMAIL, PASSWORD);

    const wrong = await ada.post('/auth/change-password', {
      currentPassword: 'guess',
      newPassword: 'a brand new passphrase',
    });
    expect(wrong.status).toBe(400);

    const right = await ada.post('/auth/change-password', {
      currentPassword: PASSWORD,
      newPassword: 'a brand new passphrase',
    });
    expect(right.status).toBe(200);
    // The session that made the change survives it.
    expect(((await ada.get('/auth/me')).body as MeBody).user?.email).toBe(EMAIL);
  });
});

describe('rate limiting', () => {
  it('locks out repeated login attempts for one address', async () => {
    const limited = harness.appWith({ limits: createRateLimits(null) });
    const browser = await openBrowser(limited);

    let last = 0;
    for (let attempt = 0; attempt < 11; attempt += 1) {
      last = (await browser.post('/auth/login', { email: EMAIL, password: 'wrong password' }))
        .status;
    }
    expect(last).toBe(429);
  });
});

describe('google sign-in', () => {
  const fakeGoogle = (profile: {
    subject: string;
    email: string;
    emailVerified?: boolean;
  }): OAuthProvider => ({
    createAuthorizationUrl: (state) => new URL(`https://accounts.example/auth?state=${state}`),
    exchange: () =>
      Promise.resolve({
        subject: profile.subject,
        email: profile.email,
        emailVerified: profile.emailVerified ?? true,
        name: 'Ada Lovelace',
      }),
  });

  async function completeFlow(provider: OAuthProvider) {
    const app = harness.appWith({ google: provider });
    const browser = await openBrowser(app);
    const start = await browser.get('/auth/oauth/google');
    const state = new URL(start.headers.location as string).searchParams.get('state') ?? '';
    const callback = await browser.get(`/auth/oauth/google/callback?code=abc&state=${state}`);
    return { browser, start, callback };
  }

  it('reports that it is unavailable when not configured', async () => {
    const browser = await harness.browser();
    expect((await browser.get('/auth/oauth/google')).status).toBe(503);
  });

  it('creates a verified account and signs in', async () => {
    const { browser, callback } = await completeFlow(fakeGoogle({ subject: 'g-1', email: EMAIL }));
    expect(callback.status).toBe(302);
    expect(callback.headers.location).toMatch(/\/shelf$/);

    const me = (await browser.get('/auth/me')).body as MeBody;
    expect(me.user).toMatchObject({ email: EMAIL, emailVerified: true });
  });

  it('returns the same account on a second sign-in', async () => {
    const provider = fakeGoogle({ subject: 'g-1', email: EMAIL });
    const first = await completeFlow(provider);
    const second = await completeFlow(provider);

    const a = (await first.browser.get('/auth/me')).body as { user: { id: string } };
    const b = (await second.browser.get('/auth/me')).body as { user: { id: string } };
    expect(b.user.id).toBe(a.user.id);
  });

  it('rejects a callback whose state does not match the cookie', async () => {
    const app = harness.appWith({ google: fakeGoogle({ subject: 'g-1', email: EMAIL }) });
    const browser = await openBrowser(app);
    await browser.get('/auth/oauth/google');
    const callback = await browser.get('/auth/oauth/google/callback?code=abc&state=forged');

    expect(callback.headers.location).toMatch(/sign-in\?error=oauth$/);
    expect(((await browser.get('/auth/me')).body as MeBody).user).toBeNull();
  });

  it('refuses a Google address that Google has not verified', async () => {
    const { callback } = await completeFlow(
      fakeGoogle({ subject: 'g-1', email: EMAIL, emailVerified: false }),
    );
    expect(callback.headers.location).toMatch(/error=oauth_unverified$/);
  });

  it('takes over an unverified password signup, discarding its password', async () => {
    // Someone registers the victim's address before the victim does.
    const squatter = await harness.browser();
    await squatter.post('/auth/signup', { email: EMAIL, password: PASSWORD });

    await completeFlow(fakeGoogle({ subject: 'g-1', email: EMAIL }));

    expect(((await squatter.get('/auth/me')).body as MeBody).user).toBeNull();
    const fresh = await harness.browser();
    expect((await fresh.post('/auth/login', { email: EMAIL, password: PASSWORD })).status).toBe(
      401,
    );
  });
});
