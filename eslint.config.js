// Boundary enforcement for @overdraft/mcp-payments.
//
// This package must never import from the marketplace application (src/).
// The tsconfig already enforces this structurally (no @/ alias), but ESLint
// provides a second line of defence and a clear error message.

export default [
  {
    files: ['src/**/*.ts'],
    rules: {
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
  },
];
