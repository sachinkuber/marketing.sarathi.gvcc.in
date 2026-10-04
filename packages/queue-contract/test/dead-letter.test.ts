import { requireDatabase, sleep } from '@mkt/test-support'
import type { PgBoss } from 'pg-boss'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startQueue, uniqueName } from './support.ts'

describe('a job that keeps failing ends in the dead-letter queue', () => {
  let queue: PgBoss
  const dead = uniqueName('dead')
  const work = uniqueName('failing')

  beforeAll(async () => {
    await requireDatabase()
    queue = await startQueue()
    await queue.createQueue(dead)
    await queue.createQueue(work, { retryLimit: 1, retryDelay: 1, deadLetter: dead })
  })

  afterAll(async () => queue.stop({ graceful: false }))

  it('is attempted retryLimit + 1 times, then moved', async () => {
    let attempts = 0
    await queue.work(work, { pollingIntervalSeconds: 0.5 }, async () => {
      attempts += 1
      throw new Error('always fails')
    })
    await queue.send(work, { x: 1 })

    let moved: unknown[] = []
    for (let i = 0; i < 40 && moved.length === 0; i += 1) {
      await sleep(500)
      moved = await queue.fetch(dead)
    }

    expect(attempts).toBe(2)
    expect(moved).toHaveLength(1)
  })
})
