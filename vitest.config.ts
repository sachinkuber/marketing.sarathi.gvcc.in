import { defineConfig } from 'vitest/config'

export default defineConfig({
  // The dashboard's components are .tsx and use the automatic JSX runtime, as Next.js does (its tsconfig says
  // react-jsx; Vite 8 compiles with oxc, not esbuild).
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
