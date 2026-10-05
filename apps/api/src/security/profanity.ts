import { englishDataset, englishRecommendedTransformers, RegExpMatcher } from 'obscenity';

import { AppError, type FieldError } from '../http/errors.js';

const matcher = new RegExpMatcher({
  ...englishDataset.build(),
  ...englishRecommendedTransformers,
});

/**
 * Applied to the parts of a public prompt that show up in listings: title,
 * description, and tags. The body is left alone, since a prompt can
 * legitimately quote or ask about language that a listing should not carry.
 */
export function assertPublishable(fields: {
  title: string;
  description: string | null;
  tags: string[];
}): void {
  const details: FieldError[] = [];
  const message = 'Public prompts cannot use that language here.';

  if (matcher.hasMatch(fields.title)) details.push({ field: 'title', message });
  if (fields.description !== null && matcher.hasMatch(fields.description)) {
    details.push({ field: 'description', message });
  }
  if (fields.tags.some((tag) => matcher.hasMatch(tag))) details.push({ field: 'tags', message });

  if (details.length > 0) {
    throw new AppError(
      'bad_request',
      'Some fields are not suitable for the public shelf. Reword them, or keep the prompt private.',
      { details },
    );
  }
}
