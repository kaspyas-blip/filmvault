// Only what catches real mistakes: names that do not exist, things never used.
export default [
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        process: 'readonly', console: 'readonly', Buffer: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly',
        clearInterval: 'readonly', fetch: 'readonly', URL: 'readonly', AbortController: 'readonly', AbortSignal: 'readonly', performance: 'readonly',
        Response: 'readonly', globalThis: 'readonly', structuredClone: 'readonly', Intl: 'readonly',
      },
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true }],
      'no-dupe-keys': 'error',
      'no-unreachable': 'error',
      'no-const-assign': 'error',
      'no-redeclare': 'error',
      'no-shadow-restricted-names': 'error',
      'use-isnan': 'error',
      'valid-typeof': 'error',
    },
  },
];
