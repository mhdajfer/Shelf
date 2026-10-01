import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { API_PREFIX, createApp } from './app.js';

const healthy = { database: () => Promise.resolve(true), redis: () => Promise.resolve(true) };
const app = createApp({ health: healthy });

describe('app', () => {
  it('reports health when both datastores answer', async () => {
    const response = await request(app).get(`${API_PREFIX}/health`);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: 'ok',
      checks: { database: 'ok', redis: 'ok' },
    });
  });

  it('reports 503 and names the failing datastore', async () => {
    const degraded = createApp({
      health: { database: () => Promise.resolve(true), redis: () => Promise.resolve(false) },
    });
    const response = await request(degraded).get(`${API_PREFIX}/health`);
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      status: 'degraded',
      checks: { database: 'ok', redis: 'down' },
    });
  });

  it('returns the error envelope for an unknown route', async () => {
    const response = await request(app).get(`${API_PREFIX}/nope`);
    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      error: { code: 'not_found', message: 'That endpoint does not exist.' },
    });
  });

  it('stamps a request id on every response', async () => {
    const response = await request(app).get(`${API_PREFIX}/health`);
    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('echoes a caller supplied request id', async () => {
    const response = await request(app)
      .get(`${API_PREFIX}/health`)
      .set('x-request-id', 'trace-123');
    expect(response.headers['x-request-id']).toBe('trace-123');
  });

  it('does not advertise the framework', async () => {
    const response = await request(app).get(`${API_PREFIX}/health`);
    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  it('sets the helmet baseline headers', async () => {
    const response = await request(app).get(`${API_PREFIX}/health`);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['cross-origin-resource-policy']).toBe('same-site');
  });

  it('allows a configured browser origin with credentials', async () => {
    const response = await request(app)
      .get(`${API_PREFIX}/health`)
      .set('Origin', 'http://localhost:3000');
    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    expect(response.headers['access-control-allow-credentials']).toBe('true');
  });

  it('rejects an origin that is not on the allowlist', async () => {
    const response = await request(app)
      .get(`${API_PREFIX}/health`)
      .set('Origin', 'http://evil.test');
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ error: { code: 'forbidden' } });
  });
});
