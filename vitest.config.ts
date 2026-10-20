import { defineConfig } from 'vitest/config'

export default defineConfig({
  // The dashboard's components are .tsx and use the automatic JSX runtime (its own tsconfig says "preserve"
  // for Next, which compiles them in the build).
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    include: [
      'apps/*/test/**/*.test.ts',
      'apps/dashboard/test/**/*.test.tsx',
      'packages/*/test/**/*.test.ts',
      'tools/**/*.test.mjs',
    ],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
})
