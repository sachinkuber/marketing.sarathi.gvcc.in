import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { requireDatabase, sleep } from '@mkt/test-support'
import type { TestDatabase } from '@mkt/db/testing'
import { openQueue, type Queue } from '../src/queue.ts'
import { createQueueTestDatabase } from '../src/testing.ts'

let db: TestDatabase
let queue: Queue
let app: pg.Pool

beforeAll(async () => {
  await requireDatabase()
  db = await createQueueTestDatabase()
  queue = await openQueue(db.urlFor('queue'), { supervise: true, superviseIntervalSeconds: 1 })
  app = new pg.Pool({ connectionString: db.urlFor('app') })
})
afterAll(async () => {
  await queue?.stop()
  await app?.end()
  await db?.drop()
})

async function send(id = randomUUID()) {
  const client = await app.connect()
  try {
    await client.query('begin')
    await queue.send(client, { jobId: id, jobClass: 'interactive', scheduleKey: randomUUID() })
    await client.query('commit')
  } finally {
    client.release()
  }
  return id
}

async function until(check: () => Promise<boolean>, ms: number) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await sleep(100)
  }
  throw new Error('condition not reached in time')
}

describe('the dead-letter watcher', () => {
  it('hands the watcher the ID of a job that kept failing, completes the copy, and lets the job be cancelled', async () => {
    const dead: string[] = []
    await queue.onDead('interactive', async (jobId) => {
      dead.push(jobId)
    })
    await queue.work('interactive', { processes: 1 }, async () => {
      throw new Error('boom')
    })
    const id = await send()
    await until(async () => dead.includes(id), 60_000)
    // Handling the copy completed it: the dead-letter queue holds nothing waiting.
    await until(async () => !(await queue.deadJobs('interactive')).includes(id), 10_000)
    expect(await queue.state('interactive', id)).toBe('failed')
    expect(await queue.failedJobIds('interactive')).toContain(id)
    expect(await queue.failedJobIds('bulk')).not.toContain(id)

    await queue.cancel('interactive', id)
    expect(await queue.state('interactive', id)).toBe('cancelled')
  }, 120_000)

  // Recorded finding (pg-boss 12.30): retry() of a failed job does not reset retry_count; it raises
  // retry_limit by one. A requeued job therefore gets exactly one more try before it is dead again.
  it('requeue gives a dead job one more try only: retry_count is kept, the limit is raised by one', async () => {
    const tries = new Map<string, number>()
    await queue.work('publishing', { processes: 1 }, async (job) => {
      tries.set(job.id, (tries.get(job.id) ?? 0) + 1)
      throw new Error('boom')
    })
    const client = await app.connect()
    const id = randomUUID()
    try {
      await client.query('begin')
      await queue.send(client, { jobId: id, jobClass: 'publishing', scheduleKey: randomUUID() })
      await client.query('commit')
    } finally {
      client.release()
    }
    const counts = async () =>
      (
        await db.admin.query<{ retry_count: number; retry_limit: number }>(
          'select retry_count, retry_limit from pgboss.job where id = $1',
          [id],
        )
      ).rows[0]!
    await until(async () => (await queue.state('publishing', id)) === 'failed', 120_000)
    const before = await counts()
    const triesBefore = tries.get(id) ?? 0
    expect(before.retry_count).toBe(before.retry_limit)

    await queue.requeue('publishing', id)
    await until(async () => (await queue.state('publishing', id)) !== 'retry', 60_000)
    await until(async () => (await queue.state('publishing', id)) === 'failed', 60_000)
    const after = await counts()
    expect(after.retry_limit).toBe(before.retry_limit + 1)
    expect(after.retry_count).toBe(before.retry_count + 1)
    expect(tries.get(id)).toBe(triesBefore + 1)
  }, 240_000)

  it('creates the dead-letter queues with retries sized for a core outage', async () => {
    const { rows } = await db.admin.query<{ retry_limit: number; retry_backoff: boolean }>(
      `select retry_limit, retry_backoff from pgboss.queue where name = 'dead-interactive'`,
    )
    expect(rows[0]).toEqual({ retry_limit: 10, retry_backoff: true })
  })

  it('lists the newest failed jobs first, so 600 old ones cannot hide a new failure', async () => {
    const ids = Array.from({ length: 600 }, () => randomUUID())
    await db.admin.query(
      `insert into pgboss.job (id, name, data, state, completed_on)
       select i, 'job-production', jsonb_build_object('jobId', i), 'failed', now() - interval '1 day'
         from unnest($1::uuid[]) as i`,
      [ids],
    )
    const fresh = randomUUID()
    await db.admin.query(
      `insert into pgboss.job (id, name, data, state, completed_on)
       values ($1::uuid, 'job-production', jsonb_build_object('jobId', $1::uuid), 'failed', now())`,
      [fresh],
    )
    const window = await queue.failedJobIds('production', 500)
    expect(window).toHaveLength(500)
    expect(window[0]).toBe(fresh)
  })
})
