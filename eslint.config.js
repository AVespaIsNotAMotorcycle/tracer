import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';

export default [
  { ignores: ['**/dist/', '**/node_modules/'] },
  js.configs.recommended,
  {
    files: ['**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['client/**/*.{js,jsx}'],
    languageOptions: { globals: globals.browser },
    ...reactHooks.configs.flat['recommended-latest'],
  },
  {
    files: ['client/src/**/*.jsx'],
    ...reactRefresh.configs.vite,
  },
  {
    files: ['server/**/*.js', '*.config.js', '**/vitest.config.js', '**/vite.config.js'],
    languageOptions: { globals: globals.node },
  },
  {
    // Agent tooling (run skill): Node scripts whose page.evaluate callbacks run in the browser.
    files: ['.claude/**/*.mjs'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  prettier,
];
