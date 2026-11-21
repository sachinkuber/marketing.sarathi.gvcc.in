import { createQueueTestDatabase } from '@mkt/queue/testing'
import { requireDatabase } from '@mkt/test-support'
import { Agent, createServer, get } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { UnconfiguredMailer } from '../src/adapters.ts'
import { createLogger } from '../src/logger.ts'
import { keepIdleConnections, startServer } from '../src/server.ts'
import { MemoryAudit } from '../src/testing.ts'

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

// The result-handler map startServer builds, captured as it is passed to the summary registration, and the
// settled-hook map passed to the research registration.
const registered = vi.hoisted(() => [] as Map<string, unknown>[])
const settled = vi.hoisted(() => [] as Map<string, unknown>[])
vi.mock('../src/agents/register.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/agents/register.ts')>()
  return {
    ...original,
    registerSummaryHandlers: (...args: Parameters<typeof original.registerSummaryHandlers>) => {
      registered.push(args[0])
      return original.registerSummaryHandlers(...args)
    },
    registerResearchHandlers: (...args: Parameters<typeof original.registerResearchHandlers>) => {
      settled.push(args[1])
      return original.registerResearchHandlers(...args)
    },
  }
})

describe('adapters', () => {
  it('refuses to send mail until delivery is configured', async () => {
    await expect(
      new UnconfiguredMailer().send({ to: 'a@example.test', subject: 's', text: 't' }),
    ).rejects.toThrow(/not configured/)
  })
})

describe('startServer', () => {
  it('starts on a free port, reports ready against the database, and stops cleanly', async () => {
    await requireDatabase()
    const db = await createQueueTestDatabase()
    const logger = createLogger('silent')
    const server = await startServer(
      {
        nodeEnv: 'test',
        port: 0,
        databaseUrl: db.urlFor('app'),
        auditDatabaseUrl: db.urlFor('audit_writer'),
        ownerViewDatabaseUrl: db.urlFor('owner_view'),
        queueDatabaseUrl: db.urlFor('queue'),
        authSecret: 'z'.repeat(48),
        workerSecret: 'w'.repeat(48),
        attemptTokenSecret: 'a'.repeat(48),
        triggerSecret: 't'.repeat(48),
        queueBacklogLimit: 2000,
        publicOrigin: 'https://app.example.test',
        n8nHeartbeatExpected: false,
        trustProxy: 0,
        logLevel: 'silent',
      },
      { logger, mailer: new UnconfiguredMailer(), audit: new MemoryAudit() },
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
  }, 30_000)

  it('registers the summary, check, research, questionnaire and facts and rules result handlers, and the research groups settled hook', async () => {
    await requireDatabase()
    const db = await createQueueTestDatabase()
    registered.length = 0
    settled.length = 0
    const server = await startServer(
      {
        nodeEnv: 'test',
        port: 0,
        databaseUrl: db.urlFor('app'),
        auditDatabaseUrl: db.urlFor('audit_writer'),
        ownerViewDatabaseUrl: db.urlFor('owner_view'),
        queueDatabaseUrl: db.urlFor('queue'),
        authSecret: 'z'.repeat(48),
        workerSecret: 'w'.repeat(48),
        attemptTokenSecret: 'a'.repeat(48),
        triggerSecret: 't'.repeat(48),
        queueBacklogLimit: 2000,
        publicOrigin: 'https://app.example.test',
        n8nHeartbeatExpected: false,
        trustProxy: 0,
        logLevel: 'silent',
      },
      { logger: createLogger('silent'), mailer: new UnconfiguredMailer(), audit: new MemoryAudit() },
    )
    try {
      expect(registered).toHaveLength(1)
      expect([...registered[0]!.keys()].sort()).toEqual([
        'facts_rules.v1',
        'placeholder_check.v1',
        'questionnaire.v1',
        'research.v1',
        'research_group.v1',
        'summary.v1',
      ])
      expect(settled).toHaveLength(1)
      expect([...settled[0]!.keys()]).toEqual(['research_group.v1'])
    } finally {
      await server.stop()
      await db.drop()
    }
  })

  it('logs an error on an idle pool connection instead of crashing the process', async () => {
    await requireDatabase()
    const db = await createQueueTestDatabase()
    const lines: string[] = []
    const logger = createLogger('info', { write: (line: string) => void lines.push(line) })
    created.length = 0
    const server = await startServer(
      {
        nodeEnv: 'test',
        port: 0,
        databaseUrl: db.urlFor('app'),
        auditDatabaseUrl: db.urlFor('audit_writer'),
        ownerViewDatabaseUrl: db.urlFor('owner_view'),
        queueDatabaseUrl: db.urlFor('queue'),
        authSecret: 'z'.repeat(48),
        workerSecret: 'w'.repeat(48),
        attemptTokenSecret: 'a'.repeat(48),
        triggerSecret: 't'.repeat(48),
        queueBacklogLimit: 2000,
        publicOrigin: 'https://app.example.test',
        n8nHeartbeatExpected: false,
        trustProxy: 0,
        logLevel: 'info',
      },
      { logger, mailer: new UnconfiguredMailer(), audit: new MemoryAudit() },
    )
    try {
      expect(created).toHaveLength(4)
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

  const configFor = (databaseUrl: string, queueUrl: string, port: number) => ({
    nodeEnv: 'test' as const,
    port,
    databaseUrl,
    auditDatabaseUrl: databaseUrl,
    ownerViewDatabaseUrl: databaseUrl,
    queueDatabaseUrl: queueUrl,
    authSecret: 'z'.repeat(48),
    workerSecret: 'w'.repeat(48),
    attemptTokenSecret: 'a'.repeat(48),
    triggerSecret: 't'.repeat(48),
    queueBacklogLimit: 2000,
    publicOrigin: 'https://app.example.test',
    n8nHeartbeatExpected: false,
    trustProxy: 0,
    logLevel: 'silent' as const,
  })

  it('rejects when the port is taken, and closes every pool', async () => {
    await requireDatabase()
    const db = await createQueueTestDatabase()
    const logger = createLogger('silent')
    const deps = { logger, mailer: new UnconfiguredMailer(), audit: new MemoryAudit() }
    const first = await startServer(configFor(db.urlFor('app'), db.urlFor('queue'), 0), deps)
    try {
      created.length = 0
      const port = Number(new URL(first.url).port)
      const second = startServer(configFor(db.urlFor('app'), db.urlFor('queue'), port), deps)
      const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('never settled')), 3000))
      await expect(Promise.race([second, timeout])).rejects.toMatchObject({ code: 'EADDRINUSE' })
      expect(created).toHaveLength(4)
      for (const pool of created) expect((pool as unknown as { ended: boolean }).ended).toBe(true)
    } finally {
      await first.stop()
      await db.drop()
    }
  })

  it('holds an idle connection longer than the proxy in front does (R42)', async () => {
    // Caddy keeps an idle upstream connection for up to 2 minutes; Node's default closes it after 5 s, so a request
    // sent on it as it closes would fail with a 502. Both stay under Node's 300 s request timeout.
    const plain = createServer()
    keepIdleConnections(plain)
    expect(plain.keepAliveTimeout).toBe(125_000)
    expect(plain.headersTimeout).toBe(126_000)
    expect(plain.headersTimeout).toBeLessThan(plain.requestTimeout)
    expect(plain.requestTimeout).toBe(300_000)

    // The started server uses them: its reply on a kept connection says how long it stays open.
    await requireDatabase()
    const db = await createQueueTestDatabase()
    const server = await startServer(configFor(db.urlFor('app'), db.urlFor('queue'), 0), {
      logger: createLogger('silent'),
      mailer: new UnconfiguredMailer(),
      audit: new MemoryAudit(),
    })
    const agent = new Agent({ keepAlive: true })
    try {
      const keepAlive = await new Promise<unknown>((resolve, reject) => {
        get(`${server.url}/health/live`, { agent }, (res) => {
          res.resume()
          resolve(res.headers['keep-alive'])
        }).on('error', reject)
      })
      expect(keepAlive).toBe('timeout=125')
    } finally {
      agent.destroy()
      await server.stop()
      await db.drop()
    }
  })

  it('can be stopped twice', async () => {
    await requireDatabase()
    const db = await createQueueTestDatabase()
    const logger = createLogger('silent')
    const server = await startServer(configFor(db.urlFor('app'), db.urlFor('queue'), 0), {
      logger,
      mailer: new UnconfiguredMailer(),
      audit: new MemoryAudit(),
    })
    try {
      await Promise.all([server.stop(), server.stop()])
      await expect(server.stop()).resolves.toBeUndefined()
    } finally {
      await db.drop()
    }
  })
})
