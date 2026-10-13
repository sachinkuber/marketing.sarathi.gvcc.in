import { defineConfig, globalIgnores } from 'eslint/config'
import js from '@eslint/js'
import prettier from 'eslint-config-prettier'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default defineConfig(
  globalIgnores(['**/node_modules/**', '**/dist/**', '**/coverage/**', 'docs/**']),
  js.configs.recommended,
  tseslint.configs.recommended,
  { languageOptions: { globals: { ...globals.node } } },
  {
    files: ['tools/build-docs/**/*.js'],
    languageOptions: { sourceType: 'commonjs' },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    files: ['apps/**/*.ts', 'packages/**/*.ts'],
    ignores: [
      'packages/db/**',
      'packages/queue/**',
      'packages/queue-contract/**',
      'packages/test-support/**',
      'packages/stack-check/**',
      '**/test/**',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: ['pg', 'kysely', 'pg-boss'].map((name) => ({
            name,
            message: 'Business data is reached only through @mkt/db (withBrand).',
          })),
        },
      ],
    },
  },
  {
    // The worker holds no business data and no database access: it reaches the platform only through the
    // core's HTTP routes and the queue port. The later rule replaces the one above, so it repeats its paths.
    files: ['apps/worker/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: ['pg', 'kysely', 'pg-boss', '@mkt/db', '@mkt/core'].map((name) => ({
            name,
            message: 'The worker reaches the platform only through the core client and @mkt/queue.',
          })),
          patterns: [
            {
              group: ['@mkt/db/*', '@mkt/core/*', '**/apps/core/**', '../../core/**'],
              message: 'The worker reaches the platform only through the core client and @mkt/queue.',
            },
          ],
        },
      ],
    },
  },
  prettier,
)
