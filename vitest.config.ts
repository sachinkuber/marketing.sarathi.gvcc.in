import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['apps/*/test/**/*.test.ts', 'packages/*/test/**/*.test.ts', 'tools/**/*.test.mjs'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
})
