import { withBase } from '@shelf/config/eslint/base';

export default withBase({
  // These are CLI entry points; stdout is their interface, not stray debugging.
  files: ['src/scripts/**/*.ts'],
  rules: { 'no-console': 'off' },
});
