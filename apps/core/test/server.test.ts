import { createTestDatabase } from '@mkt/db/testing'
import { requireDatabase } from '@mkt/test-support'
import { describe, expect, it, vi } from 'vitest'
import { LogAudit, UnconfiguredMailer } from '../src/adapters.ts'
import { createLogger } from '../src/logger.ts'
import { startServer } from '../src/server.ts'

// Records the pools startServer builds so the test can emit an error on each one.
const created = vi.hoisted(() => [] as import('node:events').EventEmitter[])
vi.mock('@mkt/db', async (importOriginal) => {
  const original = await importOriginal<typeof import('@mkt/db')>()
  return {
    ...original,
    createPool: (...args: Parameters<typeof original.createPool>) => {
      const pool = original.createPool(...args)
      created.push(pool)
      return pool
    },
  }
})

describe('adapters', () => {
  it('refuses to send mail until delivery is configured', async () => {
    await expect(
      new UnconfiguredMailer().send({ to: 'a@example.test', subject: 's', text: 't' }),
    ).rejects.toThrow(/not configured/)
  })

  it('writes audit entries to the log', async () => {
    const lines: string[] = []
    const logger = createLogger('info', { write: (line: string) => void lines.push(line) })
    await new LogAudit(logger).record({ action: 'auth.sign_in', actor: null, outcome: 'success' })
    expect(lines.join('')).toContain('auth.sign_in')
  })
})

describe('startServer', () => {
  it('starts on a free port, reports ready against the database, and stops cleanly', async () => {
    await requireDatabase()
    const db = await createTestDatabase()
    const logger = createLogger('silent')
    const server = await startServer(
      {
        nodeEnv: 'test',
        port: 0,
        databaseUrl: db.urlFor('app'),
        authSecret: 'z'.repeat(48),
        publicOrigin: 'https://app.example.test',
        logLevel: 'silent',
      },
      { logger, mailer: new UnconfiguredMailer(), audit: new LogAudit(logger) },
    )
    try {
      expect((await fetch(`${server.url}/health/live`)).status).toBe(200)
      expect((await fetch(`${server.url}/health/ready`)).status).toBe(200)
      expect((await fetch(`${server.url}/api/v1/session`)).status).toBe(401)
    } finally {
      await server.stop()
      await db.drop()
    }
    await expect(fetch(`${server.url}/health/live`)).rejects.toThrow()
  })

  it('logs an error on an idle pool connection instead of crashing the process', async () => {
    await requireDatabase()
    const db = await createTestDatabase()
    const lines: string[] = []
    const logger = createLogger('info', { write: (line: string) => void lines.push(line) })
    created.length = 0
    const server = await startServer(
      {
        nodeEnv: 'test',
        port: 0,
        databaseUrl: db.urlFor('app'),
        authSecret: 'z'.repeat(48),
        publicOrigin: 'https://app.example.test',
        logLevel: 'info',
      },
      { logger, mailer: new UnconfiguredMailer(), audit: new LogAudit(logger) },
    )
    try {
      expect(created).toHaveLength(2)
      for (const pool of created) {
        // With no listener, emit('error') would throw and take the process down.
        expect(() => pool.emit('error', new Error('connection terminated unexpectedly'))).not.toThrow()
      }
      expect(lines.join('')).toContain('connection terminated unexpectedly')
      expect((await fetch(`${server.url}/health/live`)).status).toBe(200)
    } finally {
      await server.stop()
      await db.drop()
    }
  })

  const configFor = (databaseUrl: string, port: number) => ({
    nodeEnv: 'test' as const,
    port,
    databaseUrl,
    authSecret: 'z'.repeat(48),
    publicOrigin: 'https://app.example.test',
    logLevel: 'silent' as const,
  })

  it('rejects when the port is taken, and closes both pools', async () => {
    await requireDatabase()
    const db = await createTestDatabase()
    const logger = createLogger('silent')
    const deps = { logger, mailer: new UnconfiguredMailer(), audit: new LogAudit(logger) }
    const first = await startServer(configFor(db.urlFor('app'), 0), deps)
    try {
      created.length = 0
      const port = Number(new URL(first.url).port)
      const second = startServer(configFor(db.urlFor('app'), port), deps)
      const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('never settled')), 3000))
      await expect(Promise.race([second, timeout])).rejects.toMatchObject({ code: 'EADDRINUSE' })
      expect(created).toHaveLength(2)
      for (const pool of created) expect((pool as unknown as { ended: boolean }).ended).toBe(true)
    } finally {
      await first.stop()
      await db.drop()
    }
  })

  it('can be stopped twice', async () => {
    await requireDatabase()
    const db = await createTestDatabase()
    const logger = createLogger('silent')
    const server = await startServer(configFor(db.urlFor('app'), 0), {
      logger,
      mailer: new UnconfiguredMailer(),
      audit: new LogAudit(logger),
    })
    try {
      await Promise.all([server.stop(), server.stop()])
      await expect(server.stop()).resolves.toBeUndefined()
    } finally {
      await db.drop()
    }
  })
})
