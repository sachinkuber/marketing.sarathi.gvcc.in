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
  prettier,
)
