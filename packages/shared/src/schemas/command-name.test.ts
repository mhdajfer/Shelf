import { describe, expect, it } from 'vitest';

import { LIMITS } from '../constants.js';
import { commandNameCandidate, commandNameSchema, slugifyCommandName } from './prompt.js';

describe('slugifyCommandName', () => {
  it.each([
    ['Commit message (conventional)', 'commit-message-conventional'],
    ['  Review   a PR  ', 'review-a-pr'],
    ['Résumé tailor', 'resume-tailor'],
    ['SQL → English', 'sql-english'],
    ['v2.1 release notes', 'v2-1-release-notes'],
    ['--leading and trailing--', 'leading-and-trailing'],
  ])('turns %j into %j', (title, expected) => {
    expect(slugifyCommandName(title)).toBe(expected);
  });

  it('falls back to a generic name when nothing usable is left', () => {
    expect(slugifyCommandName('🚀✨')).toBe('prompt');
    expect(slugifyCommandName('日本語のプロンプト')).toBe('prompt');
  });

  it('never exceeds the limit or ends on a hyphen after truncation', () => {
    const slug = slugifyCommandName(`${'a'.repeat(47)} b`);
    expect(slug.length).toBeLessThanOrEqual(LIMITS.commandNameMax);
    expect(slug.endsWith('-')).toBe(false);
  });

  it('always produces a name the schema accepts', () => {
    for (const title of ['x', 'A  B', '!!!', 'Ünïcödé', `${'word '.repeat(30)}`]) {
      expect(commandNameSchema.safeParse(slugifyCommandName(title)).success).toBe(true);
    }
  });
});

describe('commandNameCandidate', () => {
  it('uses the base first, then numbered suffixes', () => {
    expect(commandNameCandidate('review', 1)).toBe('review');
    expect(commandNameCandidate('review', 2)).toBe('review-2');
    expect(commandNameCandidate('review', 12)).toBe('review-12');
  });

  it('shortens a long base so the suffix fits', () => {
    const base = 'a'.repeat(LIMITS.commandNameMax);
    const candidate = commandNameCandidate(base, 10);
    expect(candidate).toHaveLength(LIMITS.commandNameMax);
    expect(candidate.endsWith('-10')).toBe(true);
  });

  it('does not leave a double hyphen when the cut lands on one', () => {
    const base = `${'a'.repeat(45)}-bc`;
    expect(commandNameCandidate(base, 2)).toBe(`${'a'.repeat(45)}-2`);
  });
});

describe('commandNameSchema', () => {
  it('lowercases and trims', () => {
    expect(commandNameSchema.parse('  Commit-Message ')).toBe('commit-message');
  });

  it.each(['', '-lead', 'trail-', 'two--hyphens', 'under_score', 'sp ace', 'a'.repeat(49)])(
    'rejects %j',
    (value) => {
      expect(commandNameSchema.safeParse(value).success).toBe(false);
    },
  );
});
