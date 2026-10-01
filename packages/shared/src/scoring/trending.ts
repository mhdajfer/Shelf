/**
 * Hacker News style gravity decay. Forks count double because forking a prompt
 * is a stronger signal than upvoting it: the person took it and used it.
 */
export const TRENDING = {
  forkWeight: 2,
  gravity: 1.5,
  /** Keeps brand new prompts from dividing by ~0 and dominating the page. */
  timeOffsetHours: 2,
} as const;

export interface TrendingInput {
  upvotes: number;
  forks: number;
  createdAt: Date;
}

const MS_PER_HOUR = 3_600_000;

export function trendingScore(input: TrendingInput, now: Date = new Date()): number {
  const weight = input.upvotes + TRENDING.forkWeight * input.forks;
  // Clock skew between the API and the database can put createdAt in the future.
  const ageHours = Math.max(0, (now.getTime() - input.createdAt.getTime()) / MS_PER_HOUR);
  return weight / (ageHours + TRENDING.timeOffsetHours) ** TRENDING.gravity;
}
