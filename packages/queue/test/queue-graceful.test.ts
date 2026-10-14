import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { requireDatabase, sleep } from '@mkt/test-support'
import type { TestDatabase } from '@mkt/db/testing'
import { openQueue } from '../src/queue.ts'
import { createQueueTestDatabase } from '../src/testing.ts'

let db: TestDatabase
let app: pg.Pool

beforeAll(async () => {
  await requireDatabase()
  db = await createQueueTestDatabase()
  app = new pg.Pool({ connectionString: db.urlFor('app') })
})
afterAll(async () => {
  await app?.end()
  await db?.drop()
})

describe('stopping a worker queue', () => {
  it('a graceful stop lets a running handler finish before it returns', async () => {
    const worker = await openQueue(db.urlFor('queue'), { supervise: true })
    let started = false
    let finished = false
    await worker.work('interactive', { processes: 1 }, async () => {
      started = true
      await sleep(2000)
      finished = true
    })
    const client = await app.connect()
    const id = randomUUID()
    try {
      await client.query('begin')
      await worker.send(client, { jobId: id, jobClass: 'interactive', scheduleKey: randomUUID() })
      await client.query('commit')
    } finally {
      client.release()
    }
    for (let i = 0; i < 100 && !started; i += 1) await sleep(100)
    expect(started).toBe(true)
    await worker.stop({ graceful: true, timeoutSeconds: 20 })
    expect(finished).toBe(true)
    const { rows } = await db.admin.query('select state from pgboss.job where id = $1', [id])
    expect(rows[0].state).toBe('completed')
  }, 60_000)
})
