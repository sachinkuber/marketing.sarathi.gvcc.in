import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { requireDatabase, sleep } from '@mkt/test-support'
import type { TestDatabase } from '@mkt/db/testing'
import { JOB_CLASSES, type JobClass } from '../src/classes.ts'
import { openQueue, type Queue } from '../src/queue.ts'
import { createQueueTestDatabase } from '../src/testing.ts'

// Its own database and an unsupervised queue: the watchdog tests set job states by hand, which a
// supervising instance would expire or retry underneath them.
let db: TestDatabase
let queue: Queue
let app: pg.Pool

beforeAll(async () => {
  await requireDatabase()
  db = await createQueueTestDatabase()
  queue = await openQueue(db.urlFor('queue'), { supervise: false })
  app = new pg.Pool({ connectionString: db.urlFor('app') })
})
afterAll(async () => {
  await queue?.stop()
  await app?.end()
  await db?.drop()
})

async function send(jobClass: JobClass) {
  const id = randomUUID()
  const client = await app.connect()
  try {
    await client.query('begin')
    await queue.send(client, { jobId: id, jobClass, scheduleKey: randomUUID() })
    await client.query('commit')
  } finally {
    client.release()
  }
  return id
}

const limits = {
  maxWaitSeconds: Object.fromEntries(JOB_CLASSES.map((c) => [c, 60])) as Record<JobClass, number>,
}
const DAY = 24 * 3600 * 1000

describe('the watchdog', () => {
  it('reports a job that has waited too long with no worker running', async () => {
    const id = await send('bulk')
    expect((await queue.watchdog(new Date(), limits)).waiting).not.toContain(id)
    expect((await queue.watchdog(new Date(Date.now() + DAY), limits)).waiting).toContain(id)
  })

  it('does not report a job whose start is deliberately in the future', async () => {
    const id = await send('bulk')
    await db.admin.query(`update pgboss.job set start_after = now() + interval '2 days' where id = $1`, [id])
    expect((await queue.watchdog(new Date(Date.now() + DAY), limits)).waiting).not.toContain(id)
    expect((await queue.watchdog(new Date(Date.now() + 3 * DAY), limits)).waiting).toContain(id)
  })

  it('reports a job stuck in retry', async () => {
    const id = await send('bulk')
    await db.admin.query(`update pgboss.job set state = 'retry', start_after = now() where id = $1`, [id])
    expect((await queue.watchdog(new Date(Date.now() + DAY), limits)).waiting).toContain(id)
  })

  it('reports an active job that started long ago as running', async () => {
    const id = await send('production')
    await db.admin.query(
      `update pgboss.job set state = 'active', started_on = now() - interval '1 day' where id = $1`,
      [id],
    )
    const report = await queue.watchdog(new Date(), limits)
    expect(report.running).toContain(id)
    expect(report.waiting).not.toContain(id)
  })
})

describe('notification', () => {
  it('hands a new job to an idle worker far faster than the polling backstop', async () => {
    const claimed = new Map<string, number>()
    await queue.work('interactive', { processes: 1 }, async (job) => {
      claimed.set(job.id, Date.now())
    })
    // Let the worker settle into its idle poll.
    await sleep(3000)
    const latencies: number[] = []
    for (let i = 0; i < 5; i++) {
      const id = randomUUID()
      const client = await app.connect()
      let committedAt = 0
      try {
        await client.query('begin')
        await queue.send(client, { jobId: id, jobClass: 'interactive', scheduleKey: randomUUID() })
        await client.query('commit')
        committedAt = Date.now()
      } finally {
        client.release()
      }
      const end = Date.now() + 10_000
      while (!claimed.has(id) && Date.now() < end) await sleep(10)
      expect(claimed.has(id)).toBe(true)
      latencies.push(claimed.get(id)! - committedAt)
      await sleep(300 + i * 370) // different phases against the 2-second poll
    }
    console.log('claim latencies (ms):', latencies.join(', '))
    expect(Math.max(...latencies)).toBeLessThan(1000)
  })
})
