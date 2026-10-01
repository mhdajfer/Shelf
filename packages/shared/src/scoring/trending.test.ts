import { describe, expect, it } from 'vitest';

import { trendingScore } from './trending.js';

const now = new Date('2026-03-01T12:00:00Z');
const hoursAgo = (h: number): Date => new Date(now.getTime() - h * 3_600_000);

describe('trendingScore', () => {
  it('is zero without engagement', () => {
    expect(trendingScore({ upvotes: 0, forks: 0, createdAt: hoursAgo(5) }, now)).toBe(0);
  });

  it('weights a fork as two upvotes', () => {
    const byForks = trendingScore({ upvotes: 0, forks: 5, createdAt: hoursAgo(0) }, now);
    const byVotes = trendingScore({ upvotes: 10, forks: 0, createdAt: hoursAgo(0) }, now);
    expect(byForks).toBeCloseTo(byVotes, 12);
  });

  it('matches the documented formula', () => {
    // 10 / (0 + 2)^1.5
    expect(trendingScore({ upvotes: 10, forks: 0, createdAt: hoursAgo(0) }, now)).toBeCloseTo(
      3.535533,
      5,
    );
    // (4 + 2*3) / (22 + 2)^1.5
    expect(trendingScore({ upvotes: 4, forks: 3, createdAt: hoursAgo(22) }, now)).toBeCloseTo(
      0.085051,
      5,
    );
  });

  it('decays monotonically with age', () => {
    const ages = [0, 1, 6, 24, 72, 720];
    const scores = ages.map((h) =>
      trendingScore({ upvotes: 20, forks: 2, createdAt: hoursAgo(h) }, now),
    );
    for (let i = 1; i < scores.length; i += 1) {
      expect(scores[i]).toBeLessThan(scores[i - 1] as number);
    }
  });

  it('ranks the newer of two equally voted prompts higher', () => {
    const fresh = trendingScore({ upvotes: 8, forks: 0, createdAt: hoursAgo(2) }, now);
    const stale = trendingScore({ upvotes: 8, forks: 0, createdAt: hoursAgo(48) }, now);
    expect(fresh).toBeGreaterThan(stale);
  });

  it('clamps a future creation date instead of returning a spike', () => {
    const skewed = trendingScore({ upvotes: 5, forks: 0, createdAt: hoursAgo(-6) }, now);
    expect(skewed).toBeCloseTo(trendingScore({ upvotes: 5, forks: 0, createdAt: now }, now), 12);
  });

  it('stays finite for large inputs', () => {
    const score = trendingScore(
      { upvotes: 1_000_000, forks: 1_000_000, createdAt: hoursAgo(0) },
      now,
    );
    expect(Number.isFinite(score)).toBe(true);
  });
});
