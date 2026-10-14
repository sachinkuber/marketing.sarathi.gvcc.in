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

    await queue.cancel('interactive', id)
    expect(await queue.state('interactive', id)).toBe('cancelled')
  }, 120_000)
})
