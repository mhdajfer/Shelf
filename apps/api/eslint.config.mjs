import { withBase } from '@shelf/config/eslint/base';

export default withBase({
  files: ['src/**/*.ts'],
  ignores: ['src/**/*.spec.ts', 'src/**/*.test.ts', 'src/testing/**'],
  rules: {
    // The visibility filter lives in @shelf/db's repositories. Reaching past
    // them to the tables is how private prompts leak, so the import is blocked
    // rather than left to review.
    'no-restricted-imports': [
      'error',
      {
        paths: [
          {
            name: '@shelf/db/schema',
            message:
              'Query prompts through promptRepo / collectionRepo; they apply the visibility filter.',
          },
          {
            name: '@shelf/db/testing',
            message: 'Test-only module. Import it from a .spec.ts file.',
          },
        ],
      },
    ],
  },
});
