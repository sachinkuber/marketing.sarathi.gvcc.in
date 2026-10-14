import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { requireDatabase, sleep } from '@mkt/test-support'
import type { TestDatabase } from '@mkt/db/testing'
import { defaultOnError, openQueue, type Queue } from '../src/queue.ts'
import { createQueueTestDatabase } from '../src/testing.ts'

let db: TestDatabase
let queue: Queue
let app: pg.Pool

beforeAll(async () => {
  await requireDatabase()
  db = await createQueueTestDatabase()
  queue = await openQueue(db.urlFor('queue'), { supervise: true })
  app = new pg.Pool({ connectionString: db.urlFor('app') })
})
afterAll(async () => {
  await queue?.stop()
  await app?.end()
  await db?.drop()
})

async function send(
  jobClass: 'interactive' | 'publishing' | 'production' | 'bulk',
  key = randomUUID(),
  id = randomUUID(),
) {
  const client = await app.connect()
  try {
    await client.query('begin')
    await queue.send(client, { jobId: id, jobClass, scheduleKey: key })
    await client.query('commit')
  } finally {
    client.release()
  }
  return id
}

async function until(check: () => Promise<boolean>, ms = 20_000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await sleep(100)
  }
  throw new Error('condition not reached in time')
}

describe('the queue interface', () => {
  it('puts only a job ID, a class queue and a scheduling key in the queue row', async () => {
    const id = await send('bulk')
    const { rows } = await db.admin.query<{ name: string; data: unknown; group_id: string | null }>(
      `select name, data, group_id from pgboss.job where id = $1`,
      [id],
    )
    expect(rows[0]?.name).toBe('job-bulk')
    expect(rows[0]?.data).toEqual({ jobId: id })
    expect(rows[0]?.group_id).not.toBeNull()
    await queue.cancel('bulk', id)
  })

  it('runs a job, completes it when the handler resolves, and reports its state', async () => {
    const seen: string[] = []
    await queue.work('interactive', { processes: 1 }, async (job) => {
      seen.push(job.id)
    })
    const id = await send('interactive')
    await until(async () => (await queue.state('interactive', id)) === 'completed')
    expect(seen).toContain(id)
  })

  it('refuses a send whose ID is already in the queue, so the caller can roll back', async () => {
    const id = await send('bulk')
    await expect(send('bulk', randomUUID(), id)).rejects.toThrow(/did not accept/)
  })

  it('hands an error from its connections to onError', async () => {
    const url = new URL(db.urlFor('queue'))
    const tag = `onerror-${randomUUID()}`
    url.searchParams.set('application_name', tag)
    const errors: Error[] = []
    const watched = await openQueue(url.toString(), { onError: (e) => errors.push(e) })
    try {
      await watched.depth('bulk')
      await db.admin.query(
        `select pg_terminate_backend(pid) from pg_stat_activity where application_name = $1`,
        [tag],
      )
      await until(async () => errors.length > 0, 10_000)
      expect(errors[0]).toBeInstanceOf(Error)
    } finally {
      await watched.stop().catch(() => {})
    }
  })

  it('writes one JSON line to stderr by default', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      defaultOnError(new Error('lost'))
      expect(write).toHaveBeenCalledWith('{"event":"queue_error","error":"lost"}\n')
    } finally {
      write.mockRestore()
    }
  })

  it('counts waiting jobs for backpressure', async () => {
    const before = await queue.depth('bulk')
    await send('bulk')
    await send('bulk')
    expect(await queue.depth('bulk')).toBe(before + 2)
  })

  it('moves a job that keeps failing to the dead-letter list, and requeues it', async () => {
    let runs = 0
    let fail = true
    await queue.work('publishing', { processes: 1 }, async () => {
      runs += 1
      if (fail) throw new Error('boom')
    })
    const id = await send('publishing')
    await until(async () => (await queue.deadJobs('publishing')).includes(id), 120_000)
    expect(runs).toBeGreaterThanOrEqual(5)
    fail = false
    await queue.requeue('publishing', id)
    await until(async () => (await queue.state('publishing', id)) === 'completed', 60_000)
    expect(await queue.deadJobs('publishing')).not.toContain(id)
  }, 240_000)

  it('refuses a cap smaller than the number of worker processes', async () => {
    await expect(queue.work('bulk', { processes: 2 }, async () => {})).rejects.toThrow(
      /smaller than the number of processes/,
    )
  })
})
