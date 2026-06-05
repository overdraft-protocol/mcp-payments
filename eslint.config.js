// Boundary enforcement for @overdraft/mcp-payments.
//
// This package must never import from the marketplace application (src/).
// The tsconfig already enforces this structurally (no @/ alias), but ESLint
// provides a second line of defence and a clear error message. The config is
// deliberately minimal — it exists for the boundary rule, not general linting.

import tseslint from 'typescript-eslint';

export default tseslint.config({
  files: ['src/**/*.ts'],
  languageOptions: {
    parser: tseslint.parser,
  },
  // Register the plugin so `@typescript-eslint/*` disable directives in the
  // source resolve, even though we don't enable its rule set here.
  plugins: {
    '@typescript-eslint': tseslint.plugin,
  },
  rules: {
    // Keep `any` honest — the two intentional uses carry explicit disables.
    '@typescript-eslint/no-explicit-any': 'error',
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          {
            group: ['@/*', '**/src/**', '../../src/**', '../../../src/**'],
            message:
              'packages/mcp-payments must not import from the marketplace (src/). ' +
              'Inject all app-specific dependencies through interfaces instead.',
          },
        ],
      },
    ],
  },
});
