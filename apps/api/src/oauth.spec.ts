import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  auth,
  Client,
  StreamableHTTPClientTransport,
  type OAuthClientInformationMixed,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type OAuthTokens,
} from '@modelcontextprotocol/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type {
  ConnectedAppDto,
  OAuthDecisionDto,
  OAuthDecisionInput,
  OAuthRequestDto,
  PromptDetailDto,
} from '@shelf/shared';

import { createApp } from './app.js';
import { createMemoryTransport } from './email/transport.js';
import type { OAuthOptions } from './oauth/config.js';
import {
  createApiHarness,
  signedInBrowser,
  tokenFromLastEmail,
  type ApiHarness,
  type Browser,
} from './testing/harness.js';
import { stubDeps } from './testing/stubDeps.js';

/**
 * The OAuth 2.1 authorization server, driven by the MCP SDK's own client: the
 * same discovery, registration, PKCE, issuer checks, and refresh logic a real
 * MCP client runs. The API listens on an address its metadata names, as a
 * deployed one does, so the client's checks see what they would in production.
 */
let harness: ApiHarness;
let server: Server;
let origin: string;
let endpoint: URL;
let alice: Browser;

const WEB = 'http://web.test';
const REDIRECT = 'http://127.0.0.1:43110/callback';
const METADATA_URL = 'https://client.test/oauth/metadata.json';

/** What the client's web server would answer with for its metadata document. */
let metadataDocuments: Map<string, unknown>;

beforeAll(async () => {
  server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  endpoint = new URL(`${origin}/mcp`);

  const oauth: OAuthOptions = {
    apiUrl: origin,
    webUrl: WEB,
    fetchClientMetadata: (url) => {
      const document = metadataDocuments.get(url.href);
      return document === undefined ? Promise.reject(new Error('404')) : Promise.resolve(document);
    },
  };
  // Both servers share the database and configuration: the harness's for the
  // browser session, this one for the address the metadata names.
  harness = await createApiHarness({ oauth });
  server.on(
    'request',
    createApp(stubDeps({ db: harness.database.db, email: createMemoryTransport(), oauth })),
  );
}, 60_000);

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
  await harness.close();
});

beforeEach(async () => {
  await harness.database.truncate();
  harness.outbox.length = 0;
  metadataDocuments = new Map();
  alice = await signedInBrowser(harness, 'alice@example.test');
});

/**
 * An MCP client's side of the flow, kept in memory. `redirectToAuthorization`
 * records the URL a real client would open in the browser.
 */
class TestClient implements OAuthClientProvider {
  authorizationUrl: URL | undefined;
  private information: OAuthClientInformationMixed | undefined;
  private saved: OAuthTokens | undefined;
  private verifier = '';
  private discovery: OAuthDiscoveryState | undefined;

  constructor(
    private readonly options: { redirectUrl?: string; clientMetadataUrl?: string } = {},
  ) {}

  get redirectUrl(): string {
    return this.options.redirectUrl ?? REDIRECT;
  }

  get clientMetadataUrl(): string | undefined {
    return this.options.clientMetadataUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Test client',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }

  clientInformation() {
    return this.information;
  }
  saveClientInformation(information: OAuthClientInformationMixed) {
    this.information = information;
  }
  tokens() {
    return this.saved;
  }
  saveTokens(tokens: OAuthTokens) {
    this.saved = tokens;
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
  }
  saveCodeVerifier(verifier: string) {
    this.verifier = verifier;
  }
  codeVerifier() {
    return this.verifier;
  }
  discoveryState() {
    return this.discovery;
  }
  saveDiscoveryState(state: OAuthDiscoveryState) {
    this.discovery = state;
  }
  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery') {
    if (scope === 'all' || scope === 'tokens') this.saved = undefined;
    if (scope === 'all' || scope === 'client') this.information = undefined;
  }

  get clientId(): string {
    return this.information?.client_id ?? '';
  }
  get accessToken(): string {
    return this.saved?.access_token ?? '';
  }
  get refreshToken(): string {
    return this.saved?.refresh_token ?? '';
  }
}

/** The browser following the authorize URL: where the API sends it. */
async function follow(url: URL | string): Promise<URL> {
  const response = await fetch(url, { redirect: 'manual' });
  expect(response.status).toBe(302);
  return new URL(response.headers.get('location') ?? '');
}

const requestIdOf = (consent: URL): string => {
  expect(consent.origin + consent.pathname).toBe(`${WEB}/oauth/consent`);
  return consent.searchParams.get('request') ?? '';
};

async function decide(
  browser: Browser,
  requestId: string,
  decision: OAuthDecisionInput,
): Promise<URL> {
  const response = await browser.post(`/oauth/requests/${requestId}/decision`, decision);
  expect(response.status).toBe(200);
  return new URL((response.body as OAuthDecisionDto).redirectTo);
}

/** Runs the whole flow: the client starts, the user approves, the client redeems the code. */
async function connect(
  client: TestClient,
  decision: OAuthDecisionInput = { approve: true, write: true },
  browser: Browser = alice,
): Promise<URL> {
  expect(await auth(client, { serverUrl: endpoint })).toBe('REDIRECT');
  const back = await decide(
    browser,
    requestIdOf(await follow(client.authorizationUrl ?? '')),
    decision,
  );
  const code = back.searchParams.get('code') ?? undefined;
  const iss = back.searchParams.get('iss') ?? undefined;
  expect(await auth(client, { serverUrl: endpoint, authorizationCode: code, iss })).toBe(
    'AUTHORIZED',
  );
  return back;
}

async function mcpClient(provider: TestClient): Promise<Client> {
  const client = new Client({ name: 'shelf-tests', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(endpoint, { authProvider: provider }));
  return client;
}

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'raw', version: '1' },
  },
};

/** One raw request to /mcp with a bearer token: 200 while it works, 401 once it does not. */
const mcpAs = (token: string) =>
  request(server)
    .post('/mcp')
    .set('Authorization', `Bearer ${token}`)
    .set('Accept', 'application/json, text/event-stream')
    .send(INITIALIZE);

/** An MCP client holding a fixed token, recording every HTTP answer it gets. */
async function clientWithToken(accessToken: string) {
  const answers: Response[] = [];
  const client = new Client({ name: 'shelf-tests', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
      fetch: async (input, init) => {
        const response = await fetch(input, init);
        answers.push(response.clone());
        return response;
      },
    }),
  );
  return { client, answers };
}

async function token(params: Record<string, string>) {
  const response = await fetch(`${origin}/api/v1/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function register(body: object) {
  return request(server).post('/api/v1/oauth/register').send(body);
}

/** A registered client and a PKCE pair, for the rules a well-behaved SDK never breaks. */
async function manualClient(redirectUris = [REDIRECT]) {
  const registered = await register({ client_name: 'Manual', redirect_uris: redirectUris });
  expect(registered.status).toBe(201);
  const verifier = randomBytes(32).toString('base64url');
  return {
    clientId: (registered.body as { client_id: string }).client_id,
    verifier,
    challenge: createHash('sha256').update(verifier).digest('base64url'),
  };
}

function authorizeUrl(params: Record<string, string>): string {
  return `${origin}/api/v1/oauth/authorize?${new URLSearchParams(params).toString()}`;
}

async function codeFor(
  manual: Awaited<ReturnType<typeof manualClient>>,
  redirectUri = REDIRECT,
): Promise<string> {
  const consent = await follow(
    authorizeUrl({
      response_type: 'code',
      client_id: manual.clientId,
      redirect_uri: redirectUri,
      code_challenge: manual.challenge,
      code_challenge_method: 'S256',
      resource: endpoint.href,
      state: 's1',
    }),
  );
  const back = await decide(alice, requestIdOf(consent), { approve: true });
  return back.searchParams.get('code') ?? '';
}

describe('discovery', () => {
  it('starts from the 401, which names the protected resource metadata', async () => {
    const response = await request(server).post('/mcp').send(INITIALIZE);
    expect(response.status).toBe(401);
    expect(response.headers['www-authenticate']).toContain(
      `resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
    );
  });

  it('names Shelf as the authorization server for /mcp, at both well-known paths', async () => {
    for (const path of [
      '/.well-known/oauth-protected-resource/mcp',
      '/.well-known/oauth-protected-resource',
    ]) {
      const response = await request(server).get(path);
      expect(response.body).toMatchObject({
        resource: `${origin}/mcp`,
        authorization_servers: [origin],
        scopes_supported: ['prompts:read', 'prompts:write'],
      });
    }
  });

  it('describes the authorization server, which any origin may read', async () => {
    const response = await request(server)
      .get('/.well-known/oauth-authorization-server')
      .set('Origin', 'https://inspector.example');
    expect(response.status).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBe('*');
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
    expect(response.body).toMatchObject({
      issuer: origin,
      token_endpoint: `${origin}/api/v1/oauth/token`,
      code_challenge_methods_supported: ['S256'],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    });
  });

  it('keeps the session API closed to other origins', async () => {
    const response = await request(server)
      .get('/api/v1/access/apps')
      .set('Origin', 'https://inspector.example');
    expect(response.status).toBe(403);
  });
});

describe('connecting a client', () => {
  it('registers, gets the user’s consent, and uses the shelf', async () => {
    await alice.post('/prompts', {
      title: 'Commit message',
      category: 'writing',
      body: 'Hi {{name}}',
    });
    const provider = new TestClient();
    const back = await connect(provider);

    expect(back.origin + back.pathname).toBe(REDIRECT);
    expect(back.searchParams.get('iss')).toBe(origin);
    expect(provider.accessToken).toMatch(/^shelf_at_/);
    expect(provider.refreshToken).toMatch(/^shelf_rt_/);

    const client = await mcpClient(provider);
    expect((await client.listPrompts()).prompts.map((prompt) => prompt.name)).toEqual([
      'commit-message',
    ]);
    const saved = await client.callTool({
      name: 'create_prompt',
      arguments: { title: 'From Claude', body: 'Hello' },
    });
    expect(saved.isError).toBeFalsy();
  });

  it('can identify itself with a client ID metadata document instead', async () => {
    metadataDocuments.set(METADATA_URL, {
      client_id: METADATA_URL,
      client_name: 'Documented client',
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
    });
    const provider = new TestClient({ clientMetadataUrl: METADATA_URL });
    expect(await auth(provider, { serverUrl: endpoint })).toBe('REDIRECT');
    expect(provider.clientId).toBe(METADATA_URL);

    const requestId = requestIdOf(await follow(provider.authorizationUrl ?? ''));
    const shown = (await alice.get(`/oauth/requests/${requestId}`)).body as OAuthRequestDto;
    expect(shown.client).toEqual({ name: 'Documented client', publishedBy: 'client.test' });

    const back = await decide(alice, requestId, { approve: true });
    await auth(provider, {
      serverUrl: endpoint,
      authorizationCode: back.searchParams.get('code') ?? '',
      iss: back.searchParams.get('iss') ?? '',
    });
    expect((await (await mcpClient(provider)).listPrompts()).prompts).toEqual([]);
  });

  it('refuses a metadata document that does not describe the client', async () => {
    metadataDocuments.set(METADATA_URL, {
      client_id: 'https://someone-else.test/metadata.json',
      redirect_uris: [REDIRECT],
    });
    const consent = await follow(
      authorizeUrl({
        response_type: 'code',
        client_id: METADATA_URL,
        redirect_uri: REDIRECT,
        code_challenge: 'x'.repeat(43),
        code_challenge_method: 'S256',
        resource: endpoint.href,
      }),
    );
    expect(consent.href).toBe(`${WEB}/oauth/consent?error=invalid_client`);
  });

  it('refreshes by itself when the access token lapses', async () => {
    const provider = new TestClient();
    await connect(provider);
    const client = await mcpClient(provider);
    const first = provider.accessToken;

    await harness.database.pool.query(
      `UPDATE access_tokens SET expires_at = now() - interval '1 second' WHERE kind = 'access'`,
    );
    expect((await client.listPrompts()).prompts).toEqual([]);
    expect(provider.accessToken).not.toBe(first);
  });
});

describe('the consent page', () => {
  async function pending(): Promise<string> {
    const provider = new TestClient();
    expect(await auth(provider, { serverUrl: endpoint })).toBe('REDIRECT');
    return requestIdOf(await follow(provider.authorizationUrl ?? ''));
  }

  it('shows the app, where it leads, and what it asks for, to a signed-in user', async () => {
    const id = await pending();
    expect((await request(harness.app).get(`/api/v1/oauth/requests/${id}`)).status).toBe(401);

    const shown = (await alice.get(`/oauth/requests/${id}`)).body as OAuthRequestDto;
    expect(shown).toMatchObject({
      client: { name: 'Test client', publishedBy: null },
      redirect: { kind: 'loopback', target: 'an app on this computer' },
      scopes: ['prompts:read', 'prompts:write'],
      current: null,
    });
  });

  it('needs the CSRF token to decide', async () => {
    const id = await pending();
    const forged = await alice.agent
      .post(`/api/v1/oauth/requests/${id}/decision`)
      .send({ approve: true });
    expect(forged.status).toBe(403);
  });

  it('sends a denial back to the app, with state and issuer, and no code', async () => {
    const provider = new TestClient();
    await auth(provider, { serverUrl: endpoint });
    const id = requestIdOf(await follow(provider.authorizationUrl ?? ''));
    const back = await decide(alice, id, { approve: false });

    expect(back.searchParams.get('error')).toBe('access_denied');
    expect(back.searchParams.get('iss')).toBe(origin);
    expect(back.searchParams.get('state')).toBe(
      provider.authorizationUrl?.searchParams.get('state'),
    );
    expect(back.searchParams.has('code')).toBe(false);
    expect((await alice.get(`/oauth/requests/${id}`)).status).toBe(404);
  });

  it('answers once, and not after ten minutes', async () => {
    const answered = await pending();
    await decide(alice, answered, { approve: true });
    expect(
      (await alice.post(`/oauth/requests/${answered}/decision`, { approve: true })).status,
    ).toBe(404);

    const lapsed = await pending();
    await harness.database.pool.query(
      `UPDATE oauth_requests SET expires_at = now() - interval '1 second' WHERE id = $1`,
      [lapsed],
    );
    expect((await alice.get(`/oauth/requests/${lapsed}`)).status).toBe(404);
  });

  it('cannot limit an app to someone else’s collection', async () => {
    const bob = await signedInBrowser(harness, 'bob@example.test');
    const theirs = await bob.post('/collections', { name: 'Bob only' });
    const response = await alice.post(`/oauth/requests/${await pending()}/decision`, {
      approve: true,
      promptSet: 'collection',
      collectionId: (theirs.body as { collection: { id: string } }).collection.id,
    });
    expect(response.status).toBe(400);
  });

  it('remembers the user’s choices for an app they approved before', async () => {
    const provider = new TestClient();
    await connect(provider, { approve: true, write: false, promptSet: 'pinned' });
    await auth(provider, { serverUrl: endpoint, forceReauthorization: true });
    const id = requestIdOf(await follow(provider.authorizationUrl ?? ''));
    const shown = (await alice.get(`/oauth/requests/${id}`)).body as OAuthRequestDto;
    expect(shown.current).toEqual({
      scopes: ['prompts:read'],
      promptSet: 'pinned',
      collectionId: null,
    });
  });
});

describe('rules', () => {
  it('requires PKCE with S256, refusing plain', async () => {
    const manual = await manualClient();
    const attempts: Record<string, string>[] = [
      { code_challenge: manual.verifier, code_challenge_method: 'plain' },
      {},
    ];
    for (const extra of attempts) {
      const back = await follow(
        authorizeUrl({
          response_type: 'code',
          client_id: manual.clientId,
          redirect_uri: REDIRECT,
          resource: endpoint.href,
          state: 'st',
          ...extra,
        }),
      );
      expect(back.searchParams.get('error')).toBe('invalid_request');
      expect(back.searchParams.get('state')).toBe('st');
      expect(back.searchParams.get('iss')).toBe(origin);
    }
  });

  it('never sends anything to a redirect URI the client did not register', async () => {
    const manual = await manualClient();
    const back = await follow(
      authorizeUrl({
        response_type: 'code',
        client_id: manual.clientId,
        redirect_uri: 'https://attacker.example/steal',
        code_challenge: manual.challenge,
        code_challenge_method: 'S256',
        resource: endpoint.href,
      }),
    );
    expect(back.href).toBe(`${WEB}/oauth/consent?error=invalid_redirect_uri`);
  });

  it('accepts a registered loopback redirect on any port', async () => {
    const manual = await manualClient(['http://127.0.0.1/callback']);
    const code = await codeFor(manual, 'http://127.0.0.1:61234/callback');
    expect(code).toMatch(/^shelf_ac_/);
  });

  it('refuses plain HTTP redirect URIs other than loopback at registration', async () => {
    const response = await register({ redirect_uris: ['http://client.example/cb'] });
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: 'invalid_redirect_uri' });
    expect((await register({ redirect_uris: ['javascript:alert(1)'] })).status).toBe(400);
  });

  it('registers public clients only, whatever they ask for', async () => {
    const response = await register({
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'client_secret_basic',
    });
    expect(response.body).toMatchObject({ token_endpoint_auth_method: 'none' });
    expect(response.body).not.toHaveProperty('client_secret');
  });

  it('refuses a wrong verifier, a wrong redirect URI, and another client', async () => {
    const manual = await manualClient();
    const other = await manualClient();
    const base = {
      grant_type: 'authorization_code',
      client_id: manual.clientId,
      redirect_uri: REDIRECT,
    };

    for (const params of [
      { ...base, code_verifier: randomBytes(32).toString('base64url') },
      { ...base, code_verifier: manual.verifier, redirect_uri: 'http://127.0.0.1:43110/other' },
      { ...base, code_verifier: manual.verifier, client_id: other.clientId },
    ]) {
      const code = await codeFor(manual);
      const answer = await token({ ...params, code });
      expect(answer.status).toBe(400);
      expect(answer.body.error).toBe('invalid_grant');
    }
  });

  it('redeems a code once, and revokes what it produced when it is replayed', async () => {
    const manual = await manualClient();
    const code = await codeFor(manual);
    const params = {
      grant_type: 'authorization_code',
      client_id: manual.clientId,
      redirect_uri: REDIRECT,
      code_verifier: manual.verifier,
      code,
    };
    const first = await token(params);
    expect(first.status).toBe(200);
    expect((await mcpAs(String(first.body.access_token))).status).toBe(200);

    const replay = await token(params);
    expect(replay.body.error).toBe('invalid_grant');
    expect((await mcpAs(String(first.body.access_token))).status).toBe(401);
  });

  it('lets a code live 60 seconds', async () => {
    const manual = await manualClient();
    const code = await codeFor(manual);
    await harness.database.pool.query(
      `UPDATE oauth_requests SET code_expires_at = now() - interval '1 second'`,
    );
    const answer = await token({
      grant_type: 'authorization_code',
      client_id: manual.clientId,
      redirect_uri: REDIRECT,
      code_verifier: manual.verifier,
      code,
    });
    expect(answer.body.error).toBe('invalid_grant');
  });

  it('binds tokens to /mcp: other resources are refused at every step', async () => {
    const manual = await manualClient();
    const back = await follow(
      authorizeUrl({
        response_type: 'code',
        client_id: manual.clientId,
        redirect_uri: REDIRECT,
        code_challenge: manual.challenge,
        code_challenge_method: 'S256',
        resource: 'https://elsewhere.example/api',
      }),
    );
    expect(back.searchParams.get('error')).toBe('invalid_target');

    const answer = await token({
      grant_type: 'authorization_code',
      client_id: manual.clientId,
      redirect_uri: REDIRECT,
      code_verifier: manual.verifier,
      code: await codeFor(manual),
      resource: 'https://elsewhere.example/api',
    });
    expect(answer.body.error).toBe('invalid_target');

    const provider = new TestClient();
    await connect(provider);
    await harness.database.pool.query(
      `UPDATE access_tokens SET resource = 'https://elsewhere.example/api'`,
    );
    const refused = await mcpAs(provider.accessToken);
    expect(refused.status).toBe(401);
    expect(refused.headers['www-authenticate']).toContain('error="invalid_token"');
  });

  it('rotates refresh tokens, and revokes the family when one is reused', async () => {
    const provider = new TestClient();
    await connect(provider);
    const stolen = provider.refreshToken;

    const rotated = await token({
      grant_type: 'refresh_token',
      client_id: provider.clientId,
      refresh_token: stolen,
    });
    expect(rotated.status).toBe(200);
    expect(rotated.body.refresh_token).not.toBe(stolen);
    const live = String(rotated.body.access_token);
    expect((await mcpAs(live)).status).toBe(200);

    // Past the moment in which a second use is a concurrent refresh.
    await harness.database.pool.query(
      `UPDATE access_tokens SET consumed_at = now() - interval '11 seconds' WHERE consumed_at IS NOT NULL`,
    );
    const reuse = await token({
      grant_type: 'refresh_token',
      client_id: provider.clientId,
      refresh_token: stolen,
    });
    expect(reuse.body.error).toBe('invalid_grant');
    expect((await mcpAs(live)).status).toBe(401);
    const next = await token({
      grant_type: 'refresh_token',
      client_id: provider.clientId,
      refresh_token: String(rotated.body.refresh_token),
    });
    expect(next.body.error).toBe('invalid_grant');
  });

  it('treats a refresh token presented by another client as stolen', async () => {
    const provider = new TestClient();
    await connect(provider);
    const other = await manualClient();
    const answer = await token({
      grant_type: 'refresh_token',
      client_id: other.clientId,
      refresh_token: provider.refreshToken,
    });
    expect(answer.body.error).toBe('invalid_grant');
    expect((await mcpAs(provider.accessToken)).status).toBe(401);
  });

  it('revokes on request (RFC 7009), for the client the token belongs to only', async () => {
    const provider = new TestClient();
    await connect(provider);
    const stranger = await manualClient();
    const revoke = (clientId: string, value: string) =>
      request(server)
        .post('/api/v1/oauth/revoke')
        .type('form')
        .send({ client_id: clientId, token: value });

    expect((await revoke(stranger.clientId, provider.refreshToken)).status).toBe(200);
    expect((await mcpAs(provider.accessToken)).status).toBe(200);

    expect((await revoke(provider.clientId, provider.refreshToken)).status).toBe(200);
    expect((await mcpAs(provider.accessToken)).status).toBe(401);
    expect((await revoke(provider.clientId, 'never-issued')).status).toBe(200);
  });

  it('answers unknown clients and grant types in OAuth’s own terms', async () => {
    expect(
      (await token({ grant_type: 'authorization_code', client_id: 'nobody' })).body.error,
    ).toBe('invalid_client');
    const manual = await manualClient();
    expect(
      (await token({ grant_type: 'client_credentials', client_id: manual.clientId })).body.error,
    ).toBe('unsupported_grant_type');
  });
});

describe('scopes and prompt sets', () => {
  it('may be narrowed by the user, and a write then asks for the wider grant', async () => {
    const provider = new TestClient();
    await connect(provider, { approve: true, write: false });

    const { client, answers } = await clientWithToken(provider.accessToken);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain('create_prompt');

    await expect(
      client.callTool({ name: 'create_prompt', arguments: { title: 'x', body: 'y' } }),
    ).rejects.toThrow();
    const refused = answers.at(-1);
    const challenge = refused?.headers.get('www-authenticate') ?? '';
    expect(refused?.status).toBe(403);
    expect(challenge).toContain('error="insufficient_scope"');
    expect(challenge).toContain('prompts:write');
    expect(challenge).toContain(
      `resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
    );
  });

  it('limit what the app sees to the set the user chose', async () => {
    const pinned = (
      await alice.post('/prompts', { title: 'Pinned', category: 'writing', body: 'a' })
    ).body as { prompt: PromptDetailDto };
    await alice.patch(`/prompts/${pinned.prompt.id}`, { pinned: true });
    await alice.post('/prompts', { title: 'Other', category: 'writing', body: 'b' });

    const provider = new TestClient();
    await connect(provider, { approve: true, promptSet: 'pinned' });
    const client = await mcpClient(provider);
    expect((await client.listPrompts()).prompts.map((prompt) => prompt.name)).toEqual(['pinned']);
  });
});

describe('connected apps in Settings', () => {
  it('lists the app, and disconnecting it revokes it at once', async () => {
    const provider = new TestClient();
    await connect(provider);

    const listed = (await alice.get('/access/apps')).body as { apps: ConnectedAppDto[] };
    expect(listed.apps).toHaveLength(1);
    expect(listed.apps[0]).toMatchObject({
      name: 'Test client',
      publishedBy: null,
      scopes: ['prompts:read', 'prompts:write'],
      promptSet: 'all',
    });
    expect((await alice.get('/access/tokens')).body).toEqual({ tokens: [] });

    const bob = await signedInBrowser(harness, 'bob@example.test');
    const id = listed.apps[0]?.id ?? '';
    expect((await bob.delete(`/access/apps/${id}`)).status).toBe(404);
    expect((await alice.delete(`/access/apps/${id}`)).status).toBe(204);
    expect((await mcpAs(provider.accessToken)).status).toBe(401);
    expect(
      (
        await token({
          grant_type: 'refresh_token',
          client_id: provider.clientId,
          refresh_token: provider.refreshToken,
        })
      ).body.error,
    ).toBe('invalid_grant');
  });

  it('are revoked by a password reset', async () => {
    const provider = new TestClient();
    await connect(provider);
    await alice.post('/auth/forgot-password', { email: 'alice@example.test' });
    await alice.post('/auth/reset-password', {
      token: tokenFromLastEmail(harness.outbox),
      password: 'a brand new passphrase',
    });
    expect((await mcpAs(provider.accessToken)).status).toBe(401);
  });
});
