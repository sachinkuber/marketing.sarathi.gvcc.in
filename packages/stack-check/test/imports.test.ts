import { describe, expect, it } from 'vitest'

const modules = [
  '@anthropic-ai/sdk',
  '@sentry/node',
  'better-auth',
  'express',
  'helmet',
  'kysely',
  'node-pg-migrate',
  'nodemailer',
  'pg',
  'pg-boss',
  'pino',
  'pino-http',
  'zod',
]

describe('pinned libraries load on the pinned Node', () => {
  it.each(modules)('%s', async (name) => {
    const loaded = await import(name)
    expect(Object.keys(loaded).length).toBeGreaterThan(0)
  })
})
