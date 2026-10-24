import { defineConfig, devices } from '@playwright/test'

// Browser checks (plan decision 2): Chromium only, one worker (the stack is one database and one clock), a
// desktop project and a phone project. `webServer` starts the whole stack (e2e/stack.ts) and waits for it.
const port = Number(process.env.E2E_PORT ?? 3410)

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 150_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'desktop',
      testIgnore: /phone\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
    {
      name: 'phone',
      testMatch: /phone\.spec\.ts/,
      use: { ...devices['Pixel 5'], viewport: { width: 390, height: 844 }, hasTouch: true },
    },
  ],
  webServer: {
    command: 'node e2e/stack.ts',
    url: `http://127.0.0.1:${port + 1}/health`,
    timeout: 420_000,
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
    gracefulShutdown: { signal: 'SIGTERM', timeout: 30_000 },
  },
})
