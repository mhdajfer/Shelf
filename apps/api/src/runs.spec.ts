import type {
  CreditsDto,
  PromptDetailDto,
  RunDto,
  RunStreamEvent,
  SuggestDto,
  TightenDto,
} from '@shelf/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { LlmProvider } from './llm/provider.js';
import {
  createApiHarness,
  openBrowser,
  signedInBrowser,
  type ApiHarness,
  type Browser,
} from './testing/harness.js';

let harness: ApiHarness;
let ada: Browser;
let promptId: string;

beforeAll(async () => {
  harness = await createApiHarness();
}, 60_000);

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  await harness.database.truncate();
  harness.outbox.length = 0;
  ada = await signedInBrowser(harness, 'ada@example.test');
  promptId = await create(ada, { visibility: 'public' });
});

async function create(browser: Browser, overrides: object = {}): Promise<string> {
  const response = await browser.post('/prompts', {
    title: 'Summarize a changelog',
    category: 'writing',
    body: 'Summarize {{changelog}} for a {{audience:general}} reader.',
    ...overrides,
  });
  return (response.body as { prompt: PromptDetailDto }).prompt.id;
}

/** Parses a finished event stream into its events. */
function events(response: { text: string }): RunStreamEvent[] {
  return response.text
    .split('\n\n')
    .map((block) => block.split('\n').find((line) => line.startsWith('data: ')))
    .filter((line): line is string => line !== undefined)
    .map((line) => JSON.parse(line.slice('data: '.length)) as RunStreamEvent);
}

const credits = async (browser: Browser): Promise<CreditsDto> =>
  ((await browser.get('/credits')).body as { credits: CreditsDto }).credits;

/** A model that fails after emitting some text, like a dropped connection. */
const brokenModel: LlmProvider = {
  name: 'broken',
  model: 'broken-1',
  // eslint-disable-next-line require-yield
  async *stream() {
    await Promise.resolve();
    throw new Error('upstream went away');
  },
};

describe('a test run', () => {
  it('streams deltas, then the finished run, and charges one credit', async () => {
    const response = await ada.post('/runs', {
      promptId,
      inputs: { changelog: 'the v2 release' },
    });

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/text\/event-stream/);

    const stream = events(response);
    const deltas = stream.filter((event) => event.type === 'delta');
    const done = stream.at(-1);
    expect(deltas.length).toBeGreaterThan(3);
    if (done?.type !== 'done') throw new Error('expected the stream to end with done');

    expect(done.run.output).toBe(deltas.map((event) => event.text).join(''));
    expect(done.run).toMatchObject({
      status: 'ok',
      versionNumber: 1,
      inputs: { changelog: 'the v2 release' },
    });
    expect(done.credits.model).toMatchObject({ limit: 50, used: 1, remaining: 49 });
  });

  it('sends the rendered prompt: supplied values, then defaults', async () => {
    const response = await ada.post('/runs', { promptId, inputs: { changelog: 'the v2 release' } });
    const done = events(response).at(-1);
    if (done?.type !== 'done') throw new Error('expected done');
    // The fake model quotes the opening of what it received.
    expect(done.run.output).toContain('Summarize the v2 release for a general reader.');
  });

  it('ignores inputs that are not variables of the prompt', async () => {
    const response = await ada.post('/runs', {
      promptId,
      inputs: { changelog: 'x', injected: 'not a variable' },
    });
    const done = events(response).at(-1);
    if (done?.type !== 'done') throw new Error('expected done');
    expect(done.run.inputs).toEqual({ changelog: 'x' });
  });

  it('can target an older version', async () => {
    await ada.patch(`/prompts/${promptId}`, { body: 'A completely different prompt.' });
    const versions = (
      (await ada.get(`/prompts/${promptId}/versions`)).body as {
        versions: { id: string; number: number }[];
      }
    ).versions;
    const first = versions.find((version) => version.number === 1);

    const response = await ada.post('/runs', {
      promptId,
      versionId: first?.id,
      inputs: { changelog: 'the v2 release' },
    });
    const done = events(response).at(-1);
    if (done?.type !== 'done') throw new Error('expected done');
    expect(done.run.versionNumber).toBe(1);
    expect(done.run.output).toContain('Summarize the v2 release');
  });

  it('is kept in your history for that prompt, and in nobody else’s', async () => {
    await ada.post('/runs', { promptId, inputs: { changelog: 'private notes' } });

    const mine = ((await ada.get(`/prompts/${promptId}/runs`)).body as { runs: RunDto[] }).runs;
    expect(mine).toHaveLength(1);
    expect(mine[0]?.inputs).toEqual({ changelog: 'private notes' });

    const grace = await signedInBrowser(harness, 'grace@example.test');
    expect((await grace.get(`/prompts/${promptId}/runs`)).body).toEqual({ runs: [] });
  });
});

describe('credits for runs', () => {
  it('lets a guest run a public prompt five times, then refuses with 402', async () => {
    const guest = await harness.browser();
    for (let index = 0; index < 5; index += 1) {
      expect((await guest.post('/runs', { promptId })).status).toBe(200);
    }
    const sixth = await guest.post('/runs', { promptId });
    expect(sixth.status).toBe(402);
    expect(sixth.body).toMatchObject({ error: { code: 'insufficient_credits' } });
  });

  it('returns the credit and records the failure when the model fails', async () => {
    const browser = await openBrowser(harness.appWith({ llm: brokenModel }));
    await browser.post('/auth/login', {
      email: 'ada@example.test',
      password: 'correct horse battery',
    });

    const response = await browser.post('/runs', { promptId, inputs: { changelog: 'x' } });
    const last = events(response).at(-1);
    expect(last).toMatchObject({ type: 'error', code: 'error' });
    if (last?.type !== 'error') throw new Error('expected an error event');
    expect(last.credits.model.used).toBe(0);

    const runs = ((await browser.get(`/prompts/${promptId}/runs`)).body as { runs: RunDto[] }).runs;
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'error', output: null });
  });

  it('refuses everyone once the global daily budget is spent', async () => {
    // The default cap is 2000; fill the ledger to it directly.
    await harness.database.pool.query(
      `INSERT INTO credit_ledger (actor_type, actor_id, kind, amount)
       SELECT 'user', 'someone-else', 'run', -1 FROM generate_series(1, 2000)`,
    );
    const response = await ada.post('/runs', { promptId, inputs: { changelog: 'x' } });
    expect(response.status).toBe(503);
    expect((await credits(ada)).model.used).toBe(0);
  });
});

describe('who may run what', () => {
  it('refuses a private prompt to anyone but its owner, as a 404', async () => {
    const secret = await create(ada, { title: 'Internal' });
    const grace = await signedInBrowser(harness, 'grace@example.test');

    const refused = await grace.post('/runs', { promptId: secret });
    expect(refused.status).toBe(404);
    expect((await credits(grace)).model.used).toBe(0);

    expect((await ada.post('/runs', { promptId: secret })).status).toBe(200);
  });

  it('does not accept a version id from a different prompt', async () => {
    const secret = await create(ada, { title: 'Internal', body: 'The secret body.' });
    const secretVersion = (
      (await ada.get(`/prompts/${secret}/versions`)).body as { versions: { id: string }[] }
    ).versions[0];

    // A readable prompt id paired with an unreadable prompt's version id.
    const grace = await signedInBrowser(harness, 'grace@example.test');
    const response = await grace.post('/runs', { promptId, versionId: secretVersion?.id });
    expect(response.status).toBe(404);
  });
});

describe('tools', () => {
  it('tightens a prompt and keeps its placeholders', async () => {
    const body =
      'Please   summarize {{changelog}} really carefully for a {{audience:general}} reader.';
    const response = await ada.post('/tools/tighten', { body });

    expect(response.status).toBe(200);
    const result = response.body as TightenDto;
    expect(result.body).toBe(
      'summarize {{changelog}} carefully for a {{audience:general}} reader.',
    );
    expect(result.droppedVariables).toEqual([]);
    expect(result.credits.model.used).toBe(1);
  });

  it('reports placeholders a rewrite lost', async () => {
    const lossy: LlmProvider = {
      name: 'lossy',
      model: 'lossy-1',
      async *stream() {
        await Promise.resolve();
        yield { type: 'text', text: '```\nSummarize the changelog.\n```' };
      },
    };
    const browser = await openBrowser(harness.appWith({ llm: lossy }));
    const response = await browser.post('/tools/tighten', {
      body: 'Summarize {{changelog}} for {{audience}}.',
    });
    expect(response.body).toMatchObject({
      body: 'Summarize the changelog.',
      droppedVariables: ['changelog', 'audience'],
    });
  });

  it('returns structured suggestions', async () => {
    const response = await ada.post('/tools/suggest', { body: 'Summarize {{changelog}}.' });
    const result = response.body as SuggestDto;
    expect(result.suggestions.length).toBeGreaterThan(0);
    expect(result.suggestions[0]).toEqual({
      title: expect.any(String) as string,
      detail: expect.any(String) as string,
    });
  });

  it('returns the credit when the model answers with something unreadable', async () => {
    const rambling: LlmProvider = {
      name: 'rambling',
      model: 'rambling-1',
      async *stream() {
        await Promise.resolve();
        yield { type: 'text', text: 'Sure! Here are some thoughts, in no particular format.' };
      },
    };
    const browser = await openBrowser(harness.appWith({ llm: rambling }));
    const response = await browser.post('/tools/suggest', { body: 'Summarize {{changelog}}.' });
    expect(response.status).toBe(503);
    expect((await credits(browser)).model.used).toBe(0);
  });

  it('returns the credit when the model fails', async () => {
    const browser = await openBrowser(harness.appWith({ llm: brokenModel }));
    expect((await browser.post('/tools/tighten', { body: 'Summarize it.' })).status).toBe(503);
    expect((await credits(browser)).model.used).toBe(0);
  });

  it('shares the daily allowance with runs', async () => {
    const guest = await harness.browser();
    for (let index = 0; index < 3; index += 1) await guest.post('/runs', { promptId });
    await guest.post('/tools/tighten', { body: 'Summarize it.' });
    await guest.post('/tools/suggest', { body: 'Summarize it.' });

    expect((await guest.post('/tools/tighten', { body: 'Summarize it.' })).status).toBe(402);
    expect((await guest.post('/runs', { promptId })).status).toBe(402);
  });
});
