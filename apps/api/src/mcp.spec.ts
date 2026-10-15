import type { AddressInfo } from 'node:net';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type {
  AccessTokenDto,
  CreateAccessTokenInput,
  CreatedAccessTokenDto,
  PromptDetailDto,
  PromptVersionDto,
} from '@shelf/shared';

import { encodeCursor } from './mcp/naming.js';
import {
  createApiHarness,
  signedInBrowser,
  type ApiHarness,
  type Browser,
} from './testing/harness.js';

/**
 * The MCP endpoint, driven by the SDK's own client over HTTP against the real
 * app and database. Every protocol test runs on both revisions the endpoint
 * serves: 2026-07-28, and the 2025 handshake older clients still use.
 */
let harness: ApiHarness;
let alice: Browser;
let endpoint: URL;

const ERAS = [
  { era: '2026-07-28', options: { versionNegotiation: { mode: { pin: '2026-07-28' } } } },
  { era: '2025 handshake', options: {} },
] as const;

beforeAll(async () => {
  harness = await createApiHarness();
  const { port } = harness.app.address() as AddressInfo;
  endpoint = new URL(`http://127.0.0.1:${String(port)}/mcp`);
}, 60_000);

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  await harness.database.truncate();
  harness.outbox.length = 0;
  alice = await signedInBrowser(harness, 'alice@example.test');
});

async function savePrompt(
  browser: Browser,
  input: { title: string; body: string; visibility?: 'public' | 'private'; tags?: string[] },
): Promise<PromptDetailDto> {
  const response = await browser.post('/prompts', { category: 'writing', ...input });
  expect(response.status).toBe(201);
  return (response.body as { prompt: PromptDetailDto }).prompt;
}

async function issueToken(
  browser: Browser,
  input: Partial<CreateAccessTokenInput> = {},
): Promise<CreatedAccessTokenDto> {
  const response = await browser.post('/access/tokens', { name: 'Laptop', ...input });
  expect(response.status).toBe(201);
  return response.body as CreatedAccessTokenDto;
}

async function connect(
  secret: string,
  options: (typeof ERAS)[number]['options'] = ERAS[0].options,
): Promise<Client> {
  const client = new Client({ name: 'shelf-tests', version: '1.0.0' }, options);
  await client.connect(
    new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: { Authorization: `Bearer ${secret}` } },
    }),
  );
  return client;
}

/** The text of a tool result, which is what a text-only client shows its model. */
const text = (result: Awaited<ReturnType<Client['callTool']>>): string =>
  (result.content as { type: string; text?: string }[]).map((block) => block.text ?? '').join('\n');

async function rejection(promise: Promise<unknown>): Promise<{ code?: number; message: string }> {
  try {
    await promise;
  } catch (error) {
    return error as { code?: number; message: string };
  }
  throw new Error('expected the request to fail');
}

describe('access tokens', () => {
  it('shows the secret once, and never again', async () => {
    const created = await issueToken(alice, { name: 'CI' });
    expect(created.secret).toMatch(/^shelf_pat_[A-Za-z0-9_-]{43}$/);
    expect(created.token).toMatchObject({ name: 'CI', scopes: ['prompts:read'], promptSet: 'all' });
    expect(created.secret.startsWith(created.token.display.replace('…', ''))).toBe(true);

    const listed = await alice.get('/access/tokens');
    expect(JSON.stringify(listed.body)).not.toContain(created.secret);
    expect((listed.body as { tokens: AccessTokenDto[] }).tokens).toHaveLength(1);
  });

  it('needs a session and a CSRF token to manage', async () => {
    expect((await request(harness.app).get('/api/v1/access/tokens')).status).toBe(401);
    const forged = await alice.agent.post('/api/v1/access/tokens').send({ name: 'x' });
    expect(forged.status).toBe(403);
  });

  it('cannot be scoped to someone else’s collection', async () => {
    const bob = await signedInBrowser(harness, 'bob@example.test');
    const theirs = await bob.post('/collections', { name: 'Bob only' });
    const response = await alice.post('/access/tokens', {
      name: 'x',
      promptSet: 'collection',
      collectionId: (theirs.body as { collection: { id: string } }).collection.id,
    });
    expect(response.status).toBe(400);
  });

  it('can be revoked by its owner only, and stops working at once', async () => {
    const created = await issueToken(alice);
    const bob = await signedInBrowser(harness, 'bob@example.test');
    expect((await bob.delete(`/access/tokens/${created.token.id}`)).status).toBe(404);

    const client = await connect(created.secret);
    expect((await alice.delete(`/access/tokens/${created.token.id}`)).status).toBe(204);
    await expect(client.listPrompts()).rejects.toThrow();
  });

  it('are revoked by a password reset', async () => {
    const created = await issueToken(alice);
    await alice.post('/auth/forgot-password', { email: 'alice@example.test' });
    const token = /[?&]token=([^\s&]+)/.exec(harness.outbox.at(-1)?.text ?? '')?.[1] ?? '';
    await alice.post('/auth/reset-password', {
      token: decodeURIComponent(token),
      password: 'a brand new password',
    });
    await expect(connect(created.secret)).rejects.toThrow();
  });

  it('do not authenticate the REST API', async () => {
    const created = await issueToken(alice);
    const response = await request(harness.app)
      .get('/api/v1/shelf/prompts')
      .set('Authorization', `Bearer ${created.secret}`);
    expect(response.status).toBe(401);
  });
});

describe('the MCP endpoint over HTTP', () => {
  const initialize = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'raw', version: '1' },
    },
  };
  const post = () =>
    request(harness.app)
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .send(initialize);

  it('asks for a bearer token when there is none', async () => {
    const response = await post();
    expect(response.status).toBe(401);
    expect(response.headers['www-authenticate']).toMatch(/^Bearer /);
  });

  it('refuses an unknown token', async () => {
    const response = await post().set('Authorization', 'Bearer shelf_pat_nope');
    expect(response.status).toBe(401);
    expect(response.headers['www-authenticate']).toContain('error="invalid_token"');
  });

  it('refuses an expired token', async () => {
    const created = await issueToken(alice);
    await harness.database.pool.query(
      `UPDATE access_tokens SET expires_at = now() - interval '1 second'`,
    );
    expect((await post().set('Authorization', `Bearer ${created.secret}`)).status).toBe(401);
  });

  it('ignores the session cookie entirely', async () => {
    const response = await alice.agent
      .post('/mcp')
      .set('Accept', 'application/json, text/event-stream')
      .send(initialize);
    expect(response.status).toBe(401);
  });

  it('refuses a browser origin that is not the site', async () => {
    const created = await issueToken(alice);
    const response = await post()
      .set('Authorization', `Bearer ${created.secret}`)
      .set('Origin', 'https://evil.example');
    expect(response.status).toBe(403);
  });

  it('is never cached', async () => {
    const created = await issueToken(alice);
    const response = await post().set('Authorization', `Bearer ${created.secret}`);
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store, no-transform');
  });
});

describe.each(ERAS)('prompts over $era', ({ options }) => {
  let client: Client;

  beforeEach(async () => {
    await savePrompt(alice, {
      title: 'Commit message (conventional)',
      body: 'Write a {{style:concise}} commit message for:\n\n{{diff}}',
    });
    await savePrompt(alice, { title: 'Bug report', body: 'Triage {{issue}}.' });
    client = await connect((await issueToken(alice)).secret, options);
  });

  it('lists prompts by command name, arguments in order of appearance', async () => {
    const { prompts } = await client.listPrompts();
    expect(prompts.map((prompt) => prompt.name)).toEqual([
      'bug-report',
      'commit-message-conventional',
    ]);
    expect(prompts[1]?.title).toBe('Commit message (conventional)');
    expect(prompts[1]?.arguments).toEqual([
      { name: 'style', required: false, description: 'Optional. Default: concise' },
      { name: 'diff', required: true },
    ]);
  });

  it('renders with the given arguments, defaults filling the rest', async () => {
    const result = await client.getPrompt({
      name: 'commit-message-conventional',
      arguments: { diff: '+ added a line', style: '' },
    });
    expect(result.messages).toEqual([
      {
        role: 'user',
        content: {
          type: 'text',
          text: 'Write a concise commit message for:\n\n+ added a line',
        },
      },
    ]);
  });

  it('names a missing required argument', async () => {
    const error = await rejection(
      client.getPrompt({ name: 'commit-message-conventional', arguments: {} }),
    );
    expect(error.code).toBe(-32602);
    expect(error.message).toContain('"diff"');
  });

  it('answers an unknown name and someone else’s prompt identically', async () => {
    const bob = await signedInBrowser(harness, 'bob@example.test');
    await savePrompt(bob, { title: 'Bob secret', body: 'Secret.' });

    const unknown = await rejection(client.getPrompt({ name: 'no-such-prompt' }));
    const theirs = await rejection(client.getPrompt({ name: 'bob-secret' }));
    expect(theirs.code).toBe(unknown.code);
    expect(theirs.message.replace('bob-secret', 'X')).toBe(
      unknown.message.replace('no-such-prompt', 'X'),
    );
  });

  it('offers a variable’s default as a completion', async () => {
    const result = await client.complete({
      ref: { type: 'ref/prompt', name: 'commit-message-conventional' },
      argument: { name: 'style', value: '' },
    });
    expect(result.completion.values).toEqual(['concise']);
  });

  it('pages a long list without repeats or gaps', async () => {
    for (let index = 0; index < 52; index += 1) {
      await savePrompt(alice, { title: `Bulk ${String(index).padStart(2, '0')}`, body: 'x' });
    }
    // Without a cursor the client follows nextCursor itself; pages hold at
    // most 50, so 54 prompts arriving complete and in order took two pages.
    const all = (await client.listPrompts()).prompts.map((prompt) => prompt.name);
    expect(all).toHaveLength(54);
    expect(new Set(all).size).toBe(54);
    expect(all).toEqual([...all].sort());

    const tail = await client.listPrompts({ cursor: encodeCursor('bulk-48') });
    expect(tail.prompts.map((prompt) => prompt.name)).toEqual([
      'bulk-49',
      'bulk-50',
      'bulk-51',
      'commit-message-conventional',
    ]);
    expect(tail.nextCursor).toBeUndefined();
  });

  it('refuses a cursor it did not issue', async () => {
    const error = await rejection(client.listPrompts({ cursor: 'not a cursor' }));
    expect(error.code).toBe(-32602);
  });

  it('serves each prompt as a Markdown resource', async () => {
    const { resources } = await client.listResources();
    expect(resources.map((resource) => resource.name)).toEqual([
      'bug-report',
      'commit-message-conventional',
    ]);
    const read = await client.readResource({ uri: resources[0]?.uri ?? '' });
    expect(read.contents[0]).toMatchObject({ mimeType: 'text/markdown' });
    expect((read.contents[0] as { text: string }).text).toContain('# Bug report');
  });
});

describe.each(ERAS)('tools over $era', ({ options }) => {
  it('read-only tokens see only the read-only tools', async () => {
    const client = await connect((await issueToken(alice)).secret, options);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'get_prompt',
      'list_collections',
      'render_prompt',
      'search_prompts',
    ]);
    for (const tool of tools) expect(tool.annotations?.readOnlyHint).toBe(true);
    await expect(
      client.callTool({ name: 'create_prompt', arguments: { title: 'x', body: 'y' } }),
    ).rejects.toThrow();
  });

  it('search, get, and render the user’s prompts and the public library', async () => {
    const mine = await savePrompt(alice, {
      title: 'Explain hysteresis',
      body: 'Explain {{concept}} simply.',
      tags: ['physics'],
    });
    const bob = await signedInBrowser(harness, 'bob@example.test');
    await savePrompt(bob, {
      title: 'Public hysteresis primer',
      body: 'Primer.',
      visibility: 'public',
    });
    const client = await connect((await issueToken(alice)).secret, options);

    const own = await client.callTool({
      name: 'search_prompts',
      arguments: { query: 'hysteresis' },
    });
    const ownResults = (own.structuredContent as { results: { id: string; ownedByYou: boolean }[] })
      .results;
    expect(ownResults).toEqual([expect.objectContaining({ id: mine.id, ownedByYou: true })]);

    const open = await client.callTool({
      name: 'search_prompts',
      arguments: { query: 'hysteresis', scope: 'public' },
    });
    expect(open.structuredContent).toMatchObject({
      results: [{ title: 'Public hysteresis primer', ownedByYou: false, commandName: null }],
    });

    const got = await client.callTool({
      name: 'get_prompt',
      arguments: { commandName: 'explain-hysteresis' },
    });
    expect(got.structuredContent).toMatchObject({
      body: 'Explain {{concept}} simply.',
      version: 1,
    });

    const rendered = await client.callTool({
      name: 'render_prompt',
      arguments: { id: mine.id, arguments: { concept: 'entropy' } },
    });
    expect(rendered.structuredContent).toMatchObject({ text: 'Explain entropy simply.' });

    const missing = await client.callTool({ name: 'render_prompt', arguments: { id: mine.id } });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toContain('"concept"');
  });

  it('read an earlier version by number', async () => {
    const prompt = await savePrompt(alice, { title: 'Evolving', body: 'First draft.' });
    await alice.patch(`/prompts/${prompt.id}`, { body: 'Second draft.', note: 'Tighter' });
    const client = await connect((await issueToken(alice)).secret, options);

    const first = await client.callTool({
      name: 'get_prompt',
      arguments: { id: prompt.id, version: 1 },
    });
    expect(first.structuredContent).toMatchObject({
      body: 'First draft.',
      version: 1,
      latestVersion: 2,
    });
  });
});

describe('privacy over MCP', () => {
  let bob: Browser;
  let secretId: string;
  let client: Client;

  beforeEach(async () => {
    bob = await signedInBrowser(harness, 'bob@example.test');
    secretId = (await savePrompt(bob, { title: 'Bob secret', body: 'Secret {{x}}.' })).id;
    client = await connect((await issueToken(alice, { write: true })).secret);
  });

  /** The same call with an id that never existed, to compare against. */
  const NEVER = '00000000-0000-4000-8000-000000000000';

  it.each(['get_prompt', 'render_prompt', 'update_prompt'])(
    '%s answers another user’s private prompt like one that never existed',
    async (name) => {
      const theirs = await client.callTool({ name, arguments: { id: secretId } });
      const absent = await client.callTool({ name, arguments: { id: NEVER } });
      expect(theirs.isError).toBe(true);
      expect(text(theirs)).toBe(text(absent));
    },
  );

  it('keeps another user’s private prompt out of every listing and search', async () => {
    const searches = await Promise.all([
      client.callTool({ name: 'search_prompts', arguments: { query: 'secret' } }),
      client.callTool({ name: 'search_prompts', arguments: { query: 'secret', scope: 'public' } }),
      client.callTool({ name: 'search_prompts', arguments: { scope: 'public' } }),
    ]);
    for (const search of searches) expect(JSON.stringify(search)).not.toContain(secretId);
    expect(JSON.stringify(await client.listPrompts())).not.toContain('Bob secret');
    expect(JSON.stringify(await client.listResources())).not.toContain(secretId);
  });

  it('refuses to read another user’s prompt as a resource', async () => {
    const theirs = await rejection(client.readResource({ uri: `shelf://prompts/${secretId}` }));
    const absent = await rejection(client.readResource({ uri: `shelf://prompts/${NEVER}` }));
    expect(theirs.code).toBe(-32602);
    expect(theirs.message.replace(secretId, 'X')).toBe(absent.message.replace(NEVER, 'X'));
  });

  it('gives an admin’s token no reach into hidden prompts', async () => {
    const hidden = await savePrompt(bob, {
      title: 'Reported prompt',
      body: 'Hidden.',
      visibility: 'public',
    });
    await harness.database.pool.query(`UPDATE prompts SET status = 'hidden' WHERE id = $1`, [
      hidden.id,
    ]);
    await harness.database.pool.query(`UPDATE users SET role = 'admin' WHERE email = $1`, [
      'alice@example.test',
    ]);
    // The admin can see it on the web, where moderation happens.
    expect((await alice.get(`/prompts/${hidden.id}`)).status).toBe(200);

    const admin = await connect((await issueToken(alice)).secret);
    const result = await admin.callTool({ name: 'get_prompt', arguments: { id: hidden.id } });
    expect(result.isError).toBe(true);
  });
});

describe('prompt sets', () => {
  it('limit a token to pinned prompts everywhere', async () => {
    const pinned = await savePrompt(alice, { title: 'Pinned one', body: 'P.' });
    const loose = await savePrompt(alice, { title: 'Loose one', body: 'L.' });
    await alice.patch(`/prompts/${pinned.id}`, { pinned: true });
    const client = await connect((await issueToken(alice, { promptSet: 'pinned' })).secret);

    expect((await client.listPrompts()).prompts.map((prompt) => prompt.name)).toEqual([
      'pinned-one',
    ]);
    await expect(client.getPrompt({ name: 'loose-one' })).rejects.toThrow();
    const byId = await client.callTool({ name: 'get_prompt', arguments: { id: loose.id } });
    expect(byId.isError).toBe(true);
    const listed = await client.callTool({ name: 'list_collections', arguments: {} });
    expect(listed.structuredContent).toEqual({ collections: [] });
  });

  it('limit a token to one collection, and stop it when the collection goes', async () => {
    const inside = await savePrompt(alice, { title: 'Inside', body: 'I.' });
    await savePrompt(alice, { title: 'Outside', body: 'O.' });
    const created = await alice.post('/collections', { name: 'Work' });
    const collectionId = (created.body as { collection: { id: string } }).collection.id;
    await alice.put(`/collections/${collectionId}/prompts/${inside.id}`);

    const token = await issueToken(alice, { promptSet: 'collection', collectionId });
    const client = await connect(token.secret);
    expect((await client.listPrompts()).prompts.map((prompt) => prompt.name)).toEqual(['inside']);

    await alice.delete(`/collections/${collectionId}`);
    await expect(connect(token.secret)).rejects.toThrow();
  });
});

describe('writes', () => {
  it('save a private prompt the web shelf then shows', async () => {
    const client = await connect((await issueToken(alice, { write: true })).secret);
    const saved = await client.callTool({
      name: 'create_prompt',
      arguments: { title: 'Release notes', body: 'Summarise {{changes}}.', tags: ['release'] },
    });
    expect(saved.isError).toBeFalsy();
    const { id, commandName } = saved.structuredContent as { id: string; commandName: string };
    expect(commandName).toBe('release-notes');

    const detail = (await alice.get(`/prompts/${id}`)).body as { prompt: PromptDetailDto };
    expect(detail.prompt).toMatchObject({
      visibility: 'private',
      category: 'other',
      commandName: 'release-notes',
      tags: ['release'],
    });
    expect((await client.listPrompts()).prompts.map((prompt) => prompt.name)).toContain(
      'release-notes',
    );
  });

  it('refuse to publish, whatever the arguments say', async () => {
    const client = await connect((await issueToken(alice, { write: true })).secret);
    const attempt = await client.callTool({
      name: 'create_prompt',
      arguments: { title: 'Sneaky', body: 'x', visibility: 'public' },
    });
    expect(attempt.isError).toBe(true);
    const shelf = (await alice.get('/shelf/prompts')).body as { items: unknown[] };
    expect(shelf.items).toEqual([]);
  });

  it('append a version with its note, and only when the body changed', async () => {
    const prompt = await savePrompt(alice, { title: 'Draft', body: 'One.' });
    const client = await connect((await issueToken(alice, { write: true })).secret);

    const changed = await client.callTool({
      name: 'update_prompt',
      arguments: { commandName: 'draft', body: 'Two.', note: 'From the CLI' },
    });
    expect(changed.structuredContent).toMatchObject({ version: 2, newVersion: true });

    const same = await client.callTool({
      name: 'update_prompt',
      arguments: { commandName: 'draft', body: 'Two.', title: 'Draft, renamed' },
    });
    expect(same.structuredContent).toMatchObject({
      version: 2,
      newVersion: false,
      title: 'Draft, renamed',
      commandName: 'draft',
    });

    const versions = (await alice.get(`/prompts/${prompt.id}/versions`)).body as {
      versions: PromptVersionDto[];
    };
    expect(versions.versions.map((version) => [version.number, version.note])).toEqual([
      [2, 'From the CLI'],
      [1, null],
    ]);
  });

  it('keep a prompt saved through a collection token inside that collection', async () => {
    const created = await alice.post('/collections', { name: 'Agent' });
    const collectionId = (created.body as { collection: { id: string } }).collection.id;
    const client = await connect(
      (await issueToken(alice, { write: true, promptSet: 'collection', collectionId })).secret,
    );

    await client.callTool({ name: 'create_prompt', arguments: { title: 'Made here', body: 'x' } });
    expect((await client.listPrompts()).prompts.map((prompt) => prompt.name)).toEqual([
      'made-here',
    ]);
  });
});

describe('command names on the web', () => {
  it('are shown to the owner only', async () => {
    const prompt = await savePrompt(alice, { title: 'Shared', body: 'x', visibility: 'public' });
    expect(prompt.commandName).toBe('shared');

    const bob = await signedInBrowser(harness, 'bob@example.test');
    const seen = (await bob.get(`/prompts/${prompt.id}`)).body as { prompt: PromptDetailDto };
    expect(seen.prompt.commandName).toBeNull();
  });

  it('can be changed, but not to one already in use', async () => {
    const prompt = await savePrompt(alice, { title: 'First', body: 'x' });
    await savePrompt(alice, { title: 'Second', body: 'x' });

    const renamed = await alice.patch(`/prompts/${prompt.id}`, { commandName: 'shipit' });
    expect((renamed.body as { prompt: PromptDetailDto }).prompt.commandName).toBe('shipit');

    const taken = await alice.patch(`/prompts/${prompt.id}`, { commandName: 'second' });
    expect(taken.status).toBe(409);
    const malformed = await alice.patch(`/prompts/${prompt.id}`, { commandName: 'two words' });
    expect(malformed.status).toBe(400);
  });
});
