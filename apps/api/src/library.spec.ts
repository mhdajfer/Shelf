import { trendingScore, type PromptDetailDto, type PromptListDto } from '@shelf/shared';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  createApiHarness,
  signedInBrowser,
  url,
  type ApiHarness,
  type Browser,
} from './testing/harness.js';

let harness: ApiHarness;
let ada: Browser;

const DRAFT = {
  title: 'Summarize a changelog',
  category: 'writing',
  body: 'Summarize {{changelog}}.',
};

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
});

async function create(overrides: object): Promise<string> {
  const response = await ada.post('/prompts', { ...DRAFT, ...overrides });
  return (response.body as { prompt: PromptDetailDto }).prompt.id;
}

describe('search', () => {
  beforeEach(async () => {
    await create({
      visibility: 'public',
      title: 'SQL query reviewer',
      body: 'Review this query for performance problems: {{query}}',
      tags: ['sql', 'review'],
    });
    await create({
      visibility: 'public',
      title: 'Explain a regular expression',
      description: 'Walks through a regex token by token.',
      body: 'Explain {{pattern}}. Mention any SQL injection risk if it guards a query.',
      tags: ['regex'],
    });
  });

  const search = async (q: string): Promise<string[]> => {
    const visitor = await harness.browser();
    const list = (await visitor.get(`/prompts?q=${encodeURIComponent(q)}`)).body as PromptListDto;
    return list.items.map((item) => item.title);
  };

  it('ranks a title match above a body match', async () => {
    expect(await search('sql')).toEqual(['SQL query reviewer', 'Explain a regular expression']);
  });

  it('matches tags and descriptions, and stems words', async () => {
    expect(await search('regex')).toEqual(['Explain a regular expression']);
    expect(await search('walking')).toEqual(['Explain a regular expression']);
  });

  it('supports quoted phrases and exclusions without choking on punctuation', async () => {
    expect(await search('"performance problems"')).toEqual(['SQL query reviewer']);
    expect(await search('sql -regular')).toEqual(['SQL query reviewer']);
    expect(await search('what?! (sql) & more:')).toEqual(expect.any(Array));
  });

  it('combines with filters and reports the matching total', async () => {
    const visitor = await harness.browser();
    const list = (await visitor.get('/prompts?q=sql&tag=review')).body as PromptListDto;
    expect(list.total).toBe(1);
    expect(list.items[0]?.title).toBe('SQL query reviewer');
  });
});

describe('trending', () => {
  it('rejects the cron endpoint without the secret', async () => {
    const response = await request(harness.app).post(url('/cron/trending'));
    expect(response.status).toBe(401);
  });

  it('rescoring in SQL agrees with the shared formula, and orders the listing', async () => {
    const older = await create({ visibility: 'public', title: 'Older, more votes' });
    const newer = await create({ visibility: 'public', title: 'Newer, fewer votes' });
    await create({ title: 'Private, never scored' });

    await harness.database.pool.query(
      `UPDATE prompts SET upvote_count = 40, fork_count = 5, created_at = now() - interval '72 hours' WHERE id = $1`,
      [older],
    );
    await harness.database.pool.query(
      `UPDATE prompts SET upvote_count = 12, fork_count = 0, created_at = now() - interval '3 hours' WHERE id = $1`,
      [newer],
    );

    const response = await request(harness.app)
      .post(url('/cron/trending'))
      .set('Authorization', 'Bearer dev-only-cron-secret-change-me');
    expect(response.body).toEqual({ ok: true, rescored: 2 });

    const { rows } = await harness.database.pool.query<{
      id: string;
      trending_score: number;
      upvote_count: number;
      fork_count: number;
      created_at: Date;
    }>(`SELECT id, trending_score, upvote_count, fork_count, created_at FROM prompts`);

    for (const row of rows.filter(
      (candidate) => candidate.id !== older && candidate.id !== newer,
    )) {
      expect(row.trending_score).toBe(0);
    }
    for (const row of rows.filter((candidate) => [older, newer].includes(candidate.id))) {
      const expected = trendingScore({
        upvotes: row.upvote_count,
        forks: row.fork_count,
        createdAt: row.created_at,
      });
      // The two clocks are read a few milliseconds apart.
      expect(row.trending_score).toBeCloseTo(expected, 2);
    }

    const visitor = await harness.browser();
    const list = (await visitor.get('/prompts?sort=trending')).body as PromptListDto;
    expect(list.items.map((item) => item.title)).toEqual([
      'Newer, fewer votes',
      'Older, more votes',
    ]);
  });
});

describe('tags, profiles, and the sitemap', () => {
  beforeEach(async () => {
    await create({ visibility: 'public', title: 'Public one', tags: ['sql', 'review'] });
    await create({ visibility: 'public', title: 'Public two', tags: ['sql'] });
    await create({ title: 'Private', tags: ['secret-project'] });
  });

  it('counts tags over public prompts only', async () => {
    const visitor = await harness.browser();
    const { tags } = (await visitor.get('/tags')).body as {
      tags: { name: string; count: number }[];
    };
    expect(tags).toEqual([
      { name: 'sql', count: 2 },
      { name: 'review', count: 1 },
    ]);
  });

  it('shows a profile with the public count and no email address', async () => {
    const visitor = await harness.browser();
    const response = await visitor.get('/users/ada');
    expect(response.body).toMatchObject({ profile: { handle: 'ada', publicPromptCount: 2 } });
    expect(JSON.stringify(response.body)).not.toContain('example.test');

    expect((await visitor.get('/users/nobody')).status).toBe(404);
  });

  it("lists only an author's public prompts on their profile", async () => {
    const visitor = await harness.browser();
    const list = (await visitor.get('/prompts?author=ada&sort=new')).body as PromptListDto;
    expect(list.items.map((item) => item.title)).toEqual(['Public two', 'Public one']);
    expect(list.total).toBe(2);
  });

  it('puts only public, active prompts in the sitemap', async () => {
    const hiddenId = await create({ visibility: 'public', title: 'Hidden by moderation' });
    await harness.database.pool.query(`UPDATE prompts SET status = 'hidden' WHERE id = $1`, [
      hiddenId,
    ]);

    const visitor = await harness.browser();
    const { entries } = (await visitor.get('/sitemap')).body as { entries: { id: string }[] };
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.id)).not.toContain(hiddenId);
  });
});
