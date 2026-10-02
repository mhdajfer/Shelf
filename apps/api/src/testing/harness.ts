import type { Express } from 'express';
import request from 'supertest';

import { createTestDatabase, type TestDatabase } from '@shelf/db/testing';

import { API_PREFIX, createApp, type AppDeps } from '../app.js';
import { createMemoryTransport, type EmailMessage } from '../email/transport.js';
import { stubDeps } from './stubDeps.js';

export type Agent = ReturnType<typeof request.agent>;

export interface ApiHarness {
  app: Express;
  database: TestDatabase;
  /** Every email the app "sent", newest last. */
  outbox: EmailMessage[];
  /** A cookie-keeping client with a CSRF token already attached to writes. */
  browser: () => Promise<Browser>;
  /** Rebuilds the app with different dependencies over the same database. */
  appWith: (overrides: Partial<AppDeps>) => Express;
  close: () => Promise<void>;
}

export interface Browser {
  agent: Agent;
  csrf: string;
  get: (path: string) => request.Test;
  post: (path: string, body?: object) => request.Test;
  patch: (path: string, body?: object) => request.Test;
  put: (path: string, body?: object) => request.Test;
  delete: (path: string) => request.Test;
}

export const url = (path: string): string => `${API_PREFIX}${path}`;

export async function openBrowser(app: Express): Promise<Browser> {
  const agent = request.agent(app);
  const response = await agent.get(url('/auth/csrf'));
  const csrf = (response.body as { csrfToken: string }).csrfToken;

  return {
    agent,
    csrf,
    get: (path) => agent.get(url(path)),
    post: (path, body = {}) => agent.post(url(path)).set('x-csrf-token', csrf).send(body),
    patch: (path, body = {}) => agent.patch(url(path)).set('x-csrf-token', csrf).send(body),
    put: (path, body = {}) => agent.put(url(path)).set('x-csrf-token', csrf).send(body),
    delete: (path) => agent.delete(url(path)).set('x-csrf-token', csrf),
  };
}

export async function createApiHarness(overrides: Partial<AppDeps> = {}): Promise<ApiHarness> {
  const database = await createTestDatabase();
  const email = createMemoryTransport();

  const appWith = (extra: Partial<AppDeps>): Express =>
    createApp(stubDeps({ db: database.db, email, ...overrides, ...extra }));
  const app = appWith({});

  return {
    app,
    database,
    outbox: email.sent,
    browser: () => openBrowser(app),
    appWith,
    close: () => database.close(),
  };
}

/** Pulls the single-use token out of the most recent emailed link. */
export function tokenFromLastEmail(outbox: EmailMessage[]): string {
  const message = outbox.at(-1);
  const match = message?.text.match(/[?&]token=([^\s&]+)/);
  if (match?.[1] === undefined) throw new Error('no token link in the last email');
  return decodeURIComponent(match[1]);
}

/** Signs up and verifies a user, returning a browser already signed in as them. */
export async function signedInBrowser(
  harness: ApiHarness,
  email: string,
  password = 'correct horse battery',
): Promise<Browser> {
  const browser = await harness.browser();
  const signup = await browser.post('/auth/signup', { email, password });
  if (signup.status !== 201) {
    throw new Error(`signup failed: ${String(signup.status)} ${JSON.stringify(signup.body)}`);
  }
  await browser.post('/auth/verify-email', { token: tokenFromLastEmail(harness.outbox) });
  return browser;
}
