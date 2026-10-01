import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

import { baseConfig } from './base.mjs';

/** Flat config for the Next.js app: base rules plus React Hooks correctness. */
export const reactConfig = tseslint.config(...baseConfig, reactHooks.configs.flat.recommended, {
  languageOptions: {
    globals: { ...globals.browser, ...globals.node },
  },
  rules: {
    // Prompt bodies and model output are untrusted; nothing may bypass React's
    // escaping without going through an explicit sanitizer.
    'no-restricted-syntax': [
      'error',
      {
        selector: 'JSXAttribute[name.name="dangerouslySetInnerHTML"]',
        message:
          'Prompt bodies and model output are untrusted. Render as text, or sanitize with rehype-sanitize.',
      },
    ],
  },
});

export default reactConfig;
