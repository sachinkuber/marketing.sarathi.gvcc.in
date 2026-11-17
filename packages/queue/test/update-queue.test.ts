import { PgBoss } from 'pg-boss'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { requireDatabase } from '@mkt/test-support'
import type { TestDatabase } from '@mkt/db/testing'
import { CLASS_SETTINGS, JOB_CLASSES } from '../src/classes.ts'
import { DEAD_LETTER_RETRY_LIMIT, QUEUE_SCHEMA, updateQueue } from '../src/install.ts'
import { createQueueTestDatabase } from '../src/testing.ts'

let db: TestDatabase
let boss: PgBoss

beforeAll(async () => {
  await requireDatabase()
  db = await createQueueTestDatabase()
  boss = new PgBoss({ connectionString: db.urlFor('migration'), schema: QUEUE_SCHEMA, supervise: false })
  boss.on('error', () => {})
  await boss.start()
})

afterAll(async () => {
  await boss?.stop({ graceful: false })
  await db?.drop()
})

// installQueue only creates queues that are missing, so a deployment whose queues already exist needs
// updateQueue to bring their settings to the ones in classes.ts.
describe('updateQueue', () => {
  it('brings the settings of queues that exist back to the class settings', async () => {
    for (const jobClass of JOB_CLASSES) {
      const s = CLASS_SETTINGS[jobClass]
      await boss.updateQueue(s.queue, { retryLimit: 9, deadLetter: null })
      await boss.updateQueue(s.deadLetter, { retryLimit: 0 })
    }

    await updateQueue(db.urlFor('migration'), { testScale: 0.1 })

    for (const jobClass of JOB_CLASSES) {
      const s = CLASS_SETTINGS[jobClass]
      const queue = await boss.getQueue(s.queue)
      const dead = await boss.getQueue(s.deadLetter)
      expect(queue?.retryLimit).toBe(s.retryLimit)
      expect(queue?.deadLetter).toBe(s.deadLetter)
      expect(queue?.notify).toBe(s.notify)
      expect(dead?.retryLimit).toBe(DEAD_LETTER_RETRY_LIMIT)
    }
  })

  it('refuses a database where the queues were never installed', async () => {
    const empty = await createQueueTestDatabase()
    try {
      const other = new PgBoss({ connectionString: empty.urlFor('migration'), schema: QUEUE_SCHEMA })
      other.on('error', () => {})
      await other.start()
      await other.deleteQueue(CLASS_SETTINGS.bulk.queue)
      await other.stop({ graceful: false })
      await expect(updateQueue(empty.urlFor('migration'))).rejects.toThrow(/job-bulk/)
    } finally {
      await empty.drop()
    }
  })
})
